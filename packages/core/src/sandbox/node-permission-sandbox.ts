import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool, ToolResult } from "../types.ts";
import { toolError } from "../errors.ts";
import type { ExecuteOpts, InvokeToolHandler, Sandbox } from "./interface.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(__dirname, "runner.ts");

export type SandboxOpts = {
  workspace: string;
  maxDepth?: number;
  maxOutputBytes?: number;
};

export class NodePermissionSandbox implements Sandbox {
  private readonly workspace: string;
  private readonly maxDepth: number;
  private readonly maxOutputBytes: number;

  constructor(opts: SandboxOpts) {
    this.workspace = opts.workspace;
    this.maxDepth = opts.maxDepth ?? 8;
    this.maxOutputBytes = opts.maxOutputBytes ?? 1_048_576;
  }

  async execute(tool: Tool, args: unknown, _approvalToken: string, opts: ExecuteOpts = {}): Promise<ToolResult> {
    if ((opts.depth ?? 0) > this.maxDepth) {
      return toolError("depth_exceeded", `composite recursion depth exceeded ${this.maxDepth}`);
    }

    let toolPath = opts.toolPath;
    let cleanupDir: string | null = null;
    if (!toolPath) {
      cleanupDir = await mkdtemp(join(tmpdir(), "meta-agent-sb-"));
      toolPath = join(cleanupDir, `${tool.manifest.name}.ts`);
      await writeFile(toolPath, tool.code, "utf8");
    }

    try {
      return await this.run(tool, args, toolPath, opts.onInvokeTool, opts.depth ?? 0);
    } finally {
      if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
    }
  }

  private run(tool: Tool, args: unknown, toolPath: string, onInvoke: InvokeToolHandler | undefined, depth: number): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const perms = tool.manifest.permissions;
      const flags: string[] = [
        "--permission",
        "--experimental-transform-types",
        "--no-warnings",
        "--no-addons",
        `--max-old-space-size=${tool.manifest.limits.maxOldSpaceSizeMb}`,
      ];
      const allowRead = [this.workspace, dirname(RUNNER_PATH), dirname(toolPath), ...perms.fsRead];
      const allowWrite = [...perms.fsWrite];
      for (const p of allowRead) flags.push(`--allow-fs-read=${p}`);
      for (const p of allowWrite) flags.push(`--allow-fs-write=${p}`);
      if (perms.net !== "none") flags.push("--allow-net");

      const env: NodeJS.ProcessEnv = {};
      for (const name of perms.env) if (process.env[name] !== undefined) env[name] = process.env[name];
      if (perms.net === "allowlist") env.META_AGENT_NET_ALLOWLIST = perms.netAllowlist.join(",");
      env.PATH = process.env.PATH ?? "";

      const child = spawn(process.execPath, [...flags, RUNNER_PATH, toolPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });

      let stdoutBuf = "";
      let stderrBytes = 0;
      let resolved = false;
      const truncateAt = this.maxOutputBytes;

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        child.kill("SIGKILL");
        resolve(toolError("timeout", `exceeded timeout of ${tool.manifest.limits.timeoutMs}ms`));
      }, tool.manifest.limits.timeoutMs);

      const processLine = async (line: string): Promise<void> => {
        if (!line.trim()) return;
        let frame: { op: "invokeTool"; requestId: string; name: string; args: unknown } | { op: "result"; result: ToolResult };
        try { frame = JSON.parse(line); } catch { return; }
        if (frame.op === "invokeTool") {
          let result: ToolResult;
          try {
            result = onInvoke
              ? await onInvoke(frame.name, frame.args)
              : toolError("unknown_tool", "no invokeTool handler installed for composite");
          } catch (e) {
            result = toolError("runtime_error", (e as Error).message);
          }
          child.stdin.write(JSON.stringify({ op: "invokeToolResult", requestId: frame.requestId, result }) + "\n");
        } else if (frame.op === "result") {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          resolve(frame.result);
        }
      };

      child.stdout.on("data", (c: Buffer) => {
        stdoutBuf += c.toString();
        if (stdoutBuf.length > truncateAt) {
          if (!resolved) {
            resolved = true;
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
          void processLine(line);
          idx = stdoutBuf.indexOf("\n");
        }
      });

      child.stderr.on("data", (c: Buffer) => {
        stderrBytes += c.length;
        if (stderrBytes > truncateAt && !resolved) {
          resolved = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve(toolError("output_truncated", `stderr exceeded ${truncateAt} bytes`));
        }
      });

      child.on("error", (e) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(toolError("runtime_error", `spawn failed: ${e.message}`));
      });

      child.on("close", (code, signal) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (signal) resolve(toolError("runtime_error", `child killed by signal ${signal}`));
        else resolve(toolError("runtime_error", `child exited with code ${code ?? "null"} without emitting a result frame`));
      });

      child.stdin.write(JSON.stringify({ op: "args", args }) + "\n");
      void depth;
    });
  }
}
