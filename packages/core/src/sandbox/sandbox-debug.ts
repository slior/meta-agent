export const SANDBOX_DEBUG_ENV = "META_AGENT_SANDBOX_DEBUG" as const;

const PREFIX = "[meta-agent:sandbox]";

const MAX_DETAIL_CHARS = 400;

function truncateDetail(s: string): string {
  if (s.length <= MAX_DETAIL_CHARS) return s;
  return `${s.slice(0, MAX_DETAIL_CHARS)}…(${s.length} chars total)`;
}

function sandboxDebugSilenced(): boolean {
  const v = process.env[SANDBOX_DEBUG_ENV];
  if (v === undefined || v === "") return true;
  if (v === "0" || v === "false") return true;
  return false;
}

/** True when {@link sandboxDebug} will emit (explicit opt-in via env). */
export function sandboxDebugEnabled(): boolean {
  return !sandboxDebugSilenced();
}

/**
 * Write a diagnostic line to **this** process's stderr (parent sandbox host or child runner).
 *
 * Emits only when `META_AGENT_SANDBOX_DEBUG` is set to a non-empty value other than `0` or `false`
 * (e.g. `1` or `verbose`). Child processes inherit the same variable from {@link NodePermissionSandbox}.
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
