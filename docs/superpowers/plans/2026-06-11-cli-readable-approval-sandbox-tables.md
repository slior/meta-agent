# CLI Readable Approval and Sandbox Tables — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present Gate 2/3 approval prompts and sandbox debug lines as readable key-value tables instead of raw JSON or `key=value` strings, while leaving trace files unchanged.

**Architecture:** All formatting stays in `packages/cli`. Extract a small generic `terminal-table.ts` module (reused by `/tools`, approval prompts, and sandbox logs). Add `approval-display.ts` for args/permissions formatters and extend `sandbox-log-format.ts` to parse sandbox detail strings into tables. No changes to trace JSONL output or core sandbox call sites.

**Tech Stack:** TypeScript (ESM), `node:test`, `picocolors` via existing `terminal-theme.ts`, monorepo `@meta-agent/cli` only.

---

## What we have today

### Gate 2/3 approval (`approval-tui.ts`)

When the agent invokes a tool, the REPL blocks for approval and prints:

```
=== GATE 2/3: write-file-text (risk: medium) ===
Args: {"append":true,"content":"\n\nURL: …","path":"./tmp/gaia2-3.md"}
Permissions: {"fsRead":[],"fsWrite":["*"],"net":"none","netAllowlist":[],"env":[]}
[a]pprove-once / [s]ession-approve / [r]eject? 
```

Labels are colored (Task 6 of the colored-output plan), but values are still one-line JSON blobs.

Gate 1 (`printGate1Review`) already prints permissions as indented key-value lines — better, but still uses raw field names (`fsRead`, `netAllowlist`) and bracketed arrays.

### Sandbox debug (`sandbox-log-format.ts`)

With `META_AGENT_SANDBOX_DEBUG=1`, lines look like:

```
SANDBOX  sandbox writing args frame to child stdin — tool=write-file-text op=args
SANDBOX  sandbox tool child spawned — pid=9442 tool=write-file-text net=none netAllowlist=0 nodeFlagCount=9 timeoutMs=30000
```

The message and detail are on one line; detail is space-separated `key=value` pairs that are hard to scan.

Some sandbox details are **not** key-value pairs (JSON arg summaries, stack traces). Those must fall back to plain dim text — not forced into a table.

### Existing table helper (`tools-table.ts`)

`renderTerminalTable` exists but is tied to fixed five-column widths from `TABLE_COLUMNS`. Approval and sandbox need a two-column **Key | Value** layout with configurable widths.

---

## Design

### Visual layout (approval)

```
=== GATE 2/3: write-file-text (risk: medium) ===

Arguments
  Key       Value
  --------  --------------------------------------------------
  path      ./tmp/gaia2-3.md
  append    true
  content   (multiline, 42 chars)
            …first preview line…

Permissions
  Scope           Access
  --------------  --------------------------------------------------
  Read files      none
  Write files     all paths (*)
  Network         blocked
  Env variables   none
```

- Section headers (`Arguments`, `Permissions`) use `theme.progressLabel`.
- Table text uses `theme.meta` for headers/separator and `theme.progressBody` for cell content.
- Long or multiline arg values: first row shows truncated scalar or `(multiline, N chars)`; **preview lines appear immediately below that row**, indented to the value column (not batched after the whole table).
- Trace files: **unchanged** — approval policy and tracer still log raw JSON objects.

### Human-friendly permission labels

Map `Permissions` fields to plain-language rows (reuse for Gate 1 and Gate 2/3):

| Internal field | Row label | Value formatting |
|----------------|-----------|------------------|
| `fsRead` | Read files | `none` if empty; `all paths (*)` if includes `*`; else comma-separated globs |
| `fsWrite` | Write files | same |
| `net` + `netAllowlist` | Network | `blocked` when `none`; `allowlist (host1, host2)` when `allowlist` with hosts; `allowlist (no hosts)` when empty allowlist |
| `env` | Env variables | `none` if empty; else comma-separated names |

### Sandbox detail parsing

1. **Key-value detail** — every whitespace-separated token must be `key=value` where the key is everything before the **first** `=` and the value is the remainder (so `hash=abc=def` → key `hash`, value `abc=def`). Example: `tool=write-file-text op=args`. Render as indented two-column table under the message line.
2. **JSON object detail** — string starts with `{` and parses as JSON object. Expand to key-value table (same as approval args).
3. **Fallback** — free text (stack traces, truncated JSON arrays, tokens with spaces in values). Show message line + dim indented body (no table).

