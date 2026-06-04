export const REGISTRY_DEBUG_ENV = "META_AGENT_REGISTRY_DEBUG" as const;

const PREFIX = "[meta-agent:registry]";

const MAX_DETAIL_CHARS = 400;

function truncateDetail(s: string): string {
  if (s.length <= MAX_DETAIL_CHARS) return s;
  return `${s.slice(0, MAX_DETAIL_CHARS)}…(${s.length} chars total)`;
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

/**
 * Determines whether registry debug logging is silenced based on the environment variable.
 * Debug logging is silenced if the environment variable {@link REGISTRY_DEBUG_ENV} is unset,
 * empty, or set to a falsy value ("0" or "false", case-sensitive).
 *
 * @returns {boolean} True if debug logging should be silenced; false otherwise.
 */
function registryDebugSilenced(): boolean {
  const v = process.env[REGISTRY_DEBUG_ENV];
  if (v === undefined || v === "") return true;
  if (v === "0" || v === "false") return true;
  return false;
}

/**
 * Returns whether registry debug logging is enabled, according to the
 * {@link REGISTRY_DEBUG_ENV} environment variable.
 * 
 * Debug logging is enabled if {@link REGISTRY_DEBUG_ENV} is set to a truthy value
 * (not unset, empty, "0", or "false" -- case-sensitive).
 *
 * @returns {boolean} True if registry debug logging should be emitted, false otherwise.
 */
export function registryDebugEnabled(): boolean {
  return !registryDebugSilenced();
}

/**
 * Logs a debug message to stderr for registry operations if debug logging is enabled.
 * 
 * The message is prefixed with a standard tag, and if an error is provided, its details 
 * (truncated to a reasonable length) are included after the message. Debug logs are only
 * emitted when the registry debug environment variable ({@link REGISTRY_DEBUG_ENV}) is set
 * to a truthy value.
 *
 * @param message - The debug message to log.
 * @param err - Optional additional error or details to include in the log entry.
 */
export function registryLogDebug(message: string, err?: unknown): void {
  if (registryDebugSilenced()) return;
  const body = err !== undefined ? `${message} — ${truncateDetail(formatErr(err))}` : message;
  process.stderr.write(`${PREFIX} ${body}\n`);
}

/** Registry-wide rehydrate failures (e.g. cannot read tools directory). */
export function registryLogWarn(message: string, err?: unknown): void {
  const body = err !== undefined ? `${message} — ${truncateDetail(formatErr(err))}` : message;
  process.stderr.write(`${PREFIX} warn: ${body}\n`);
}

/**
 * Checks if the given error object is a "file or directory not found" (ENOENT) error.
 * 
 * @param err - The error object to check.
 * @returns True if the error is an ENOENT error, false otherwise.
 */
export function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
