import { isBuiltinApproval, type ToolRegistry } from "@meta-agent/core";
import { renderTable, truncateCell, type TableColumn } from "./terminal-table.ts";

const TOOLS_COMMAND = {
  DETAILS_ARG: "details",
  USAGE: "Usage: /tools [details]",
} as const;

const BUILTIN_LABEL = {
  YES: "yes",
  NO: "no",
} as const;

const SCHEMA_SUMMARY = {
  ANY: "any",
  OBJECT: "object",
} as const;

const EMPTY_REGISTRY_MESSAGE = "No tools registered.";

const DETAIL_LABEL = {
  DESCRIPTION: "  Description:",
  INPUT_SCHEMA: "  Input schema:",
  OUTPUT_SCHEMA: "  Output schema:",
} as const;

const TABLE_COLUMNS = [
  { header: "Name", width: 16 },
  { header: "Built-in", width: 8 },
  { header: "Description", width: 50 },
  { header: "Input summary", width: 40 },
  { header: "Output summary", width: 40 },
] as const;

const DESCRIPTION_COLUMN_INDEX = 2;
const TABLE_HEADERS = TABLE_COLUMNS.map((col) => col.header);
const DESCRIPTION_COL_WIDTH = TABLE_COLUMNS[DESCRIPTION_COLUMN_INDEX]!.width;

const SCHEMA_PROPS_PREVIEW_LIMIT = 4;
const SCHEMA_PROPS_OVERFLOW_SUFFIX = ", ...";
const JSON_INDENT_SPACES = 4;

/**
 * Options for {@link formatToolsCatalog}.
 */
export type FormatToolsCatalogOpts = {
  /** When true, append full schema JSON below the summary table. */
  details?: boolean;
};

type ToolCatalogRow = {
  name: string;
  builtin: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
  outputShape: Record<string, unknown>;
};

/**
 * Result of parsing a `/tools` REPL command line.
 */
export type ParseToolsCommandResult =
  | { ok: true; details: boolean }
  | { ok: false; usage: string };

/**
 * True when the line is `/tools` or `/tools <args>` — not `/toolsfoo` or `/tools-json`.
 *
 * @param line - Raw REPL input line.
 * @returns Whether the line invokes the tools catalog command.
 */
export function isToolsCommand(line: string): boolean {
  return /^\/tools(\s|$)/.test(line.trim());
}

/**
 * Parses `/tools` command arguments into a details flag or usage error.
 *
 * @param line - Raw REPL input line starting with `/tools`.
 * @returns Parsed options or a usage string when arguments are invalid.
 */
export function parseToolsCommand(line: string): ParseToolsCommandResult {
  const args = line.trim().replace(/^\/tools/, "").trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) return { ok: true, details: false };
  if (args.length === 1 && args[0] === TOOLS_COMMAND.DETAILS_ARG) return { ok: true, details: true };
  return { ok: false, usage: TOOLS_COMMAND.USAGE };
}

/**
 * Truncates text for table cells; alias of {@link truncateCell}.
 *
 * @param text - Raw string to fit in a column.
 * @param max - Maximum visible width.
 * @returns Truncated text with ellipsis when needed.
 */
export function truncate(text: string, max: number): string {
  return truncateCell(text, max);
}

function resolveSchemaType(schema: Record<string, unknown>): string {
  const type = schema.type;
  if (typeof type === "string") return type;
  return schema.properties !== undefined ? SCHEMA_SUMMARY.OBJECT : SCHEMA_SUMMARY.ANY;
}

function appendRequiredSummary(parts: string[], schema: Record<string, unknown>): void {
  const required = schema.required;
  if (!Array.isArray(required) || required.length === 0) return;

  const names = required.filter((r): r is string => typeof r === "string");
  if (names.length === 0) return;

  parts.push(`(required: ${names.join(", ")})`);
}

function appendPropertiesSummary(parts: string[], schema: Record<string, unknown>): void {
  if (schema.properties === undefined || typeof schema.properties !== "object" || schema.properties === null) {
    return;
  }

  const propNames = Object.keys(schema.properties as Record<string, unknown>);
  if (propNames.length === 0) return;

  const shown = propNames.slice(0, SCHEMA_PROPS_PREVIEW_LIMIT);
  const suffix = propNames.length > SCHEMA_PROPS_PREVIEW_LIMIT ? SCHEMA_PROPS_OVERFLOW_SUFFIX : "";
  parts.push(`(props: ${shown.join(", ")}${suffix})`);
}