Message line stays: `SANDBOX  <cyan message>` on its own line; table/fallback body is indented 2 spaces below.

### Shared `terminal-table.ts`

```ts
export type TableColumn = { header: string; width: number };

export function truncateCell(text: string, max: number): string;
export function renderTable(
  columns: ReadonlyArray<TableColumn>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string;
```

- Use `ReadonlyArray` so callers may pass `as const` column definitions without typecheck errors.
- ASCII `-` separator (no box-drawing chars) — matches `/tools` convention.
- `truncateCell` uses ASCII `...` ellipsis (reuse logic from `tools-table.ts` `truncate`).
- Refactor `tools-table.ts` to call `renderTable` with its existing column definitions — no visual change to `/tools` output.

---

## File structure

**New files**

- `packages/cli/src/terminal-table.ts` — generic column-width table renderer + `truncateCell`
- `packages/cli/src/terminal-table.test.ts`
- `packages/cli/src/approval-display.ts` — `formatArgsTable`, `formatPermissionsTable`
- `packages/cli/src/approval-display.test.ts`

**Modified files**

- `packages/cli/src/approval-tui.ts` — Gate 2/3 uses new formatters; Gate 1 permissions use `formatPermissionsTable`
- `packages/cli/src/sandbox-log-format.ts` — parse detail, render table or fallback
- `packages/cli/src/sandbox-log-format.test.ts` — update existing tests + add table cases
- `packages/cli/src/tools-table.ts` — import `renderTable` / `truncateCell` from `terminal-table.ts`
- `packages/cli/src/tools-table.test.ts` — update imports if needed
- `docs/configuration.md` — short note on approval/sandbox table layout

**Not changing**

- `@meta-agent/core` sandbox call sites (detail strings stay as-is; CLI parses them)
- Trace JSONL format
- `approval-format.ts` (headers and choice prompts stay; display logic lives in `approval-display.ts`)
- `approval-format.test.ts` (unchanged — `formatLabelValue` is still used by Gate 1)

---

## Test coverage (required)

Every row below must have a corresponding test in the task code blocks.

### `truncateCell` / `renderTable`

| Case | Assert |
|------|--------|
| Short cell | no truncation |
| Long cell | ends with `...`, width respected |
| Separator | ASCII hyphens only, width = sum of columns + gaps |
| Empty rows | header + separator only (2 lines) |

### `formatArgsTable`

| Case | Assert |
|------|--------|
| Simple object | keys as rows, scalar values shown |
| Nested object value | `(object, N chars)` + preview lines under that row |
| Long string | truncated with `...` |
| Multiline string | `(multiline, N chars)` + preview lines under that row |
| Non-object args (string/number) | single row `value` → stringified |
| Empty object | `(no arguments)` meta line |

### `formatPermissionsTable`

| Case | Assert |
|------|--------|
| All empty | Read/Write/Network/Env all `none` / `blocked` |
| `fsWrite: ["*"]` | `all paths (*)` |
| `net: allowlist` + hosts | `allowlist (a.com, b.com)` |
| `net: allowlist` + `[]` | `allowlist (no hosts)` |

### `parseSandboxDetail` + `writeSandboxLogLine`

| Case | Assert |
|------|--------|
| `tool=x op=args` | table with tool, op rows |
| `pid=1 tool=x net=none` | table with all keys |
| `hash=abc=def` | key `hash`, value `abc=def` (first-`=` split) |
| JSON object string | table from parsed keys |
| Stack trace / plain text | no table; dim body below message |
| Message only | no body lines (unchanged) |
| **Updated** existing tests | assert column values (`write-file-text`, `x`), not literal `tool=…` strings |

---

## Conventions

- **Run CLI tests:** `cd packages/cli && npm test`
- **Run full monorepo tests:** `npm test` from repo root (required in Tasks 5–6)
- **Typecheck:** `npm run typecheck` from repo root
- **Strip ANSI in tests:** `s.replace(/\x1b\[[0-9;]*m/g, "")`
- **Manual smoke:** `META_AGENT_SANDBOX_DEBUG=1 npm run cli`, trigger a tool call, confirm approval tables and sandbox tables
- Commit after each task when tests pass

