import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTable, TABLE_META_ROW_COUNT, truncateCell } from "./terminal-table.ts";

const KV_COLUMNS = [
  { header: "Key", width: 12 },
  { header: "Value", width: 40 },
] as const;

test("truncateCell: short text unchanged", () => {
  assert.equal(truncateCell("hello", 10), "hello");
});

test("truncateCell: long text gets ASCII ellipsis", () => {
  assert.equal(truncateCell("hello world", 8), "hello...");
});

test("renderTable: header, separator, rows", () => {
  const table = renderTable(KV_COLUMNS, [
    ["path", "./tmp/x.md"],
    ["append", "true"],
  ]);
  const lines = table.split("\n");
  assert.equal(lines.length, TABLE_META_ROW_COUNT + 2);
  assert.match(lines[0]!, /Key/);
  assert.match(lines[0]!, /Value/);
  assert.ok(lines[1]!.includes("-"));
  assert.ok(!lines[1]!.includes("\u2500"));
  assert.match(lines[2]!, /path/);
  assert.match(lines[2]!, /\.\/tmp\/x\.md/);
});

test("renderTable: empty rows yields header and separator only", () => {
  const table = renderTable(KV_COLUMNS, []);
  const lines = table.split("\n");
  assert.equal(lines.length, TABLE_META_ROW_COUNT);
  assert.match(lines[0]!, /Key/);
  assert.ok(lines[1]!.includes("-"));
});