/**
 * One-line summary of a JSON Schema object for the tools catalog table.
 *
 * @param schema - Tool input or output schema object.
 * @returns Human-readable type and property/required summary.
 */
export function summarizeJsonSchema(schema: Record<string, unknown>): string {
  if (Object.keys(schema).length === 0) return SCHEMA_SUMMARY.ANY;

  const parts: string[] = [resolveSchemaType(schema)];

  const required = schema.required;
  if (Array.isArray(required) && required.length > 0) {
    appendRequiredSummary(parts, schema);
  } else {
    appendPropertiesSummary(parts, schema);
  }

  return parts.join(" ");
}

function indentJson(value: unknown, spaces: number): string {
  const indent = " ".repeat(spaces);
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => indent + line)
    .join("\n");
}

/**
 * Renders a tools catalog table with fixed column widths.
 *
 * @param headers - Column header labels (defaults apply when shorter than column count).
 * @param rows - Pre-formatted cell values per row.
 * @returns Multi-line ASCII table string.
 */
export function renderTerminalTable(headers: string[], rows: string[][]): string {
  const columns: TableColumn[] = TABLE_COLUMNS.map((col, i) => ({
    header: headers[i] ?? col.header,
    width: col.width,
  }));
  return renderTable(columns, rows);
}

async function loadCatalogRows(registry: ToolRegistry): Promise<ToolCatalogRow[]> {
  const summaries = registry.listSync().slice().sort((a, b) => a.name.localeCompare(b.name));
  const rows: ToolCatalogRow[] = [];

  for (const summary of summaries) {
    const manifest = await registry.getManifest(summary.name);
    if (!manifest) continue;
    const approval = await registry.getApproval(summary.name);
    rows.push({
      name: manifest.name,
      builtin: isBuiltinApproval(approval),
      description: manifest.description,
      inputSchema: manifest.inputSchema as Record<string, unknown>,
      outputShape: manifest.outputShape as Record<string, unknown>,
    });
  }

  return rows;
}

function formatToolDetailHeader(name: string): string {
  return `-- ${name} --`;
}

function catalogRowToTableCells(row: ToolCatalogRow): string[] {
  return [
    row.name,
    row.builtin ? BUILTIN_LABEL.YES : BUILTIN_LABEL.NO,
    row.description,
    summarizeJsonSchema(row.inputSchema),
    summarizeJsonSchema(row.outputShape),
  ];
}

function formatToolDetails(row: ToolCatalogRow): string {
  const lines = [formatToolDetailHeader(row.name)];
  if (row.description.length > DESCRIPTION_COL_WIDTH) {
    lines.push(`${DETAIL_LABEL.DESCRIPTION} ${row.description}`);
  }
  lines.push(
    DETAIL_LABEL.INPUT_SCHEMA,
    indentJson(row.inputSchema, JSON_INDENT_SPACES),
    DETAIL_LABEL.OUTPUT_SCHEMA,
    indentJson(row.outputShape, JSON_INDENT_SPACES),
  );
  return lines.join("\n");
}

/**
 * Formats the registered tool catalog as a summary table, optionally with full schemas.
 *
 * @param registry - Tool registry to list.
 * @param opts - When `details` is true, append per-tool schema blocks below the table.
 * @returns Formatted catalog string or an empty-registry message.
 */
export async function formatToolsCatalog(
  registry: ToolRegistry,
  opts?: FormatToolsCatalogOpts,
): Promise<string> {
  const details = opts?.details ?? false;
  const rows = await loadCatalogRows(registry);

  if (rows.length === 0) return EMPTY_REGISTRY_MESSAGE;

  const tableRows = rows.map(catalogRowToTableCells);
  const table = renderTerminalTable(TABLE_HEADERS, tableRows);

  let output = `Tools (${rows.length})\n\n${table}`;

  if (details) {
    output += "\n\n" + rows.map(formatToolDetails).join("\n\n");
  }

  return output;
}

/**
 * Handles a `/tools` REPL command and returns formatted catalog output.
 *
 * @param registry - Tool registry to list.
 * @param line - Raw REPL input line.
 * @returns Catalog text or usage message when parsing fails.
 */
export async function handleToolsCommand(registry: ToolRegistry, line: string): Promise<string> {
  const parsed = parseToolsCommand(line);
  if (!parsed.ok) return parsed.usage;
  return formatToolsCatalog(registry, { details: parsed.details });
}