---

## Task 1: Generic terminal table module

**Files:**
- Create: `packages/cli/src/terminal-table.ts`
- Create: `packages/cli/src/terminal-table.test.ts`
- Modify: `packages/cli/src/tools-table.ts`
- Modify: `packages/cli/src/tools-table.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/cli/src/terminal-table.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTable, truncateCell } from "./terminal-table.ts";

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
  assert.equal(lines.length, 4);
  assert.match(lines[0], /Key/);
  assert.match(lines[0], /Value/);
  assert.ok(lines[1].includes("-"));
  assert.ok(!lines[1].includes("\u2500"));
  assert.match(lines[2], /path/);
  assert.match(lines[2], /\.\/tmp\/x\.md/);
});

test("renderTable: empty rows yields header and separator only", () => {
  const table = renderTable(KV_COLUMNS, []);
  const lines = table.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Key/);
  assert.ok(lines[1].includes("-"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && npm test -- terminal-table.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `terminal-table.ts`**

```ts
const TRUNCATE_ELLIPSIS = "...";
const COL_GAP = "  ";

export type TableColumn = { header: string; width: number };

export function truncateCell(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - TRUNCATE_ELLIPSIS.length) + TRUNCATE_ELLIPSIS;
}

function formatRow(cells: ReadonlyArray<string>, widths: ReadonlyArray<number>): string {
  return cells
    .map((cell, i) => truncateCell(cell, widths[i]!).padEnd(widths[i]!))
    .join(COL_GAP);
}

