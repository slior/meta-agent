import { isBuiltinApproval, type ToolRegistry } from "@meta-agent/core";

const TOOLS_COMMAND = {
  detailsArg: "details",
  usage: "Usage: /tools [details]",
} as const;

const BUILTIN_LABEL = {
  yes: "yes",
  no: "no",
} as const;

const SCHEMA_SUMMARY = {
  any: "any",
  object: "object",
} as const;

const TRUNCATE_ELLIPSIS = "...";

const EMPTY_REGISTRY_MESSAGE = "No tools registered.";

const DETAIL_LABEL = {
  description: "  Description:",
  inputSchema: "  Input schema:",
  outputSchema: "  Output schema:",
} as const;

const TABLE_COLUMNS = [
  { header: "Name", width: 16 },
  { header: "Built-in", width: 8 },
  { header: "Description", width: 50 },
  { header: "Input summary", width: 40 },
  { header: "Output summary", width: 40 },
] as const;

const DESCRIPTION_COLUMN_INDEX = 2;
const TABLE_COL_WIDTHS = TABLE_COLUMNS.map((col) => col.width);
const TABLE_HEADERS = TABLE_COLUMNS.map((col) => col.header);
const DESCRIPTION_COL_WIDTH = TABLE_COLUMNS[DESCRIPTION_COLUMN_INDEX]!.width;

const COL_GAP = "  ";

const SCHEMA_PROPS_PREVIEW_LIMIT = 4;
const SCHEMA_PROPS_OVERFLOW_SUFFIX = ", ...";
const JSON_INDENT_SPACES = 4;

export type FormatToolsCatalogOpts = {
  details?: boolean;
};

type ToolCatalogRow = {
  name: string;
  builtin: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
  outputShape: Record<string, unknown>;
};

export type ParseToolsCommandResult =
  | { ok: true; details: boolean }
  | { ok: false; usage: string };

/** True when line is /tools or /tools <args> — not /toolsfoo or /tools-json. */
export function isToolsCommand(line: string): boolean {
  return /^\/tools(\s|$)/.test(line.trim());
}

export function parseToolsCommand(line: string): ParseToolsCommandResult {
  const args = line.trim().replace(/^\/tools/, "").trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) return { ok: true, details: false };
  if (args.length === 1 && args[0] === TOOLS_COMMAND.detailsArg) return { ok: true, details: true };
  return { ok: false, usage: TOOLS_COMMAND.usage };
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - TRUNCATE_ELLIPSIS.length) + TRUNCATE_ELLIPSIS;
}

function resolveSchemaType(schema: Record<string, unknown>): string {
  const type = schema.type;
  if (typeof type === "string") return type;
  return schema.properties !== undefined ? SCHEMA_SUMMARY.object : SCHEMA_SUMMARY.any;
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

export function summarizeJsonSchema(schema: Record<string, unknown>): string {
  if (Object.keys(schema).length === 0) return SCHEMA_SUMMARY.any;

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

function formatTableRow(cells: string[]): string {
  return cells
    .map((cell, i) => truncate(cell, TABLE_COL_WIDTHS[i]!).padEnd(TABLE_COL_WIDTHS[i]!))
    .join(COL_GAP);
}

export function renderTerminalTable(headers: string[], rows: string[][]): string {
  const colCount = headers.length;
  const lines: string[] = [];

  lines.push(formatTableRow(headers));

  const totalWidth =
    TABLE_COL_WIDTHS.reduce((sum, w) => sum + w, 0) + COL_GAP.length * (colCount - 1);
  lines.push("-".repeat(totalWidth));

  for (const row of rows) {
    lines.push(formatTableRow(row));
  }

  return lines.join("\n");
}

async function loadCatalogRows(registry: ToolRegistry): Promise<ToolCatalogRow[]> {
  const summaries = registry.listSync().slice().sort((a, b) => a.name.localeCompare(b.name));
  const rows: ToolCatalogRow[] = [];

  for (const summary of summaries) {
    const tool = await registry.get(summary.name);
    if (!tool) continue;
    const approval = await registry.getApproval(summary.name);
    rows.push({
      name: tool.manifest.name,
      builtin: isBuiltinApproval(approval),
      description: tool.manifest.description,
      inputSchema: tool.manifest.inputSchema as Record<string, unknown>,
      outputShape: tool.manifest.outputShape as Record<string, unknown>,
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
    row.builtin ? BUILTIN_LABEL.yes : BUILTIN_LABEL.no,
    row.description,
    summarizeJsonSchema(row.inputSchema),
    summarizeJsonSchema(row.outputShape),
  ];
}

function formatToolDetails(row: ToolCatalogRow): string {
  const lines = [formatToolDetailHeader(row.name)];
  if (row.description.length > DESCRIPTION_COL_WIDTH) {
    lines.push(`${DETAIL_LABEL.description} ${row.description}`);
  }
  lines.push(
    DETAIL_LABEL.inputSchema,
    indentJson(row.inputSchema, JSON_INDENT_SPACES),
    DETAIL_LABEL.outputSchema,
    indentJson(row.outputShape, JSON_INDENT_SPACES),
  );
  return lines.join("\n");
}

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

export async function handleToolsCommand(registry: ToolRegistry, line: string): Promise<string> {
  const parsed = parseToolsCommand(line);
  if (!parsed.ok) return parsed.usage;
  return formatToolsCatalog(registry, { details: parsed.details });
}
