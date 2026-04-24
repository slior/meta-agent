/**
 * Sandbox **child** entry: Node loads a generated tool module, reads JSON lines on stdin from the parent,
 * and writes JSON lines on stdout (`SandboxChildStdoutFrame` / `SandboxChildStdinFrame` in `stdio-protocol.ts`).
 *
 * This file is executed as a script (`node …/runner.ts <toolPath>`); it does not export a public API.
 *
 * @module sandbox/runner
 */
import { pathToFileURL } from "node:url";
import type { ToolResult } from "../types.ts";
import { runnerToolError } from "./runner-tool-error.ts";
import { sandboxDebug, sandboxLogError } from "./sandbox-debug.ts";
import {
  META_AGENT_NET_ALLOWLIST_ENV,
  SANDBOX_STDIO_OP,
  type SandboxChildStdinFrame,
  type SandboxChildStdoutFrame,
} from "./stdio-protocol.ts";

/** `process.argv` index of the absolute path to the tool module (passed by the parent `NodePermissionSandbox`). */
const TOOL_PATH_ARG_INDEX = 2;

/** Single JSON object written as one stdout line (newline-terminated). */
const JSON_LINE_SUFFIX = "\n";

/**
 * Shape of the tool module’s default export the runner expects: an async or sync `run(input)` function.
 */
type RunFn = (input: unknown) => Promise<unknown> | unknown;

/**
 * Pending `invokeTool` calls keyed by `requestId`; the parent completes each with an `invokeToolResult` stdin line.
 */
const pendingInvokes = new Map<string, (r: ToolResult) => void>();

/**
 * Resolves the promise that waits for the first `args` stdin frame. Assigned in {@link main} before attaching the stdin listener.
 */
let argsResolver: ((a: unknown) => void) | null = null;

/**
 * Writes one JSON line to stdout for the parent (`NodePermissionSandbox`) to parse.
 *
 * @param frame - A valid child→parent stdio frame.
 */
function writeStdoutFrame(frame: SandboxChildStdoutFrame): void {
  process.stdout.write(JSON.stringify(frame) + JSON_LINE_SUFFIX);
}

/**
 * Builds a terminal `result` frame wrapping a {@link ToolResult}.
 *
 * @param result - Success or failure payload from the tool or runner bootstrap.
 */
function childStdoutResultFrame(result: ToolResult): SandboxChildStdoutFrame {
  return { op: SANDBOX_STDIO_OP.result, result };
}

/**
 * Installs `globalThis.invokeTool` so composite tool code can request nested runs; each call emits
 * `invokeTool` on stdout and awaits the matching `invokeToolResult` line from stdin.
 */
function installInvokeToolGlobal(): void {
  (globalThis as unknown as { invokeTool: (name: string, args: unknown) => Promise<unknown> }).invokeTool =
    async function invokeTool(name: string, args: unknown) {
      const requestId = Math.random().toString(36).slice(2);
      const frame: SandboxChildStdoutFrame = { op: SANDBOX_STDIO_OP.invokeTool, requestId, name, args };
      writeStdoutFrame(frame);
      return new Promise((resolve) => pendingInvokes.set(requestId, resolve));
    };
}

installInvokeToolGlobal();

/**
 * When `META_AGENT_NET_ALLOWLIST` is non-empty, replaces `globalThis.fetch` with a host allowlist guard.
 *
 * @param netAllowlist - Hostnames permitted for `fetch` (from env, already split).
 */
function installNetShim(netAllowlist: string[]): void {
  if (netAllowlist.length === 0) return;
  const allow = new Set(netAllowlist.map((h) => h.toLowerCase()));
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: unknown, init?: unknown) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    const host = new URL(url).hostname.toLowerCase();
    if (!allow.has(host)) {
      throw new Error(`net-shim: host '${host}' not in allowlist`);
    }
    return origFetch(
      input as Parameters<typeof origFetch>[0],
      init as Parameters<typeof origFetch>[1],
    );
  };
}

/**
 * Parses comma-separated hostnames from {@link META_AGENT_NET_ALLOWLIST_ENV}.
 */