export function renderTable(
  columns: ReadonlyArray<TableColumn>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  const widths = columns.map((c) => c.width);
  const headers = columns.map((c) => c.header);
  const lines: string[] = [formatRow(headers, widths)];
  const totalWidth = widths.reduce((s, w) => s + w, 0) + COL_GAP.length * (columns.length - 1);
  lines.push("-".repeat(totalWidth));
  for (const row of rows) {
    lines.push(formatRow(row, widths));
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Refactor `tools-table.ts`**

- Remove local `truncate` function; keep a thin `truncate` alias that delegates to `truncateCell`.
- Replace `renderTerminalTable` body with `renderTable(...)`.
- Keep `export function renderTerminalTable(...)` as a thin wrapper so existing tests pass.

```ts
import { renderTable, truncateCell, type TableColumn } from "./terminal-table.ts";

export function truncate(text: string, max: number): string {
  return truncateCell(text, max);
}

export function renderTerminalTable(headers: string[], rows: string[][]): string {
  const columns: TableColumn[] = TABLE_COLUMNS.map((col, i) => ({
    header: headers[i] ?? col.header,
    width: col.width,
  }));
  return renderTable(columns, rows);
}
```

- [ ] **Step 5: Run tests**

Run: `cd packages/cli && npm test`
Expected: PASS (all tools-table + terminal-table tests)

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/terminal-table.ts packages/cli/src/terminal-table.test.ts packages/cli/src/tools-table.ts packages/cli/src/tools-table.test.ts
git commit -m "cli: extract generic terminal table renderer"
```

---

## Task 2: Approval args and permissions formatters

**Files:**
- Create: `packages/cli/src/approval-display.ts`
- Create: `packages/cli/src/approval-display.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/cli/src/approval-display.test.ts` with full coverage:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Permissions } from "@meta-agent/core";
import { formatArgsTable, formatPermissionsTable } from "./approval-display.ts";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("formatArgsTable: scalar fields", () => {
  const out = stripAnsi(formatArgsTable({ path: "./tmp/x.md", append: true }));
  assert.match(out, /Arguments/);
  assert.match(out, /path/);
  assert.match(out, /\.\/tmp\/x\.md/);
  assert.match(out, /append/);
  assert.match(out, /true/);
});

test("formatArgsTable: long string truncated", () => {
  const out = stripAnsi(formatArgsTable({ content: "x".repeat(200) }));
  assert.match(out, /content/);
  assert.match(out, /\.\.\./);
});

test("formatArgsTable: multiline string preview under row", () => {
  const out = stripAnsi(formatArgsTable({ content: "line1\nline2\nline3\nline4" }));
  const lines = out.split("\n");
  const multilineIdx = lines.findIndex((l) => l.includes("(multiline,"));
  assert.ok(multilineIdx >= 0);
  const previewIdx = lines.findIndex((l, i) => i > multilineIdx && l.includes("line1"));
  assert.ok(previewIdx > multilineIdx);
  assert.ok(previewIdx - multilineIdx <= 2);
});

test("formatArgsTable: nested object preview under row", () => {
  const out = stripAnsi(formatArgsTable({ opts: { a: 1, b: 2, c: 3, nested: { x: 1 } } }));
  assert.match(out, /\(object,/);
  const lines = out.split("\n");
  const objectIdx = lines.findIndex((l) => l.includes("(object,"));
  const jsonIdx = lines.findIndex((l, i) => i > objectIdx && l.includes('"a"'));
  assert.ok(jsonIdx > objectIdx);
});

test("formatArgsTable: non-object args", () => {
  const out = stripAnsi(formatArgsTable("hello"));
  assert.match(out, /value/);
  assert.match(out, /hello/);
});

test("formatArgsTable: empty object", () => {
  const out = stripAnsi(formatArgsTable({}));
  assert.match(out, /\(no arguments\)/);
});

test("formatPermissionsTable: blocked network", () => {
  const perms: Permissions = {
    fsRead: [],
    fsWrite: ["*"],
    net: "none",
    netAllowlist: [],
    env: [],
  };
  const out = stripAnsi(formatPermissionsTable(perms));
  assert.match(out, /Permissions/);
  assert.match(out, /Write files/);
  assert.match(out, /all paths/);
  assert.match(out, /Network/);
  assert.match(out, /blocked/);
});

test("formatPermissionsTable: allowlist hosts", () => {
  const perms: Permissions = {
    fsRead: ["/workspace/**"],
    fsWrite: [],
    net: "allowlist",
    netAllowlist: ["api.example.com"],
    env: ["PATH"],
  };
  const out = stripAnsi(formatPermissionsTable(perms));
  assert.match(out, /Read files/);
  assert.match(out, /\/workspace/);
  assert.match(out, /allowlist/);
  assert.match(out, /api\.example\.com/);
  assert.match(out, /PATH/);
});

test("formatPermissionsTable: empty allowlist", () => {
  const perms: Permissions = {
    fsRead: [],
    fsWrite: [],
    net: "allowlist",
    netAllowlist: [],
    env: [],
  };
  const out = stripAnsi(formatPermissionsTable(perms));
  assert.match(out, /allowlist \(no hosts\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && npm test -- approval-display.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `approval-display.ts`**

Per-row preview lines: build the table body manually (header + separator + per-entry row + that entry's extras), not via a single `renderTable` call with batched extras.

```ts
import type { Permissions } from "@meta-agent/core";
import { PERMISSIONS_NET } from "@meta-agent/core";
import { theme } from "./terminal-theme.ts";
import { renderTable, truncateCell, type TableColumn } from "./terminal-table.ts";

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

type ArgEntry = { key: string; cell: string; extraLines: string[] };

function valueColumnIndent(columns: ReadonlyArray<TableColumn>): string {
  return " ".repeat(columns[0]!.width + COL_GAP.length);
}

function formatPathScope(globs: string[]): string {
  if (globs.length === 0) return "none";
  if (globs.includes("*")) return "all paths (*)";
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

function formatArgValue(value: unknown): { cell: string; extraLines: string[] } {
  const valueIndent = valueColumnIndent(ARGS_COLUMNS);
  if (value === null || value === undefined) {
    return { cell: String(value), extraLines: [] };
  }
  if (typeof value === "string") {
    if (value.includes("\n") || value.length > MULTILINE_CHAR_THRESHOLD) {
      const preview = value.split("\n").slice(0, MULTILINE_PREVIEW_LINES);
      const cell = `(multiline, ${value.length} chars)`;
      const extraLines = preview.map((line) =>
        valueIndent + theme.meta(truncateCell(line, VALUE_COL_WIDTH)),
      );
      return { cell, extraLines };
    }
    return { cell: truncateCell(value, VALUE_COL_WIDTH), extraLines: [] };
  }
  if (typeof value === "object") {
    const json = JSON.stringify(value, null, 2);
    if (json.includes("\n") || json.length > MULTILINE_CHAR_THRESHOLD) {
      const preview = json.split("\n").slice(0, MULTILINE_PREVIEW_LINES);
      const extraLines = preview.map((line) =>
        valueIndent + theme.meta(truncateCell(line, VALUE_COL_WIDTH)),
      );
      return { cell: `(object, ${json.length} chars)`, extraLines };
    }
    return { cell: truncateCell(json, VALUE_COL_WIDTH), extraLines: [] };
  }
  return { cell: truncateCell(String(value), VALUE_COL_WIDTH), extraLines: [] };
}

function argsToEntries(args: unknown): ArgEntry[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return [{ key: "value", cell: truncateCell(String(args), VALUE_COL_WIDTH), extraLines: [] }];
  }
  return Object.entries(args as Record<string, unknown>).map(([key, value]) => {
    const formatted = formatArgValue(value);
    return { key, cell: formatted.cell, extraLines: formatted.extraLines };
  });
}

function renderArgsTableBody(entries: ArgEntry[]): string {
  const headerTable = renderTable(ARGS_COLUMNS, []);
  const headerLines = headerTable.split("\n");
  const bodyLines: string[] = [];
  for (const entry of entries) {
    bodyLines.push(renderTable(ARGS_COLUMNS, [[entry.key, entry.cell]]).split("\n")[2]!);
    bodyLines.push(...entry.extraLines);
  }
  const colored = [...headerLines, ...bodyLines]
    .map((line, i) => (i <= 1 ? theme.meta(line) : theme.progressBody(line)))
    .join("\n");
  return colored;
}

/**
 * Formats tool invocation arguments as a labeled key-value table.
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

function colorizeTable(table: string): string {
  return table
    .split("\n")
    .map((line, i) => (i <= 1 ? theme.meta(line) : theme.progressBody(line)))
    .join("\n");
}

/**
 * Formats {@link Permissions} as a human-readable scope table.
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
```

- [ ] **Step 4: Run tests**

Run: `cd packages/cli && npm test -- approval-display.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/approval-display.ts packages/cli/src/approval-display.test.ts
git commit -m "cli: add readable approval args and permissions tables"
```

---

## Task 3: Wire approval prompts

**Files:**
- Modify: `packages/cli/src/approval-tui.ts`

- [ ] **Step 1: Add import at top of `approval-tui.ts`**

Add alongside the existing imports (not inside any function):

```ts
import { formatArgsTable, formatPermissionsTable } from "./approval-display.ts";
```

- [ ] **Step 2: Update `promptGate23`**

Replace only the two `console.log` lines inside `promptGate23`:

```ts
console.log(formatArgsTable(args));
console.log(formatPermissionsTable(tool.manifest.permissions));
```

(Remove the old `formatLabelValue("Args", JSON.stringify(args))` and `formatLabelValue("Permissions", JSON.stringify(...))` lines.)

- [ ] **Step 3: Align Gate 1 permissions**

In `printGate1Review`, replace the manual permissions block (the `theme.meta("Permissions:")` line plus five `formatLabelValue` calls for `fsRead`/`fsWrite`/`net`/`netAllowlist`/`env`) with:

```ts
console.log(formatPermissionsTable(draft.permissions));
```

Keep other Gate 1 fields as `formatLabelValue` for now.

**Do not modify `approval-format.test.ts`** — `formatLabelValue` is unchanged and still tested there.

- [ ] **Step 4: Run tests and typecheck**

```bash
cd packages/cli && npm test
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: Manual smoke test**

Run: `npm run cli`, ask agent to write a file. At Gate 2/3 prompt, confirm Arguments and Permissions tables (not JSON lines).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/approval-tui.ts
git commit -m "cli: show approval prompts as readable tables"
```

---

## Task 4: Sandbox detail tables

**Files:**
- Modify: `packages/cli/src/sandbox-log-format.ts`
- Modify: `packages/cli/src/sandbox-log-format.test.ts`

- [ ] **Step 1: Update tests (existing + new)**

In `sandbox-log-format.test.ts`:

1. **Update the existing import** (do not add a second import line):

```ts
import { parseSandboxDetail, writeSandboxLogLine } from "./sandbox-log-format.ts";
```

2. **Replace** the existing test `writeSandboxLogLine: badge, message, and detail` with:

```ts
test("writeSandboxLogLine: badge, message, and detail table", () => {
  const out = stripAnsi(captureStderr(() =>
    writeSandboxLogLine("sandbox writing args frame to child stdin", "tool=write-file-text op=args"),
  ));
  assert.match(out, /SANDBOX/);
  assert.match(out, /sandbox writing args frame/);
  assert.match(out, /write-file-text/);
  assert.match(out, /args/);
  assert.ok(!out.includes("tool=write-file-text"));
  assert.ok(out.split("\n").length >= 3);
  assert.ok(out.endsWith("\n"));
});
```

3. **Replace** the existing test `writeSandboxLogLine: error styling` with:

```ts
test("writeSandboxLogLine: error styling with detail table", () => {
  const out = stripAnsi(captureStderr(() =>
    writeSandboxLogLine("sandbox tool child killed", "tool=x pid=1", { error: true }),
  ));
  assert.match(out, /SANDBOX/);
  assert.match(out, /killed/);
  assert.match(out, /\bx\b/);
  assert.match(out, /pid/);
  assert.ok(!out.includes("tool=x"));
});
```

4. **Add** new tests:

```ts
test("parseSandboxDetail: key=value pairs", () => {
  const parsed = parseSandboxDetail("tool=write-file-text op=args");
  assert.equal(parsed.kind, "table");
  if (parsed.kind === "table") {
    assert.deepEqual(parsed.rows, [
      ["tool", "write-file-text"],
      ["op", "args"],
    ]);
  }
});

test("parseSandboxDetail: value may contain equals signs", () => {
  const parsed = parseSandboxDetail("hash=abc=def");
  assert.equal(parsed.kind, "table");
  if (parsed.kind === "table") {
    assert.deepEqual(parsed.rows, [["hash", "abc=def"]]);
  }
});

test("parseSandboxDetail: plain text fallback", () => {
  const parsed = parseSandboxDetail("Error: something\n  at foo.js:1");
  assert.equal(parsed.kind, "text");
});

test("writeSandboxLogLine: renders detail table on separate lines", () => {
  const out = stripAnsi(captureStderr(() =>
    writeSandboxLogLine("sandbox tool child spawned", "pid=9442 tool=write-file-text net=none"),
  ));
  assert.match(out, /SANDBOX/);
  assert.match(out, /sandbox tool child spawned/);
  assert.match(out, /9442/);
  assert.match(out, /write-file-text/);
  assert.ok(out.split("\n").length >= 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && npm test -- sandbox-log-format.test.ts`
Expected: FAIL — `parseSandboxDetail` not defined / old layout

- [ ] **Step 3: Implement detail parsing and table output**

Update `sandbox-log-format.ts`:

```ts
import { theme } from "./terminal-theme.ts";
import { renderTable, type TableColumn } from "./terminal-table.ts";

const SANDBOX_LOG_FIELD_GAP = "  ";
const DETAIL_COLUMNS: TableColumn[] = [
  { header: "Field", width: 18 },
  { header: "Value", width: 44 },
];

export type ParsedSandboxDetail =
  | { kind: "table"; rows: string[][] }
  | { kind: "text"; body: string };

/** Split `key=value` on the first `=` so values may contain `=`. */
function parseKvToken(token: string): [string, string] | null {
  const eq = token.indexOf("=");
  if (eq <= 0) return null;
  return [token.slice(0, eq), token.slice(eq + 1)];
}

export function parseSandboxDetail(detail: string): ParsedSandboxDetail {
  const trimmed = detail.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        const rows = Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
          k,
          typeof v === "string" ? v : JSON.stringify(v),
        ]);
        return { kind: "table", rows };
      }
    } catch {
      /* fall through */
    }
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: "text", body: trimmed };

  const rows: string[][] = [];
  for (const token of tokens) {
    const kv = parseKvToken(token);
    if (!kv) return { kind: "text", body: detail };
    rows.push(kv);
  }
  return { kind: "table", rows };
}

