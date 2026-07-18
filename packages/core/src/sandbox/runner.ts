/**
 * Sandbox **child** entry: Node loads a generated tool module, reads JSON lines on stdin from the parent,
 * and writes JSON lines on stdout (`SandboxChildStdoutFrame` / `SandboxChildStdinFrame` in `stdio-protocol.ts`).
 *
 * This file is executed as a script (`node …/runner.ts <toolPath>`); it does not export a public API.
 *
 * @module sandbox/runner
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolResult } from "../types.ts";
import {
  RUNNER_TOOL_ERROR_KIND,
  runnerToolError,
  type RunnerToolErrorKind,
} from "./runner-tool-error.ts";
import { sandboxDebug, sandboxDebugEnabled, sandboxLogError } from "./sandbox-debug.ts";
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

/** Max chars of JSON-stringified args included in child debug logs. */
const ARGS_DEBUG_MAX = 500;

/** Max hostnames listed in the net-shim install debug sample. */
const NET_ALLOWLIST_DEBUG_SAMPLE_MAX = 8;

/** Prefix for all net-shim error messages surfaced to the agent. */
const NET_SHIM_ERROR_PREFIX = "net-shim:";

/** Host placeholder when `fetch` input cannot be parsed into a URL. */
const NET_SHIM_UNRESOLVABLE_HOST = "<unresolvable fetch input>";

/** Forced `fetch` redirect mode so 3xx responses cannot auto-follow unchecked hosts. */
const FETCH_REDIRECT_MANUAL = "manual" as const;

/**
 * Property stamped on thrown Errors so {@link runToolAndEmitOutcome} can map them to
 * {@link RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED} instead of a generic runtime failure.
 */
const TOOL_ERROR_KIND_PROP = "toolErrorKind" as const;

/**
 * Global constructors neutralized in allowlist mode because they bypass the `fetch` host shim.
 * Runtime values are the `globalThis` property names.
 */
const NET_SHIM_DISABLED_API = {
  WEBSOCKET: "WebSocket",
  EVENT_SOURCE: "EventSource",
} as const;

/** API names disabled by {@link disableUnguardedNetworkGlobals}. */
type NetShimDisabledApi = (typeof NET_SHIM_DISABLED_API)[keyof typeof NET_SHIM_DISABLED_API];

/** Thrown Error carrying a runner error-kind discriminator for stdout mapping. */
type RunnerKindedError = Error & { [TOOL_ERROR_KIND_PROP]: RunnerToolErrorKind };

function exitRunner(code: number, reason: string): never {
  sandboxDebug("child runner process.exit", `${reason} code=${code}`);
  process.exit(code);
}

function summarizeArgsForDebug(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length <= ARGS_DEBUG_MAX ? s : `${s.slice(0, ARGS_DEBUG_MAX)}…(${s.length} chars)`;
  } catch {
    return "[unserializable args]";
  }
}

/**
 * Shape of the tool module’s default export the runner expects: an async or sync `run(input)` function.
 */
type RunFn = (input: unknown) => Promise<unknown> | unknown;

/**
 * Pending `invokeTool` calls keyed by `requestId`; the parent completes each with an `invokeToolResult` stdin line.
 */
const pendingInvokes = new Map<string, (r: ToolResult) => void>();

/** Pending `llm` calls keyed by `requestId`; the parent completes each with an `llmResult` stdin line. */
const pendingLlm = new Map<string, (r: ToolResult) => void>();

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
 * Installs `globalThis.llm` so a capability-bearing tool can request a host LLM call;
 * each call emits `llm` on stdout and awaits the matching `llmResult` line. Resolves to
 * the produced value, or throws on a failed `ToolResult`.
 */
function installLlmGlobal(): void {
  (globalThis as unknown as { llm: (req: unknown) => Promise<unknown> }).llm =
    async function llm(req: unknown) {
      const requestId = Math.random().toString(36).slice(2);
      writeStdoutFrame({ op: SANDBOX_STDIO_OP.llm, requestId, req } as SandboxChildStdoutFrame);
      const result = await new Promise<ToolResult>((resolve) => pendingLlm.set(requestId, resolve));
      if (!result.ok) {
        const kind =
          result.error.kind === RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED
            ? RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED
            : RUNNER_TOOL_ERROR_KIND.RUNTIME_ERROR;
        throw attachRunnerErrorKind(new Error(result.error.message), kind);
      }
      return result.value;
    };
}