function readNetAllowlistFromEnv(): string[] {
  const raw = process.env[META_AGENT_NET_ALLOWLIST_ENV] ?? "";
  return raw ? raw.split(",").filter(Boolean) : [];
}

/**
 * Reads buffered stdin text, emits complete lines to the line handler, and returns the carry-over buffer.
 *
 * @param prior - Bytes not yet ending in a newline.
 * @param chunk - New data from `stdin` `"data"`.
 * @param onLine - Invoked for each non-empty trimmed line (JSON protocol).
 */
function extendStdinBufferAndDrainLines(prior: string, chunk: string, onLine: (line: string) => void): string {
  let buf = prior + chunk;
  let idx = buf.indexOf("\n");
  while (idx >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim()) onLine(line);
    idx = buf.indexOf("\n");
  }
  return buf;
}

/**
 * Parses one parent→child stdin JSON line: initial `args`, or `invokeToolResult` for a pending composite call.
 *
 * @param line - A single newline-delimited JSON object.
 */
function handleParentStdinJsonLine(line: string): void {
  try {
    const frame = JSON.parse(line) as SandboxChildStdinFrame;
    if (frame.op === SANDBOX_STDIO_OP.args) {
      argsResolver?.(frame.args);
    } else if (frame.op === SANDBOX_STDIO_OP.invokeToolResult) {
      const cb = pendingInvokes.get(frame.requestId);
      pendingInvokes.delete(frame.requestId);
      cb?.(frame.result);
    }
  } catch {
    sandboxDebug("ignored malformed stdin JSON line", line);
  }
}

/**
 * Imports the tool file, validates `run`, and returns the callable or `null` after emitting a `result` error frame.
 *
 * @param toolPath - Filesystem path to the tool module (from argv).
 */
async function loadToolModuleOrEmitError(toolPath: string): Promise<{ run: RunFn } | null> {
  try {
    const mod = (await import(pathToFileURL(toolPath).href)) as { run: RunFn };
    if (typeof mod.run !== "function") throw new Error("tool does not export a `run` function");
    return mod;
  } catch (e) {
    const err = e as Error;
    writeStdoutFrame(
      childStdoutResultFrame(runnerToolError("runtime_error", `import failed: ${err.message}`)),
    );
    return null;
  }
}

/**
 * Runs `mod.run(args)` and writes a success or runtime `result` frame to stdout.
 *
 * @param mod - Loaded tool module.
 * @param args - Payload from the parent’s first `args` frame.
 */
async function runToolAndEmitOutcome(mod: { run: RunFn }, args: unknown): Promise<void> {
  try {
    const value = await mod.run(args);
    writeStdoutFrame(childStdoutResultFrame({ ok: true, value }));
  } catch (e) {
    const err = e as Error;
    writeStdoutFrame(
      childStdoutResultFrame(
        runnerToolError("runtime_error", err.message, { stack: err.stack }),
      ),
    );
  }
}

/**
 * Script entry: argv tool path → dynamic import → stdin `args` → `run` → stdout `result` → `process.exit(0)`.
 * Emits structured errors on stdout instead of throwing when bootstrap fails.
 */
async function main(): Promise<void> {
  const toolPath = process.argv[TOOL_PATH_ARG_INDEX];
  const netAllowlist = readNetAllowlistFromEnv();

  if (!toolPath) {
    writeStdoutFrame(childStdoutResultFrame(runnerToolError("runtime_error", "runner: missing tool path")));
    process.exit(0);
  }

  installNetShim(netAllowlist);

  const mod = await loadToolModuleOrEmitError(toolPath);
  if (!mod) {
    process.exit(0);
  }

  const argsPromise = new Promise<unknown>((resolve) => {
    argsResolver = resolve;
  });

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer = extendStdinBufferAndDrainLines(buffer, chunk, handleParentStdinJsonLine);
  });

  const args = await argsPromise;
  await runToolAndEmitOutcome(mod, args);
  process.exit(0);
}

void main().catch((err: unknown) => {
  sandboxLogError("runner main failed", err);
  process.exit(1);
});