function formatDetailBody(detail: string): string {
  const parsed = parseSandboxDetail(detail);
  if (parsed.kind === "text") {
    return parsed.body
      .split("\n")
      .map((line) => theme.indent(theme.meta(line)))
      .join("\n");
  }
  const table = renderTable(DETAIL_COLUMNS, parsed.rows);
  return table
    .split("\n")
    .map((line, i) => theme.indent(i <= 1 ? theme.meta(line) : theme.progressBody(line)))
    .join("\n");
}

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
```

Remove `SANDBOX_DETAIL_SEPARATOR` and the old single-line `message — detail` layout (cleanup of that constant is also verified in Task 6).

- [ ] **Step 4: Run tests**

Run: `cd packages/cli && npm test -- sandbox-log-format.test.ts`
Expected: PASS (all updated + new tests)

- [ ] **Step 5: Manual smoke test**

Run: `META_AGENT_SANDBOX_DEBUG=1 npm run cli`, trigger a sandboxed tool. Confirm SANDBOX lines show message on line 1 and indented Field/Value table on following lines.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/sandbox-log-format.ts packages/cli/src/sandbox-log-format.test.ts
git commit -m "cli: render sandbox debug details as tables"
```

---

## Task 5: Documentation and verification

**Files:**
- Modify: `docs/configuration.md`

