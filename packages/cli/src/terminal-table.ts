const TRUNCATE_ELLIPSIS = "...";
const COL_GAP = "  ";
const TABLE_SEPARATOR_CHAR = "-";

/** Header plus separator rows in {@link renderTable} output. */
export const TABLE_META_ROW_COUNT = 2;
/** Index of the first data row in {@link renderTable} output (after header and separator). */
export const TABLE_FIRST_DATA_ROW_INDEX = TABLE_META_ROW_COUNT;

/**
 * Column definition for {@link renderTable}.
 */
export type TableColumn = { header: string; width: number };

/**
 * Truncates cell text to fit a column, appending an ASCII ellipsis when needed.
 *
 * @param text - Raw cell content.
 * @param max - Maximum visible width including ellipsis when truncated.
 * @returns Text at most `max` characters wide.
 */
export function truncateCell(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - TRUNCATE_ELLIPSIS.length) + TRUNCATE_ELLIPSIS;
}

function formatRow(cells: ReadonlyArray<string>, widths: ReadonlyArray<number>): string {
  return cells
    .map((cell, i) => truncateCell(cell, widths[i]!).padEnd(widths[i]!))
    .join(COL_GAP);
}

/**
 * Renders a fixed-width ASCII table with a header row and dash separator.
 *
 * @param columns - Column headers and widths.
 * @param rows - Body rows; each inner array must align with `columns` length.
 * @returns Multi-line table string (header, separator, then data rows).
 */
export function renderTable(
  columns: ReadonlyArray<TableColumn>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  const widths = columns.map((c) => c.width);
  const headers = columns.map((c) => c.header);
  const lines: string[] = [formatRow(headers, widths)];
  const totalWidth = widths.reduce((s, w) => s + w, 0) + COL_GAP.length * (columns.length - 1);
  lines.push(TABLE_SEPARATOR_CHAR.repeat(totalWidth));
  for (const row of rows) {
    lines.push(formatRow(row, widths));
  }
  return lines.join("\n");
}
