import { theme } from "./terminal-theme.ts";
import { renderTable, TABLE_META_ROW_COUNT, type TableColumn } from "./terminal-table.ts";

const SANDBOX_LOG_FIELD_GAP = "  ";
const JSON_OBJECT_PREFIX = "{";
const DETAIL_COLUMNS: TableColumn[] = [
  { header: "Field", width: 18 },
  { header: "Value", width: 44 },
];

export const SANDBOX_DETAIL_KIND = {
  table: "table",
  text: "text",
} as const;

/**
 * Parsed sandbox log detail: key-value table rows or plain fallback text.
 */
export type ParsedSandboxDetail =
  | { kind: typeof SANDBOX_DETAIL_KIND.table; rows: string[][] }
  | { kind: typeof SANDBOX_DETAIL_KIND.text; body: string };

/** Split `key=value` on the first `=` so values may contain `=`. */
function parseKvToken(token: string): [string, string] | null {
  const eq = token.indexOf("=");
  if (eq <= 0) return null;
  return [token.slice(0, eq), token.slice(eq + 1)];
}

/**
 * Parses sandbox diagnostic detail strings into tabular rows or plain text.
 *
 * @param detail - Raw detail suffix from a sandbox log line.
 * @returns Table rows for `key=value` tokens or JSON objects; otherwise plain text.
 */
export function parseSandboxDetail(detail: string): ParsedSandboxDetail {
  const trimmed = detail.trim();
  if (trimmed.startsWith(JSON_OBJECT_PREFIX)) {
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        const rows = Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
          k,
          typeof v === "string" ? v : JSON.stringify(v),
        ]);
        return { kind: SANDBOX_DETAIL_KIND.table, rows };
      }
    } catch {
      /* fall through */
    }
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: SANDBOX_DETAIL_KIND.text, body: trimmed };

  const rows: string[][] = [];
  for (const token of tokens) {
    const kv = parseKvToken(token);
    if (!kv) return { kind: SANDBOX_DETAIL_KIND.text, body: detail };
    rows.push(kv);
  }
  return { kind: SANDBOX_DETAIL_KIND.table, rows };
}

function colorizeIndentedTable(table: string): string {
  return table
    .split("\n")
    .map((line, i) =>
      theme.indent(i < TABLE_META_ROW_COUNT ? theme.meta(line) : theme.progressBody(line)),
    )
    .join("\n");
}

function formatDetailBody(detail: string): string {
  const parsed = parseSandboxDetail(detail);
  if (parsed.kind === SANDBOX_DETAIL_KIND.text) {
    return parsed.body
      .split("\n")
      .map((line) => theme.indent(theme.meta(line)))
      .join("\n");
  }
  return colorizeIndentedTable(renderTable(DETAIL_COLUMNS, parsed.rows));
}

/**
 * Writes one sandbox diagnostic line to stderr (SANDBOX badge + colored message).
 *
 * @param message - Primary log message.
 * @param detail - Optional trailing detail rendered as a table or plain text.
 * @param opts - When `error` is true, the message is styled as a failure.
 */
export function writeSandboxLogLine(
  message: string,
  detail?: string,
  opts?: { error?: boolean },
): void {
  const badge = theme.sandboxBadge();
  const msg = opts?.error ? theme.fail(message) : theme.progressLabel(message);
  process.stderr.write(`${badge}${SANDBOX_LOG_FIELD_GAP}${msg}\n`);
  if (detail !== undefined) {
    process.stderr.write(`${formatDetailBody(detail)}\n`);
  }
}