- [ ] **Step 1: Document table layout**

Add to `docs/configuration.md` (near existing terminal color section):

- Gate 2/3 approval shows Arguments and Permissions as indented tables, not JSON.
- Sandbox debug (`META_AGENT_SANDBOX_DEBUG=1`) prints `key=value` details as Field/Value tables; free-text details (errors, long JSON) stay as indented plain text.
- Trace JSONL files are unaffected.

- [ ] **Step 2: Full verification (monorepo)**

```bash
npm run typecheck
npm test
```

- [ ] **Step 3: Commit**

```bash
git add docs/configuration.md
git commit -m "docs: note CLI approval and sandbox table formatting"
```

---

## Task 6: Code cleanup pass

**Files:**
- Modify: `packages/cli/src/sandbox-log-format.ts` (verify dead code removed)
- Modify: `packages/cli/src/approval-tui.ts` (remove unused imports if any)
- Scan: all files touched in Tasks 1–5

- [ ] **Step 1: Remove dead code**

Confirm and remove if still present:

- `SANDBOX_DETAIL_SEPARATOR` in `sandbox-log-format.ts` (replaced by table layout in Task 4)
- Any unused `formatLabelValue` import in `approval-tui.ts` if Gate 2/3 was its only use for Args/Permissions (it is still needed for Gate 1 fields — keep the import)

