import pc from "picocolors";

const ISO_TIME_PATTERN = /T(\d{2}:\d{2}:\d{2})/;
const THEME_DEFAULT_INDENT_SPACES = 2;

/**
 * Extracts `HH:MM:SS` from an ISO-8601 timestamp for compact progress headers.
 *
 * @param isoTs - ISO timestamp string (UTC or offset).
 * @returns Time portion, or the original string when the pattern does not match.
 */
export function formatShortTime(isoTs: string): string {
  const m = isoTs.match(ISO_TIME_PATTERN);
  if (m?.[1]) return m[1];
  return isoTs;
}

/**
 * ANSI color helpers for CLI progress, approval, debug, and sandbox output.
 * Respects `NO_COLOR` / `FORCE_COLOR` via picocolors at import time.
 */
export const theme = {
  meta: (s: string) => pc.dim(s),
  progressLabel: (s: string) => pc.cyan(s),
  progressBody: (s: string) => s,
  ok: (s: string) => pc.green(s),
  okBold: (s: string) => pc.bold(pc.green(s)),
  fail: (s: string) => pc.red(s),
  debugBadge: () => pc.magenta("DEBUG"),
  sandboxBadge: () => pc.magenta("SANDBOX"),
  debugKind: (s: string) => pc.yellow(s),
  debugPayload: (s: string) => pc.dim(s),
  debugTruncation: (s: string) => pc.yellow(s),
  indent: (s: string, spaces = THEME_DEFAULT_INDENT_SPACES) => " ".repeat(spaces) + s,
};