installLlmGlobal();

/** Config derived from {@link META_AGENT_NET_ALLOWLIST_ENV}: whether allowlist mode is active and its hosts. */
type NetShimConfig = { active: boolean; hosts: string[] };

/**
 * Stamps {@link TOOL_ERROR_KIND_PROP} onto an Error so {@link runToolAndEmitOutcome} can map the kind.
 *
 * @param err - Error to annotate.
 * @param kind - Child result error kind to emit on stdout.
 * @returns The same error instance, typed as {@link RunnerKindedError}.
 */
function attachRunnerErrorKind(err: Error, kind: RunnerToolErrorKind): RunnerKindedError {
  const kinded = err as RunnerKindedError;
  kinded[TOOL_ERROR_KIND_PROP] = kind;
  return kinded;
}

/**
 * Reads {@link META_AGENT_NET_ALLOWLIST_ENV}. The var is *defined* (possibly empty) whenever the parent
 * granted `net: "allowlist"`, and *undefined* when the tool has no network permission. An empty-but-defined
 * value means "allowlist mode active, zero hosts" — the shim then blocks every request (fail closed).
 */
function readNetShimConfigFromEnv(): NetShimConfig {
  const raw = process.env[META_AGENT_NET_ALLOWLIST_ENV];
  if (raw === undefined) return { active: false, hosts: [] };
  return { active: true, hosts: raw ? raw.split(",").filter(Boolean) : [] };
}

/** Builds a blocked-host error that the runner maps to a permission-denied result. */
function netShimBlockedError(host: string): RunnerKindedError {
  return attachRunnerErrorKind(
    new Error(`${NET_SHIM_ERROR_PREFIX} host '${host}' not in allowlist`),
    RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED,
  );
}

/** Builds a fetch-only error that the runner maps to a permission-denied result. */
function netShimFetchOnlyError(api: NetShimDisabledApi): RunnerKindedError {
  return attachRunnerErrorKind(
    new Error(
      `${NET_SHIM_ERROR_PREFIX} ${api} is disabled; only fetch() is allowed for network access under the allowlist shim`,
    ),
    RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED,
  );
}

/** Disables globally available network APIs that would bypass the fetch host allowlist. */
function disableUnguardedNetworkGlobals(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const api of Object.values(NET_SHIM_DISABLED_API)) {
    if (globals[api] === undefined) continue;
    // Preserve a named function for clearer stack traces when tools call the blocked API.
    globals[api] = {
      [api]: function (): never {
        throw netShimFetchOnlyError(api);
      },
    }[api];
  }
}

/**
 * Extracts the lowercased hostname from a `fetch` first argument (`string`, `URL`, or `Request`).
 * Throws a blocked-host error for unsupported/unparseable inputs so the shim fails closed.
 */
function extractFetchHost(input: unknown): string {
  if (typeof input === "string") return new URL(input).hostname.toLowerCase();
  if (input instanceof URL) return input.hostname.toLowerCase();
  const asReq = input as { url?: unknown };
  if (asReq && typeof asReq.url === "string") return new URL(asReq.url).hostname.toLowerCase();
  throw netShimBlockedError(NET_SHIM_UNRESOLVABLE_HOST);
}

/**
 * Installs a host-allowlist guard over `globalThis.fetch` whenever allowlist mode is active.
 * Blocks hosts outside the allowlist, refuses unparseable inputs, and forces `redirect: "manual"` so a
 * response cannot auto-follow a 3xx to an unchecked host. A tool must re-`fetch` a redirect target, which
 * is re-validated. When `cfg.active` is false the real `fetch` is left in place (no net permission granted).
 *
 * @param cfg - Allowlist activation flag and hostnames (from env).
 */
