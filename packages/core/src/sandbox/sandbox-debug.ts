export const SANDBOX_DEBUG_ENV = "META_AGENT_SANDBOX_DEBUG" as const;

const PREFIX = "[meta-agent:sandbox]";

const MAX_DETAIL_CHARS = 400;

function truncateDetail(s: string): string {
  if (s.length <= MAX_DETAIL_CHARS) return s;
  return `${s.slice(0, MAX_DETAIL_CHARS)}…(${s.length} chars total)`;
}

function sandboxDebugSilenced(): boolean {
  const v = process.env[SANDBOX_DEBUG_ENV];
  return v === "0" || v === "false";
}

/**
 * Write a diagnostic line to **this** process's stderr (parent sandbox host or child runner).
 *
 * Emits unless `META_AGENT_SANDBOX_DEBUG` is `0` or `false`. Further levels / verbosity can be handled here later.
 */
export function sandboxDebug(message: string, detail?: string): void {
  if (sandboxDebugSilenced()) return;

  const body = detail !== undefined ? `${message} — ${truncateDetail(detail)}` : message;
  process.stderr.write(`${PREFIX} ${body}\n`);
}

/** Always write to stderr; use for failures where {@link sandboxDebug} may be silenced. */
export function sandboxLogError(message: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`${PREFIX} ${message} — ${truncateDetail(detail)}\n`);
}
