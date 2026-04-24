import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePermissions } from "../permissions-normalize.ts";
import type { Tool, ToolResult } from "../types.ts";
import { PERMISSIONS_NET } from "../types.ts";
import { toolError } from "../errors.ts";
import type { ExecuteOpts, InvokeToolHandler, Sandbox } from "./interface.ts";
import { sandboxDebug, sandboxLogError, SANDBOX_DEBUG_ENV } from "./sandbox-debug.ts";
import {
  META_AGENT_NET_ALLOWLIST_ENV,
  SANDBOX_STDIO_OP,
  type SandboxChildStdinArgsFrame,
  type SandboxChildStdinInvokeToolResultFrame,
  type SandboxChildStdoutFrame,
} from "./stdio-protocol.ts";

/** Mutable completion flag shared by stdout line handler, timeout, and other child lifecycle hooks. */
type ChildRunResolutionState = { resolved: boolean };

/**
 * Parses one JSON line from the tool child stdout: `invokeTool` (reply on stdin) or `result` (resolve promise).
 */
async function handleChildStdoutJsonLine(
  line: string,
  state: ChildRunResolutionState,
  opts: {
    stdin: NodeJS.WritableStream;
    onInvoke: InvokeToolHandler | undefined;
    timer: NodeJS.Timeout;
    resolve: (r: ToolResult) => void;
  },
): Promise<void> {
  if (!line.trim()) return;
  let frame: SandboxChildStdoutFrame;
  try {
    frame = JSON.parse(line) as SandboxChildStdoutFrame;
  } catch {
    sandboxDebug("ignored non-JSON stdout line", line);
    return;
  }
  if (frame.op === SANDBOX_STDIO_OP.invokeTool) {
    let result: ToolResult;
    try {
      result = opts.onInvoke
        ? await opts.onInvoke(frame.name, frame.args)
        : toolError("unknown_tool", "no invokeTool handler installed for composite");
    } catch (e) {
      result = toolError("runtime_error", (e as Error).message);
    }
    const reply: SandboxChildStdinInvokeToolResultFrame = {
      op: SANDBOX_STDIO_OP.invokeToolResult,
      requestId: frame.requestId,
      result,
    };
    opts.stdin.write(JSON.stringify(reply) + "\n");
  } else if (frame.op === SANDBOX_STDIO_OP.result) {
    if (state.resolved) return;
    state.resolved = true;
    clearTimeout(opts.timer);
    opts.resolve(frame.result);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(__dirname, "runner.ts");

/** `spawn` stdio option for a stream: connect parent and child with a pipe (fd 0/1/2). */
const STREAM_PIPE = "pipe" as const;

/** Default {@link SandboxOpts.maxDepth} when omitted. */
const DEFAULT_MAX_DEPTH = 8;

/** Default {@link SandboxOpts.maxOutputBytes} when omitted (1 MiB). */
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** Prefix flags passed to every tool subprocess (Node permission model + noise limits). */
const NODE_TOOL_BASE_FLAGS = [
  "--permission",
  "--experimental-transform-types",
  "--no-warnings",
  "--no-addons",
] as const;

/**
 * Options for configuring the NodePermissionSandbox.
 *
 * @property workspace - The base directory (absolute path) in which sandboxed tools can operate.
 * @property maxDepth - (Optional) Maximum allowed recursion depth for tool execution, e.g. for composite tools. Defaults to 8 if not provided.
 * @property maxOutputBytes - (Optional) Maximum number of bytes allowed in a tool's output. Defaults to 1,048,576 (1 MiB) if not provided.
 */
export type SandboxOpts = {
  workspace: string;
  maxDepth?: number;
  maxOutputBytes?: number;
};

/**
 * NodePermissionSandbox provides a Node.js-based implementation of the `Sandbox` interface,
 * allowing controlled execution of tool code with specific file system, environment, and network permissions.
 * It instantiates temporary sandboxes with configurable execution and resource constraints, and
 * manages invocation of composite tool calls via frame-based subprocess communication.
 */
export class NodePermissionSandbox implements Sandbox {
  /**
   * Absolute path to the workspace directory allowed for read/write tool operations.
   */
  private readonly workspace: string;

  /**
   * Maximum call stack/recursion depth allowed for composite tool execution.
   */
  private readonly maxDepth: number;

  /**
   * Maximum number of output bytes (stdout/stderr) allowed from a tool execution.
   */
  private readonly maxOutputBytes: number;

  /**
   * Constructs a new NodePermissionSandbox.
   * @param opts Options for controlling workspace root, recursion depth, and output byte limits.
   */
  constructor(opts: SandboxOpts) {
    this.workspace = opts.workspace;
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  /**
   * Executes a tool in a controlled subprocess, enforcing resource, permission, and depth constraints.
   * Sets up a temporary file (if not already provided) for the tool's code, and
   * delegates invocation to the `run` helper, proxying requests for composite/invoked tools as necessary.
   *
   * @param tool The tool to execute.
   * @param args Input arguments for the tool.
   * @param _approvalToken Token for runtime approval control (unused in current implementation).
   * @param opts Optional execution options, including custom tool file path, invocation handler, and recursion depth.
   * @returns The result of the tool execution as a ToolResult.
   */
  async execute(
    tool: Tool,
    args: unknown,
    _approvalToken: string,
    opts: ExecuteOpts = {},
  ): Promise<ToolResult> {
    if ((opts.depth ?? 0) > this.maxDepth) {
      return toolError("depth_exceeded", `composite recursion depth exceeded ${this.maxDepth}`);
    }

    let toolPath = opts.toolPath;
    let cleanupDir: string | null = null;
    if (!toolPath) {
      // If no path is given, emit tool code to a fresh temp file.
      cleanupDir = await mkdtemp(join(tmpdir(), "meta-agent-sb-"));
      // Resolve symlinks to ensure Node subprocess permissions match canonical paths.
      const realDir = await realpath(cleanupDir);
      toolPath = join(realDir, `${tool.manifest.name}.ts`);
      await writeFile(toolPath, tool.code, "utf8");
    }

    try {
      return await this.run(tool, args, toolPath, opts.onInvokeTool, opts.depth ?? 0);
    } finally {
      if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
    }
  }

  private buildSpawnFlags(tool: Tool, toolPath: string, perms: ReturnType<typeof normalizePermissions>): string[] {
    const flags: string[] = [
      ...NODE_TOOL_BASE_FLAGS,
      `--max-old-space-size=${tool.manifest.limits.maxOldSpaceSizeMb}`,
    ];
    const allowRead = [this.workspace, dirname(RUNNER_PATH), dirname(toolPath), ...perms.fsRead];
    const allowWrite = [...perms.fsWrite];
    for (const p of allowRead) flags.push(`--allow-fs-read=${p}`);
    for (const p of allowWrite) flags.push(`--allow-fs-write=${p}`);
    if (perms.net !== PERMISSIONS_NET.none) flags.push("--allow-net");
    return flags;
  }

  private buildChildEnv(perms: ReturnType<typeof normalizePermissions>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of perms.env) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    if (perms.net === PERMISSIONS_NET.allowlist) {
      env[META_AGENT_NET_ALLOWLIST_ENV] = perms.netAllowlist.join(",");
    }
    env.PATH = process.env.PATH ?? "";
    if (process.env[SANDBOX_DEBUG_ENV] !== undefined) {
      env[SANDBOX_DEBUG_ENV] = process.env[SANDBOX_DEBUG_ENV];
    }
    return env;
  }

  /**
   * Spawns a Node.js subprocess to execute the specified tool file with tight OS-level resource constraints and
   * configurable permissions. Communicates with the child process over stdio using JSON frames,
   * handling composite/invoke-tool operations and early termination on resource exhaustion or timeouts.
   *
   * @param tool The tool to execute.
   * @param args Invocation arguments.
   * @param toolPath Absolute path to the tool's code file.
   * @param onInvoke Handler for delegated tool invocations (for composites), if any.
   * @param _depth Current recursion depth for composite tools (reserved for diagnostics / future use).
   * @returns Resolves to the final ToolResult from execution or from top-level error states.
   */
  private run(
    tool: Tool,
    args: unknown,
    toolPath: string,
    onInvoke: InvokeToolHandler | undefined,
    _depth: number,
  ): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const perms = normalizePermissions(tool.manifest.permissions);
      const flags = this.buildSpawnFlags(tool, toolPath, perms);
      const env = this.buildChildEnv(perms);

      // Launch the subprocess (runner loads toolPath, speaks JSON lines on stdio).
      const child = spawn(process.execPath, [...flags, RUNNER_PATH, toolPath], {
        stdio: [STREAM_PIPE, STREAM_PIPE, STREAM_PIPE],
        env,
      });

      let stdoutBuf = "";
      let stderrBytes = 0;
      const state: ChildRunResolutionState = { resolved: false };
      const truncateAt = this.maxOutputBytes;

      const timer = setTimeout(() => {
        if (state.resolved) return;
        state.resolved = true;
        child.kill("SIGKILL");
        resolve(toolError("timeout", `exceeded timeout of ${tool.manifest.limits.timeoutMs}ms`));
      }, tool.manifest.limits.timeoutMs);

      const stdoutLineOpts = {
        stdin: child.stdin!,
        onInvoke,
        timer,
        resolve,
      };

      /** Split stdout on newlines; enforce max bytes via truncateAt. */
      child.stdout.on("data", (c: Buffer) => {
        stdoutBuf += c.toString();
        if (stdoutBuf.length > truncateAt) {
          if (!state.resolved) {
            state.resolved = true;
            clearTimeout(timer);
            child.kill("SIGKILL");
            resolve(toolError("output_truncated", `stdout exceeded ${truncateAt} bytes`));
          }
          return;
        }
        let idx = stdoutBuf.indexOf("\n");
        while (idx >= 0) {
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          handleChildStdoutJsonLine(line, state, stdoutLineOpts).catch((err: unknown) => {
            sandboxLogError("handleChildStdoutJsonLine failed", err);
          });
          idx = stdoutBuf.indexOf("\n");
        }
      });

      /** Bound total stderr size so a noisy child cannot exhaust memory. */
      child.stderr.on("data", (c: Buffer) => {
        stderrBytes += c.length;
        if (stderrBytes > truncateAt && !state.resolved) {
          state.resolved = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve(toolError("output_truncated", `stderr exceeded ${truncateAt} bytes`));
        }
      });

      child.on("error", (e) => {
        if (state.resolved) return;
        state.resolved = true;
        clearTimeout(timer);
        resolve(toolError("runtime_error", `spawn failed: ${e.message}`));
      });

      child.on("close", (code, signal) => {
        if (state.resolved) return;
        state.resolved = true;
        clearTimeout(timer);
        if (signal) resolve(toolError("runtime_error", `child killed by signal ${signal}`));
        else {
          resolve(
            toolError(
              "runtime_error",
              `child exited with code ${code ?? "null"} without emitting a result frame`,
            ),
          );
        }
      });

      const argsFrame: SandboxChildStdinArgsFrame = { op: SANDBOX_STDIO_OP.args, args };
      child.stdin.write(JSON.stringify(argsFrame) + "\n");
    });
  }
}
