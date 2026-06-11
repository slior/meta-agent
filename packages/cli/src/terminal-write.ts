import util from "node:util";
import { PROGRESS_LINE_STATUS, type ProgressLineParts } from "./trace-progress.ts";
import { formatShortTime, theme } from "./terminal-theme.ts";

const DEBUG_PAYLOAD_MAX = 4000;
const DEBUG_JSON_INDENT = 2;
const DEBUG_INSPECT_DEPTH = 6;
const DEBUG_INSPECT_MAX_ARRAY = 100;
const DEBUG_INSPECT_BREAK_LENGTH = 120;

/**
 * Result of serializing a debug payload for stderr display.
 */
export type FormatDebugPayloadResult = {
  /** Serialized payload text (possibly truncated). */
  payload: string;
  /** Whether {@link DEBUG_PAYLOAD_MAX} forced truncation. */
  truncated: boolean;
  /** Full serialized length when truncated. */
  totalChars?: number;
};

function styleProgressBody(parts: ProgressLineParts): string {
  switch (parts.status) {
    case PROGRESS_LINE_STATUS.ok:
      return theme.ok(parts.body);
    case PROGRESS_LINE_STATUS.fail:
      return theme.fail(parts.body);
    case PROGRESS_LINE_STATUS.pending:
      return theme.progressLabel(parts.body);
    default:
      return theme.progressBody(parts.body);
  }
}

/**
 * Writes one tracer progress line to stderr (dim meta + styled body).
 *
 * @param parts - Decomposed line from {@link formatTraceEventParts}.
 */
export function writeProgressLine(parts: ProgressLineParts): void {
  const meta = theme.meta(
    `${parts.time}  ${parts.label}${parts.detail ? `  ${parts.detail}` : ""}`,
  );
  const body = styleProgressBody(parts);
  process.stderr.write(`${meta}  ${body}\n`);
}

/**
 * JSON-stringifies debug data for display, falling back to `util.inspect` and truncating large payloads.
 *
 * @param data - Arbitrary debug event payload.
 * @returns Serialized text and truncation metadata.
 */
export function formatDebugPayload(data: unknown): FormatDebugPayloadResult {
  let payload: string;
  try {
    payload = JSON.stringify(data, null, DEBUG_JSON_INDENT);
  } catch {
    payload = util.inspect(data, {
      depth: DEBUG_INSPECT_DEPTH,
      maxArrayLength: DEBUG_INSPECT_MAX_ARRAY,
      breakLength: DEBUG_INSPECT_BREAK_LENGTH,
    });
  }
  if (payload.length > DEBUG_PAYLOAD_MAX) {
    return {
      payload: payload.slice(0, DEBUG_PAYLOAD_MAX),
      truncated: true,
      totalChars: payload.length,
    };
  }
  return { payload, truncated: false };
}

/**
 * Writes a structured DEBUG block to stderr (header + indented payload).
 *
 * @param kind - Debug event kind slug.
 * @param data - Event payload.
 * @param captureIsoTs - ISO timestamp for the header.
 */
export function writeDebugEvent(kind: string, data: unknown, captureIsoTs: string): void {
  const header = [
    theme.meta(formatShortTime(captureIsoTs)),
    theme.debugBadge(),
    theme.debugKind(kind),
  ].join("  ");

  const { payload, truncated, totalChars } = formatDebugPayload(data);
  const payloadLines = payload.split("\n").map((line) =>
    theme.indent(theme.debugPayload(line)),
  );
  const truncationLine = truncated
    ? theme.indent(theme.debugTruncation(`… (truncated, ${totalChars} chars total)`))
    : null;

  process.stderr.write(
    `${header}\n${payloadLines.join("\n")}${truncationLine ? `\n${truncationLine}` : ""}\n`,
  );
}
