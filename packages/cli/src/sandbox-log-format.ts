import { theme } from "./terminal-theme.ts";

const SANDBOX_LOG_FIELD_GAP = "  ";
const SANDBOX_DETAIL_SEPARATOR = " — ";

/**
 * Writes one sandbox diagnostic line to stderr (SANDBOX badge + colored message).
 *
 * @param message - Primary log message.
 * @param detail - Optional trailing detail (dim, after em dash).
 * @param opts - When `error` is true, the message is styled as a failure.
 */
export function writeSandboxLogLine(
  message: string,
  detail?: string,
  opts?: { error?: boolean },
): void {
  const badge = theme.sandboxBadge();
  const msg = opts?.error ? theme.fail(message) : theme.progressLabel(message);
  const body = detail !== undefined
    ? `${msg}${theme.meta(`${SANDBOX_DETAIL_SEPARATOR}${detail}`)}`
    : msg;
  process.stderr.write(`${badge}${SANDBOX_LOG_FIELD_GAP}${body}\n`);
}
