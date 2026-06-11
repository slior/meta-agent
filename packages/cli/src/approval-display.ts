import type { Permissions } from "@meta-agent/core";
import { PERMISSIONS_NET } from "@meta-agent/core";
import { theme } from "./terminal-theme.ts";
import {
  renderTable,
  TABLE_FIRST_DATA_ROW_INDEX,
  TABLE_META_ROW_COUNT,
  truncateCell,
  type TableColumn,
} from "./terminal-table.ts";

const COL_GAP = "  ";

const ARGS_COLUMNS: TableColumn[] = [
  { header: "Key", width: 14 },
  { header: "Value", width: 52 },
];
const PERM_COLUMNS: TableColumn[] = [
  { header: "Scope", width: 16 },
  { header: "Access", width: 50 },
];

const VALUE_COL_WIDTH = 52;
const MULTILINE_PREVIEW_LINES = 3;
const MULTILINE_CHAR_THRESHOLD = 80;
const NON_OBJECT_ARG_KEY = "value";
const PATH_SCOPE_ALL_GLOB = "*";

type ArgEntry = { key: string; cell: string; extraLines: string[] };
type FormattedArgValue = Pick<ArgEntry, "cell" | "extraLines">;

function valueColumnIndent(columns: ReadonlyArray<TableColumn>): string {
  return " ".repeat(columns[0]!.width + COL_GAP.length);
}

function formatPathScope(globs: string[]): string {
  if (globs.length === 0) return "none";
  if (globs.includes(PATH_SCOPE_ALL_GLOB)) return "all paths (*)";
  return globs.join(", ");
}

function formatNetwork(perms: Permissions): string {
  if (perms.net === PERMISSIONS_NET.none) return "blocked";
  if (perms.netAllowlist.length === 0) return "allowlist (no hosts)";
  return `allowlist (${perms.netAllowlist.join(", ")})`;
}

function formatEnvScope(names: string[]): string {
  if (names.length === 0) return "none";
  return names.join(", ");
}

function isMultiline(text: string): boolean {
  return text.includes("\n") || text.length > MULTILINE_CHAR_THRESHOLD;
}

function formatMultilinePreview(summaryLabel: string, text: string): FormattedArgValue {
  const valueIndent = valueColumnIndent(ARGS_COLUMNS);
  const preview = text.split("\n").slice(0, MULTILINE_PREVIEW_LINES);
  const extraLines = preview.map((line) =>
    valueIndent + theme.meta(truncateCell(line, VALUE_COL_WIDTH)),
  );
  return { cell: summaryLabel, extraLines };
}

function formatArgValue(value: unknown): FormattedArgValue {
  if (value === null || value === undefined) {
    return { cell: String(value), extraLines: [] };
  }
  if (typeof value === "string") {
    if (isMultiline(value)) {
      return formatMultilinePreview(`(multiline, ${value.length} chars)`, value);
    }
    return { cell: truncateCell(value, VALUE_COL_WIDTH), extraLines: [] };
  }
  if (typeof value === "object") {
    const json = JSON.stringify(value, null, 2);
    if (isMultiline(json)) {
      return formatMultilinePreview(`(object, ${json.length} chars)`, json);
    }
    return { cell: truncateCell(json, VALUE_COL_WIDTH), extraLines: [] };
  }
  return { cell: truncateCell(String(value), VALUE_COL_WIDTH), extraLines: [] };
}

function argsToEntries(args: unknown): ArgEntry[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return [
      { key: NON_OBJECT_ARG_KEY, cell: truncateCell(String(args), VALUE_COL_WIDTH), extraLines: [] },
    ];
  }
  return Object.entries(args as Record<string, unknown>).map(([key, value]) => {
    const formatted = formatArgValue(value);
    return { key, cell: formatted.cell, extraLines: formatted.extraLines };
  });
}

function firstDataRow(table: string): string {
  return table.split("\n")[TABLE_FIRST_DATA_ROW_INDEX]!;
}

function colorizeTable(table: string): string {
  return table
    .split("\n")
    .map((line, i) => (i < TABLE_META_ROW_COUNT ? theme.meta(line) : theme.progressBody(line)))
    .join("\n");
}

function renderArgsTableBody(entries: ArgEntry[]): string {
  const headerLines = renderTable(ARGS_COLUMNS, []).split("\n");
  const bodyLines: string[] = [];
  for (const entry of entries) {
    bodyLines.push(firstDataRow(renderTable(ARGS_COLUMNS, [[entry.key, entry.cell]])));
    bodyLines.push(...entry.extraLines);
  }
  return colorizeTable([...headerLines, ...bodyLines].join("\n"));
}

/**
 * Formats tool invocation arguments as a labeled key-value table for approval prompts.
 *
 * @param args - Tool arguments object, or a scalar when args are not structured.
 * @returns ANSI-styled multi-line string with an "Arguments" header and table body.
 */
export function formatArgsTable(args: unknown): string {
  const header = theme.progressLabel("Arguments");
  const entries = argsToEntries(args);
  if (entries.length === 0) {
    return `${header}\n${theme.meta("  (no arguments)")}`;
  }
  const table = renderArgsTableBody(entries);
  const indented = table.split("\n").map((line) => theme.indent(line)).join("\n");
  return `${header}\n${indented}`;
}

/**
 * Formats {@link Permissions} as a human-readable scope table for approval prompts.
 *
 * @param perms - Effective sandbox permissions to display.
 * @returns ANSI-styled multi-line string with a "Permissions" header and scope rows.
 */
export function formatPermissionsTable(perms: Permissions): string {
  const rows: string[][] = [
    ["Read files", formatPathScope(perms.fsRead)],
    ["Write files", formatPathScope(perms.fsWrite)],
    ["Network", formatNetwork(perms)],
    ["Env variables", formatEnvScope(perms.env)],
  ];
  const header = theme.progressLabel("Permissions");
  const table = colorizeTable(renderTable(PERM_COLUMNS, rows));
  const indented = table.split("\n").map((line) => theme.indent(line)).join("\n");
  return `${header}\n${indented}`;
}