function installNetShim(cfg: NetShimConfig): void {
  if (!cfg.active) {
    sandboxDebug("child runner net shim", "skipped (net not in allowlist mode)");
    return;
  }
  const allow = new Set(cfg.hosts.map((h) => h.toLowerCase()));
  const sample = cfg.hosts.slice(0, NET_ALLOWLIST_DEBUG_SAMPLE_MAX).join(",");
  const sampleSuffix = cfg.hosts.length > NET_ALLOWLIST_DEBUG_SAMPLE_MAX ? "…" : "";
  sandboxDebug(
    "child runner net shim",
    `installed hosts=${cfg.hosts.length} sample=${sample}${sampleSuffix}`,
  );
  disableUnguardedNetworkGlobals();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: unknown, init?: unknown) => {
    const host = extractFetchHost(input);
    if (!allow.has(host)) throw netShimBlockedError(host);
    const merged = {
      ...(init as Record<string, unknown> | undefined),
      redirect: FETCH_REDIRECT_MANUAL,
    };
    return origFetch(
      input as Parameters<typeof origFetch>[0],
      merged as Parameters<typeof origFetch>[1],
    );
  };
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
    } else if (frame.op === SANDBOX_STDIO_OP.llmResult) {
      const cb = pendingLlm.get(frame.requestId);
      pendingLlm.delete(frame.requestId);
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
  sandboxDebug("child runner import tool module", `href=${pathToFileURL(toolPath).href}`);
  try {
    const mod = (await import(pathToFileURL(toolPath).href)) as { run: RunFn };
    if (typeof mod.run !== "function") throw new Error("tool does not export a `run` function");
    sandboxDebug("child runner import ok", basename(toolPath));
    return mod;
  } catch (e) {
    const err = e as Error;
    sandboxDebug("child runner import failed", err.message);
    writeStdoutFrame(
      childStdoutResultFrame(
        runnerToolError(RUNNER_TOOL_ERROR_KIND.RUNTIME_ERROR, `import failed: ${err.message}`),
      ),
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
  sandboxDebug("child runner invoking run()", summarizeArgsForDebug(args));
  try {
    const value = await mod.run(args);
    sandboxDebug("child runner run() returned", "writing success result frame");
    writeStdoutFrame(childStdoutResultFrame({ ok: true, value }));
  } catch (e) {
    const err = e as Error & { [TOOL_ERROR_KIND_PROP]?: RunnerToolErrorKind };
    sandboxDebug("child runner run() threw", err.message);
    const kind =
      err[TOOL_ERROR_KIND_PROP] === RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED
        ? RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED
        : RUNNER_TOOL_ERROR_KIND.RUNTIME_ERROR;
    writeStdoutFrame(
      childStdoutResultFrame(runnerToolError(kind, err.message, { stack: err.stack })),
    );
  }
}

/**
 * Script entry: argv tool path → dynamic import → stdin `args` → `run` → stdout `result` → `process.exit(0)`.
 * Emits structured errors on stdout instead of throwing when bootstrap fails.
 */
async function main(): Promise<void> {
  if (sandboxDebugEnabled()) {
    process.once("exit", (code) => {
      sandboxDebug("child runner exit event", `code=${String(code)}`);
    });
  }

  const toolPath = process.argv[TOOL_PATH_ARG_INDEX];
  const netShimConfig = readNetShimConfigFromEnv();

  sandboxDebug(
    "child runner bootstrap",
    `pid=${process.pid} node=${process.version} toolPathArg=${toolPath ?? "(missing)"} netActive=${String(netShimConfig.active)} netAllowlistEntries=${String(netShimConfig.hosts.length)}`,
  );

  if (!toolPath) {
    writeStdoutFrame(
      childStdoutResultFrame(runnerToolError(RUNNER_TOOL_ERROR_KIND.RUNTIME_ERROR, "runner: missing tool path")),
    );
    exitRunner(0, "missing tool path after error frame");
  }

  installNetShim(netShimConfig);

  const mod = await loadToolModuleOrEmitError(toolPath);
  if (!mod) {
    exitRunner(0, "import failed after error frame");
  }

  const argsPromise = new Promise<unknown>((resolve) => {
    argsResolver = resolve;
  });

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer = extendStdinBufferAndDrainLines(buffer, chunk, handleParentStdinJsonLine);
  });

  sandboxDebug("child runner waiting for stdin args frame", "stdin listener attached");
  const args = await argsPromise;
  sandboxDebug("child runner received args frame", summarizeArgsForDebug(args));
  await runToolAndEmitOutcome(mod, args);
  sandboxDebug("child runner finished", "success path");
  exitRunner(0, "normal completion");
}

void main().catch((err: unknown) => {
  sandboxLogError("runner main failed", err);
  process.exit(1);
});
