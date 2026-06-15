export const SANDBOX_DEBUG_ENV = "META_AGENT_SANDBOX_DEBUG" as const;

const SANDBOX_LOG_PREFIX = "[meta-agent:sandbox]";

const MAX_DETAIL_CHARS = 400;

/** Env values that silence {@link sandboxDebug} even when the variable is set. */
const SANDBOX_DEBUG_SILENCED = {
  off: "0",
  false: "false",
} as const;

/**
 * Callback invoked by {@link sandboxDebug} and {@link sandboxLogError} (styled by CLI or plain stderr).
 */
export type SandboxDebugSink = (
  message: string,
  detail?: string,
  opts?: { error?: boolean },
) => void;

let sandboxDebugSink: SandboxDebugSink | undefined;

/**
 * Registers a custom writer for sandbox diagnostics (e.g. colored CLI output).
 *
 * @param sink - Replacement sink, or `undefined` to restore default stderr formatting.
 */
export function setSandboxDebugSink(sink: SandboxDebugSink | undefined): void {
  sandboxDebugSink = sink;
}

function truncateDetail(s: string): string {
  if (s.length <= MAX_DETAIL_CHARS) return s;
  return `${s.slice(0, MAX_DETAIL_CHARS)}…(${s.length} chars total)`;
}

function sandboxDebugSilenced(): boolean {
  const v = process.env[SANDBOX_DEBUG_ENV];
  if (v === undefined || v === "") return true;
  if (v === SANDBOX_DEBUG_SILENCED.off || v === SANDBOX_DEBUG_SILENCED.false) return true;
  return false;
}

/**
 * Reports whether {@link sandboxDebug} will emit (explicit opt-in via env).
 *
 * @returns `true` when sandbox debug logging is enabled.
 */
export function sandboxDebugEnabled(): boolean {
  return !sandboxDebugSilenced();
}

function writeDefault(message: string, detail?: string): void {
  const body = detail !== undefined ? `${message} — ${detail}` : message;
  process.stderr.write(`${SANDBOX_LOG_PREFIX} ${body}\n`);
}

/**
 * Writes a diagnostic line to this process's stderr (parent sandbox host or child runner).
 *
 * Emits only when `META_AGENT_SANDBOX_DEBUG` is set to a non-empty value other than `0` or `false`
 * (e.g. `1` or `verbose`). Child processes inherit the same variable from {@link NodePermissionSandbox}.
 *
 * @param message - Primary log message.
 * @param detail - Optional detail (truncated before forwarding to a custom sink).
 */
export function sandboxDebug(message: string, detail?: string): void {
  if (sandboxDebugSilenced()) return;

  const truncatedDetail = detail !== undefined ? truncateDetail(detail) : undefined;
  if (sandboxDebugSink) {
    sandboxDebugSink(message, truncatedDetail);
    return;
  }
  writeDefault(message, truncatedDetail);
}

/**
 * Always writes a sandbox failure line to stderr (not gated by {@link sandboxDebug} env).
 *
 * @param message - Primary error message.
 * @param err - Error or value serialized into the detail line.
 */
export function sandboxLogError(message: string, err: unknown): void {
  const detail = truncateDetail(err instanceof Error ? (err.stack ?? err.message) : String(err));
  if (sandboxDebugSink) {
    sandboxDebugSink(message, detail, { error: true });
    return;
  }
  writeDefault(message, detail);
}