- [ ] **Step 2: Naming consistency check**

- All table renderers use `terminal-table.ts` (`renderTable`, `truncateCell`) — no duplicate truncation helpers left in `tools-table.ts` beyond the `truncate` alias.
- Exported public API surface: `formatArgsTable`, `formatPermissionsTable`, `parseSandboxDetail`, `writeSandboxLogLine`, `renderTable`, `truncateCell` — no orphan exports.

- [ ] **Step 3: Final verification**

```bash
npm run typecheck
npm test
cd packages/cli && npm test
```

Expected: PASS

- [ ] **Step 4: Commit** (only if cleanup produced diffs)

```bash
git add -A packages/cli/src/
git commit -m "cli: cleanup dead code after table formatting"
```

---

## Self-review

| Requirement | Covered by |
|-------------|------------|
| Args as key-value table (not JSON) in CLI | Task 2–3 |
| Human-friendly permissions | Task 2–3 (`formatPermissionsTable`) |
| Sandbox messages in table | Task 4 |
| Trace files unchanged | Design — no tracer/core changes |
| Reuse existing theme/colors | All formatters use `terminal-theme.ts` |
| Gate 1 permissions consistency | Task 3 |
| Non-kv sandbox fallback | Task 4 `parseSandboxDetail` text branch |
| Per-row multiline previews (not batched) | Task 2 `renderArgsTableBody` |
| `ReadonlyArray` table signature | Task 1 |
| Existing sandbox tests updated | Task 4 Step 1 |
| Import at module top (not in function) | Task 3 Step 1 |
| Full coverage matrix tests in task code | Tasks 1–2, 4 |
| Monorepo `npm test` | Tasks 5–6 |
| Code cleanup pass | Task 6 |
| No stale `formatApprovalSection` | Removed from file structure |
| `approval-format.test.ts` untouched | Task 3 note |
| KV values with embedded `=` | Task 4 `parseKvToken` |

---

## Future follow-ups (out of scope)

- Gate 1 input/output schema as tables instead of JSON blobs
- Terminal width detection for dynamic column sizes
- Structured sandbox detail API in core (avoid string parsing)
- Colorize `/tools` table headers via `theme.meta`
