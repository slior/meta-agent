# CLI Colored Progress and Debug Output — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent progress easier to read in the terminal by coloring metadata separately from message content, and making debug-only lines visually distinct from normal progress lines.

**Architecture:** Keep all changes inside `packages/cli`. Add one small color dependency and a small “theme” module that knows how to style progress vs debug lines. Existing data paths stay the same: the tracer observer still formats trace events, and the debug sink still receives `DebugEvent` objects from the LLM provider. We only change how those lines are printed, not how events are produced or routed.

**Tech Stack:** TypeScript (ESM), `node:test`, `picocolors` (minimal ANSI styling), monorepo workspaces (`@meta-agent/cli` only for implementation).

---

## What we have today

When you run the REPL, two kinds of stderr output can appear:

1. **Progress lines** (always on) — produced by `formatTraceEvent` in `packages/cli/src/trace-progress.ts`, written from the tracer observer in `repl.ts`. Examples: `LLM request (turn 1)…`, `Running "read_file"…`, `Tool call: read_file → ok`.
2. **Debug lines** (only with `--debug` or `META_AGENT_DEBUG=1`) — produced by `createStderrDebugSink` in `packages/cli/src/resolve-debug.ts`, attached to `OpenAIProvider` when debug mode is on. Example: `[meta-agent:debug] openai.chat.completion {"id":"…", …}`.

Both use plain text with similar-looking prefixes. Metadata that already exists on trace events (`ts`, `kind`, turn numbers, tool names) is mixed into one string with no visual hierarchy. Debug payloads are often long JSON blobs on a single line.

Trace events already carry a timestamp (`TraceEvent.ts`) but progress formatting does not show it yet.

---

## Design (plain English)

### One small dependency: `picocolors`

Add `picocolors` to `packages/cli` only.

Why this library:

- Very small, no transitive dependencies.
- Automatically disables colors when the terminal does not support them or when `NO_COLOR` is set.
- Simple API: `pc.dim("text")`, `pc.cyan("text")`, etc.

We are **not** adding chalk or a full TUI framework. We are **not** changing `@meta-agent/core` for colors.

### Two visual channels

| Channel | When it appears | Look |
|--------|------------------|------|
| **Progress** | Always during agent runs | Calm, high-signal one-liners. Metadata dim; action text normal or slightly bright. |
| **Debug** | Only in debug mode | Clearly “diagnostic”: different prefix color, dimmer overall, payload separated from header. |

Progress should never look like debug. Debug should never be mistaken for user-facing progress.

### Metadata vs content on progress lines

Split each progress line into two parts before printing:

- **Metadata** (dim gray): short time, event kind or category, turn number, phase, duration, token counts.
- **Content** (default/bright): the human message — tool name, status (`ok` / `failed`), short error reason.

Example layout (colors described in words):

```
12:04:05  llm-turn-start  turn 2     LLM request…
12:04:08  tool-invoked    read_file  Executed in 42ms — success
```

Metadata columns are dim; the trailing message is the part you read first.

We do not need a full table aligner. Fixed-order fields with padding are enough for v1.

### Debug line layout

Debug lines use a different prefix and structure:

```
12:04:06  DEBUG  openai.chat.completion
            { … pretty-printed or truncated JSON … }
```

- Header line: dim capture-time + magenta `DEBUG` badge + yellow kind string. (No `[meta-agent:debug]` prefix — that string is removed.)
- Payload: indented, dim gray; use `JSON.stringify` with indentation when small enough.
- If payload is huge (e.g. full OpenAI completion), truncate with a **non-dim** note on its own line: `… (truncated, N chars total)` styled with `theme.debugTruncation` (normal or yellow), so it stands out against dim JSON. Full data remains in the trace file.

This keeps debug readable without dumping megabytes into the terminal.

### Status colors (progress only)

Color is driven by the `status` field on `ProgressLineParts`, not by scanning words inside `body`:

- `status: "pending"` → entire body in cyan (`progressLabel`)
- `status: "ok"` → entire body in green (`ok`)
- `status: "fail"` → entire body in red (`fail`)
- no status → default body color (`progressBody`)

`formatTraceEventParts` is responsible for wording; `writeProgressLine` only applies color based on `status`. This avoids fragile regex on composed strings.

### Debug timestamps

`DebugEvent` has no `ts` field. Debug header timestamps are **wall-clock capture time** (when the sink receives the event), not the time of the underlying LLM call. They are optional visual alignment with progress lines, not a second event clock.

**Decision for v1:** always emit capture time on debug headers (`new Date().toISOString()` at sink write). Progress lines use `TraceEvent.ts` (event time from the tracer). Document this distinction so readers do not assume the two columns are comparable event timestamps.

### What we are not changing

- No changes to `Tracer`, `AgentLoop`, or trace file format.
- No new observer pipeline or event bus.
- No coloring of agent final answers on stdout (`console.log(out)` in the REPL) in this plan.
- No coloring of `/tools` table output in this plan (can reuse the same theme later).
- Sandbox/registry stderr (`[meta-agent:sandbox]`, etc.) stay as-is for now.

---

## File structure

**New files**

- `packages/cli/src/terminal-theme.ts` — color helpers, `NO_COLOR` / TTY behavior via picocolors, shared style functions (`meta`, `progressBody`, `debugBadge`, `ok`, `fail`, `indent`).
- `packages/cli/src/terminal-write.ts` — `writeProgressLine(parts)` and `writeDebugEvent(kind, data, ts?)` that apply the theme and call `process.stderr.write`.
- `packages/cli/src/trace-progress.test.ts` — full `formatTraceEventParts` matrix (all kinds + default).
- `packages/cli/src/terminal-theme.test.ts` — `formatShortTime` + theme color on/off via subprocess (see Conventions).
- `packages/cli/src/terminal-write.test.ts` — `formatDebugPayload`, `writeDebugEvent`, `writeProgressLine` unit tests.

**Modified files**

- `packages/cli/package.json` — add `picocolors` dependency.
- `packages/cli/src/trace-progress.ts` — return structured parts (or a small object) instead of one flat string; include short time from `e.ts` where available.
- `packages/cli/src/repl.ts` — use `writeProgressLine` in the tracer observer instead of raw `stderr.write`.
- `packages/cli/src/resolve-debug.ts` — `createStderrDebugSink` uses `writeDebugEvent`; keep `resolveDebugEnabled` unchanged.
- `packages/cli/src/resolve-debug.test.ts` — expand `createStderrDebugSink` coverage (circular, JSON, truncation).

---

## Test coverage (required)

Every function with formatting logic gets direct unit tests. Manual smoke tests supplement but do not replace them.

### `formatShortTime` (`terminal-theme.test.ts`)

| Case | Input | Expected |
|------|-------|----------|
| UTC ISO | `2026-06-11T12:04:05.123Z` | `12:04:05` |
| Offset ISO | `2026-06-11T12:04:05.123+03:00` | `12:04:05` |
| Malformed | `not-a-timestamp` | `not-a-timestamp` (unchanged) |

### `theme` (`terminal-theme.test.ts`)

- **NO_COLOR subprocess:** output is plain text, no `\x1b[` escapes (see Task 1).
- **Colors enabled subprocess:** spawn without `NO_COLOR`, unset or clear it, assert `theme.ok("x")` output **contains** `\x1b[` (positive case).
- **Function map:** assert each theme function returns a string containing the input when `NO_COLOR=1` subprocess imports all of them (`meta`, `progressLabel`, `progressBody`, `ok`, `fail`, `debugBadge`, `debugKind`, `debugPayload`, `debugTruncation`, `indent`).

**Fragile cwd note:** subprocess tests use `cwd` = directory of `terminal-theme.test.ts` (`packages/cli/src/`) because `-e` inline scripts resolve `./terminal-theme.ts` relative to cwd, not to a file path. If the test file moves, update `cwd` or switch to a small fixture script beside the test.

### `formatTraceEventParts` (`trace-progress.test.ts`)

Use a shared helper `makeEvent(kind, data, ts?)` with default `ts: "2026-06-11T12:04:05.123Z"`.

| Kind | Assert |
|------|--------|
| `TRACE_KIND_LLM_TURN_START` | `label`, `detail` includes turn, `body` pending ellipsis, `status: "pending"` |
| `TRACE_KIND_LLM_SYNTHESIS_START` | `status: "pending"`, synthesis body text |
| `TRACE_KIND_TOOL_DISPATCH_START` | tool name in `detail`, `status: "pending"` |
| `TRACE_KIND_FACTORY_REPAIR_LLM` | repair body, `status: "pending"` |
| `TRACE_KIND_LLM_TURN` | turn in `detail`, token counts in `body`, no `status` |
| `TRACE_KIND_LLM_SYNTHESIS` | token counts in `body` when usage present |
| `TRACE_KIND_TOOL_CALL` ok | `status: "ok"`, tool name in `detail` |
| `TRACE_KIND_TOOL_CALL` fail + error | `status: "fail"`, error kind and message in `body` |
| `TRACE_KIND_TOOL_INVOKED` success | `status: "ok"`, duration in `body` |
| `TRACE_KIND_TOOL_INVOKED` fail | `status: "fail"` |
| `TRACE_KIND_EXECUTION_DENIED` | `status: "fail"`, reason in `body` when present |
| `"tool-rejected"` | `status: "fail"`, reason in `body` |
| `"tool-created"` | tool name in `detail`, positive body |
| `"factory-gen-draft"` | `status: "pending"` |
| `TRACE_KIND_LLM_CALL` | phase/method in `detail` or `body` |
| `default` (unknown kind) | `label` = kind string, `body` = `"event"` |

All cases: `time` === `12:04:05` when `ts` is the default UTC ISO string.

### `writeProgressLine` (`terminal-write.test.ts`)

Stub `process.stderr.write`, capture output. Tests run in-process; assert **structure** on captured string (strip ANSI with `/\x1b\[[0-9;]*m/g` before comparing if colors leak in).

| Case | Assert |
|------|--------|
| pending status | captured line contains `time`, `label`, body text; ends with `\n` |
| ok status | same structure; stripped line contains body text |
| fail status | same structure |
| metadata assembly | `detail` present → appears between label and body |

### `formatDebugPayload` (`terminal-write.test.ts`)

| Case | Assert |
|------|--------|
| Normal object | `truncated: false`, pretty JSON (`JSON.stringify` with indent) |
| Circular object | no throw; `truncated: false`; payload contains `Circular` or `self` |
| Under limit | object sized so string length **< 4000** → `truncated: false`, full payload |
| Over limit | object sized so string length **> 4000** → `truncated: true`, `payload.length === 4000`, `totalChars` > 4000 |
| Exactly at limit | object sized so string length **=== 4000** → `truncated: false` (truncate only when `length > DEBUG_PAYLOAD_MAX`, not `>=`) |

Build over-limit and at-limit fixtures by generating a string field of known length inside a test object.

### `writeDebugEvent` (`terminal-write.test.ts`)

Stub `process.stderr.write`, capture full output. Strip ANSI for structural assertions.

| Case | Assert |
|------|--------|
| Normal JSON | first line contains `DEBUG` and kind; payload lines start with two spaces; JSON key visible |
| Large payload | truncation line present with `truncated, N chars total`; payload body length capped |
| Small payload | no truncation line |

Use fixed `captureIsoTs: "2026-06-11T12:04:05.123Z"` so header time is predictable.

### `createStderrDebugSink` (`resolve-debug.test.ts`)

Keep existing `resolveDebugEnabled` tests. Add or extend sink tests:

| Case | Assert |
|------|--------|
| Circular payload | `DEBUG`, kind, inspect fallback (existing, updated) |
| Normal JSON | `DEBUG`, kind, indented JSON content (e.g. `"key": "value"`) on a separate line |
| Large payload via sink | truncation note with char count when data exceeds 4000 chars |

---

## Conventions

- **Run CLI tests:** from `packages/cli`: `npm test`
- **Typecheck:** from repo root: `npm run typecheck`
- **Manual smoke test:** `npm run cli -- --debug` and run a short agent task; confirm progress vs debug are visually distinct.
- **Testing colors:** `picocolors` reads `NO_COLOR` once at ESM import time. Setting `process.env.NO_COLOR` inside a test body does **not** disable colors on an already-imported module. Use one of:
  - **Subprocess** (preferred for theme tests): spawn `node --test` with `env: { NO_COLOR: "1" }` and assert stdout has no ANSI escape sequences.
  - **Direct field tests:** `trace-progress.test.ts` asserts `ProgressLineParts` string fields only — no color output.
  - **Stub writers:** `resolve-debug.test.ts` captures `process.stderr.write` and asserts plain substrings (`DEBUG`, kind name, payload content) — no color assertions needed.
- Commit after each task when tests pass.

---

## Task 1: Add picocolors and terminal theme

**Files:**
- Modify: `packages/cli/package.json`
- Create: `packages/cli/src/terminal-theme.ts`
- Create: `packages/cli/src/terminal-theme.test.ts`

- [ ] **Step 1: Add dependency**

In `packages/cli/package.json`, under `dependencies`:

```json
"picocolors": "^1.1.1"
```

Run from repo root: `npm install`

- [ ] **Step 2: Create `terminal-theme.ts`**

```ts
import pc from "picocolors";

export function formatShortTime(isoTs: string): string {
  // ISO "2026-06-11T12:04:05.123Z" or "2026-06-11T12:04:05.123+03:00" → "12:04:05"
  const m = isoTs.match(/T(\d{2}:\d{2}:\d{2})/);
  if (m) return m[1];
  // Fallback: if ts is malformed, show the raw string rather than a misleading date prefix
  return isoTs;
}

export const theme = {
  meta: (s: string) => pc.dim(s),
  progressLabel: (s: string) => pc.cyan(s),
  progressBody: (s: string) => s,
  ok: (s: string) => pc.green(s),
  fail: (s: string) => pc.red(s),
  debugBadge: () => pc.magenta("DEBUG"),
  debugKind: (s: string) => pc.yellow(s),
  debugPayload: (s: string) => pc.dim(s),
  debugTruncation: (s: string) => pc.yellow(s),
  indent: (s: string, spaces = 2) => " ".repeat(spaces) + s,
};
```

- [ ] **Step 3: Tests in `terminal-theme.test.ts`**

`picocolors` initializes its `enabled` flag at import time. Do **not** set `NO_COLOR` in the test file body and expect it to affect an already-loaded module.

**3a. `formatShortTime` (direct, in-process)**

```ts
import { formatShortTime } from "./terminal-theme.ts";

assert.equal(formatShortTime("2026-06-11T12:04:05.123Z"), "12:04:05");
assert.equal(formatShortTime("2026-06-11T12:04:05.123+03:00"), "12:04:05");
assert.equal(formatShortTime("not-a-timestamp"), "not-a-timestamp");
```

**3b. Subprocess helper**

`cwd` must be `packages/cli/src/` (directory of this test file). Inline `-e` scripts resolve `./terminal-theme.ts` relative to cwd — if the test file moves, fix `cwd` or use a fixture script file.

```ts
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

function runThemeScript(script: string, env: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", script],
    { cwd: SRC_DIR, env: { ...process.env, ...env } },
  );
}
```

**3c. NO_COLOR disables ANSI**

```ts
const r = runThemeScript(
  `import { theme } from "./terminal-theme.ts"; process.stdout.write(theme.meta("plain"));`,
  { NO_COLOR: "1" },
);
assert.equal(r.stdout.toString(), "plain");
assert.ok(!/\x1b\[/u.test(r.stdout.toString()));
```

**3d. Colors enabled (positive case)**

Spawn without `NO_COLOR` (delete it from env copy):

```ts
const env = { ...process.env };
delete env.NO_COLOR;
const r = runThemeScript(
  `import { theme } from "./terminal-theme.ts"; process.stdout.write(theme.ok("plain"));`,
  env,
);
assert.ok(/\x1b\[/u.test(r.stdout.toString()));
```

**3e. All theme functions return input under NO_COLOR**

One subprocess imports every theme function and writes concatenated results; assert no ANSI and output contains test markers for `meta`, `progressLabel`, `progressBody`, `ok`, `fail`, `debugBadge`, `debugKind`, `debugPayload`, `debugTruncation`, `indent`.

Run: `cd packages/cli && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/cli/package.json packages/cli/src/terminal-theme.ts packages/cli/src/terminal-theme.test.ts package-lock.json
git commit -m "cli: add picocolors terminal theme helpers"
```

---

## Task 2: Structured progress formatting

**Files:**
- Modify: `packages/cli/src/trace-progress.ts`
- Create: `packages/cli/src/trace-progress.test.ts`

- [ ] **Step 1: Define a small result type**

At the top of `trace-progress.ts`:

```ts
export type ProgressLineParts = {
  time: string;
  label: string;
  detail?: string;
  body: string;
  status?: "ok" | "fail" | "pending";
};
```

- [ ] **Step 2: Add `formatTraceEventParts` and remove `formatTraceEvent`**

New exported function that mirrors the existing `switch` and returns `ProgressLineParts`. Use `formatShortTime(e.ts)` for `time`. Map kinds to short labels, e.g. `llm-turn-start`, `tool-invoked`, `tool-call`. Put turn numbers and token info in `detail`. Put the readable message in `body`. Set `status` for completed tool/success/failure cases.

**Delete `formatTraceEvent`.** The only consumer is `repl.ts`, which Task 3 updates to call `formatTraceEventParts` directly. No backward-compat wrapper needed.

**Preserve behavior for unknown kinds.** Today every branch returns a non-null string; the `default` case returns `` `[meta-agent] ${e.kind}` ``. `formatTraceEventParts` must **not** return `null` for unknown kinds — use a `default` branch that returns parts, e.g.:

```ts
default:
  return {
    time: formatShortTime(e.ts),
    label: e.kind,
    body: "event",
  };
```

There are no silent skip cases today. Do not introduce `null` returns unless we explicitly add skip logic later.

Example for `TRACE_KIND_TOOL_INVOKED`:

```ts
return {
  time: formatShortTime(e.ts),
  label: "tool-invoked",
  detail: String(e.data.name ?? "unknown"),
  body: `Executed in ${e.data.duration}ms — ${e.data.ok ? "success" : "failed"}`,
  status: e.data.ok ? "ok" : "fail",
};
```

- [ ] **Step 3: Tests for parts (no ANSI)**

In `trace-progress.test.ts`, implement the full matrix in **Test coverage → `formatTraceEventParts`**. Use one `test()` per kind or grouped tests; every row in that table must have a corresponding assertion.

Helper:

```ts
function makeEvent(
  kind: string,
  data: Record<string, unknown> = {},
  ts = "2026-06-11T12:04:05.123Z",
): TraceEvent {
  return { ts, sessionId: "s", kind, data };
}
```

Example assertions:

```ts
const parts = formatTraceEventParts(makeEvent(TRACE_KIND_TOOL_INVOKED, { name: "read_file", duration: 42, ok: true }));
assert.equal(parts.time, "12:04:05");
assert.equal(parts.label, "tool-invoked");
assert.equal(parts.detail, "read_file");
assert.match(parts.body, /42ms/);
assert.equal(parts.status, "ok");

const failCall = formatTraceEventParts(makeEvent(TRACE_KIND_TOOL_CALL, {
  name: "bad_tool", ok: false,
  result: { ok: false, error: { kind: "runtime_error", message: "boom" } },
}));
assert.equal(failCall.status, "fail");
assert.match(failCall.body, /runtime_error/);
assert.match(failCall.body, /boom/);

const unknown = formatTraceEventParts(makeEvent("workflow-start", {}));
assert.equal(unknown.label, "workflow-start");
assert.equal(unknown.body, "event");
```

Run: `cd packages/cli && npm test`
Expected: PASS — all 16 rows from the coverage table asserted

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/trace-progress.ts packages/cli/src/trace-progress.test.ts
git commit -m "cli: structured trace progress line parts"
```

---

## Task 3: Write progress lines with colors

**Files:**
- Create: `packages/cli/src/terminal-write.ts`
- Create: `packages/cli/src/terminal-write.test.ts` (progress tests; debug tests added in Task 4)
- Modify: `packages/cli/src/repl.ts`

- [ ] **Step 1: Implement `writeProgressLine`**

Color the **entire body** from `status` — no regex word-scanning on `body`:

```ts
import type { ProgressLineParts } from "./trace-progress.ts";
import { theme } from "./terminal-theme.ts";

function styleProgressBody(parts: ProgressLineParts): string {
  switch (parts.status) {
    case "ok":
      return theme.ok(parts.body);
    case "fail":
      return theme.fail(parts.body);
    case "pending":
      return theme.progressLabel(parts.body);
    default:
      return theme.progressBody(parts.body);
  }
}

export function writeProgressLine(parts: ProgressLineParts): void {
  const meta = theme.meta(
    `${parts.time}  ${parts.label}${parts.detail ? `  ${parts.detail}` : ""}`,
  );
  const body = styleProgressBody(parts);
  process.stderr.write(`${meta}  ${body}\n`);
}
```

- [ ] **Step 2: Wire repl observer**

In `repl.ts`, replace:

```ts
const line = formatTraceEvent(e);
if (line) process.stderr.write(line + "\n");
```

with:

```ts
import { formatTraceEventParts } from "./trace-progress.ts";
import { writeProgressLine } from "./terminal-write.ts";

// inside observer:
writeProgressLine(formatTraceEventParts(e));
```

Also remove the `formatTraceEvent` import from `repl.ts`.

- [ ] **Step 3: Unit tests for `writeProgressLine`**

In `terminal-write.test.ts`, stub stderr and assert structure per **Test coverage → `writeProgressLine`**:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeProgressLine } from "./terminal-write.ts";

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  };
  try { fn(); } finally { process.stderr.write = orig; }
  return chunks.join("");
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("writeProgressLine: assembles meta, detail, body, newline", () => {
  const out = captureStderr(() =>
    writeProgressLine({
      time: "12:04:05",
      label: "tool-invoked",
      detail: "read_file",
      body: "Executed in 42ms — success",
      status: "ok",
    }),
  );
  const plain = stripAnsi(out);
  assert.ok(plain.endsWith("\n"));
  assert.match(plain, /12:04:05/);
  assert.match(plain, /tool-invoked/);
  assert.match(plain, /read_file/);
  assert.match(plain, /Executed in 42ms/);
});

test("writeProgressLine: pending status includes body text", () => {
  const out = stripAnsi(captureStderr(() =>
    writeProgressLine({ time: "12:04:05", label: "llm-turn-start", detail: "2", body: "LLM request…", status: "pending" }),
  ));
  assert.match(out, /LLM request/);
});
```

Add cases for `fail` status and missing `detail`.

Run: `cd packages/cli && npm test`
Expected: PASS

- [ ] **Step 4: Manual smoke test**

Run: `npm run cli` (no debug), submit a short task.

Expected: dim timestamp and labels on the left; readable action text on the right; green/red for success/failure.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/terminal-write.ts packages/cli/src/terminal-write.test.ts packages/cli/src/repl.ts
git commit -m "cli: colorize progress lines on stderr"
```

---

## Task 4: Colorize debug sink output

**Files:**
- Modify: `packages/cli/src/resolve-debug.ts`
- Modify: `packages/cli/src/resolve-debug.test.ts`
- Modify: `packages/cli/src/terminal-write.ts`

- [ ] **Step 1: Payload formatting helper**

In `terminal-write.ts`, add (note `util` import):

```ts
import util from "node:util";
import { formatShortTime, theme } from "./terminal-theme.ts";

const DEBUG_PAYLOAD_MAX = 4000;

export function formatDebugPayload(data: unknown): { payload: string; truncated: boolean; totalChars?: number } {
  let payload: string;
  try {
    payload = JSON.stringify(data, null, 2);
  } catch {
    payload = util.inspect(data, { depth: 6, maxArrayLength: 100, breakLength: 120 });
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
```

- [ ] **Step 2: `writeDebugEvent`**

Always pass capture time from the sink (see Step 3). Style truncation note separately from dim payload:

```ts
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
```

- [ ] **Step 3: Update `createStderrDebugSink`**

Replace the single-line `process.stderr.write` with:

```ts
return (event: DebugEvent) => {
  writeDebugEvent(event.kind, event.data, new Date().toISOString());
};
```

`DebugEvent` has no event-time field; `captureIsoTs` is wall-clock time at sink write.

- [ ] **Step 4: Unit tests in `terminal-write.test.ts`**

Add tests per **Test coverage → `formatDebugPayload`** and **`writeDebugEvent`**:

```ts
test("formatDebugPayload: normal JSON", () => {
  const r = formatDebugPayload({ key: "value" });
  assert.equal(r.truncated, false);
  assert.match(r.payload, /"key"/);
  assert.match(r.payload, /\n/); // pretty-printed
});

test("formatDebugPayload: circular uses inspect", () => {
  const o: Record<string, unknown> = {};
  o.self = o;
  const r = formatDebugPayload(o);
  assert.equal(r.truncated, false);
  assert.match(r.payload, /Circular|self/);
});

test("formatDebugPayload: over limit truncates at 4000", () => {
  const big = { pad: "x".repeat(5000) };
  const r = formatDebugPayload(big);
  assert.equal(r.truncated, true);
  assert.equal(r.payload.length, 4000);
  assert.ok(r.totalChars! > 4000);
});

test("formatDebugPayload: exactly 4000 chars not truncated", () => {
  // Find pad length so JSON.stringify({ a: "x".repeat(padLen) }, null, 2).length === 4000
  let padLen = 0;
  for (let n = 3900; n <= 4100; n++) {
    if (JSON.stringify({ a: "x".repeat(n) }, null, 2).length === 4000) {
      padLen = n;
      break;
    }
  }
  assert.ok(padLen > 0, "fixture must exist");
  const r = formatDebugPayload({ a: "x".repeat(padLen) });
  assert.equal(r.truncated, false);
  assert.equal(r.payload.length, 4000);
});

test("writeDebugEvent: header and indented payload", () => {
  const out = stripAnsi(captureStderr(() =>
    writeDebugEvent("test.kind", { foo: 1 }, "2026-06-11T12:04:05.123Z"),
  ));
  const lines = out.trimEnd().split("\n");
  assert.match(lines[0], /12:04:05/);
  assert.match(lines[0], /DEBUG/);
  assert.match(lines[0], /test\.kind/);
  assert.ok(lines[1].startsWith("  ")); // indented payload
  assert.match(out, /"foo"/);
});

test("writeDebugEvent: truncation line only when needed", () => {
  const big = { pad: "y".repeat(5000) };
  const out = stripAnsi(captureStderr(() =>
    writeDebugEvent("big", big, "2026-06-11T12:04:05.123Z"),
  ));
  assert.match(out, /truncated, \d+ chars total/);
});
```

- [ ] **Step 5: Expand `resolve-debug.test.ts`**

**Breaking change:** the `[meta-agent:debug]` prefix is removed.

Keep `resolveDebugEnabled` tests unchanged. Extend sink tests per **Test coverage → `createStderrDebugSink`**:

```ts
function captureSinkOutput(event: DebugEvent): string {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    createStderrDebugSink()(event);
  } finally {
    process.stderr.write = orig;
  }
  return lines.join("");
}

test("createStderrDebugSink: circular payload", () => {
  const o: Record<string, unknown> = {};
  o.self = o;
  const out = captureSinkOutput({ kind: "circular", data: o });
  assert.match(out, /DEBUG/);
  assert.match(out, /circular/);
  assert.match(out, /Circular|self/);
});

test("createStderrDebugSink: normal JSON on indented lines", () => {
  const out = captureSinkOutput({ kind: "openai.chat.completion", data: { id: "abc" } });
  assert.match(out, /DEBUG/);
  assert.match(out, /openai\.chat\.completion/);
  assert.match(out, /"id"/);
  assert.match(out, /\n  /); // indented payload line
});

test("createStderrDebugSink: large payload shows truncation", () => {
  const out = captureSinkOutput({ kind: "huge", data: { pad: "z".repeat(5000) } });
  assert.match(out, /truncated, \d+ chars total/);
});
```

Run: `cd packages/cli && npm test`
Expected: PASS

- [ ] **Step 6: Manual smoke test with debug**

Run: `npm run cli -- --debug`, run a short task.

Expected: progress lines look like Task 3; debug blocks are clearly separate (magenta DEBUG badge, indented JSON), and do not blend with progress lines.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/resolve-debug.ts packages/cli/src/resolve-debug.test.ts packages/cli/src/terminal-write.ts packages/cli/src/terminal-write.test.ts
git commit -m "cli: colorize and structure debug stderr output"
```

---

## Task 5: Documentation and final verification

**Files:**
- Modify: `docs/configuration.md` (file exists; add a short section on terminal colors)

- [ ] **Step 1: Document color behavior**

Add a section to the existing `docs/configuration.md`:

- Progress is always colored when the terminal supports it.
- Debug output is only shown with `--debug` or `META_AGENT_DEBUG=1`.
- Colors respect `NO_COLOR` and non-TTY stderr (picocolors default).
- Progress line timestamps come from trace events (`TraceEvent.ts`); debug header timestamps are wall-clock capture time at print.
- Full LLM payloads remain in trace files; stderr debug may truncate with a visible non-dim truncation note.

- [ ] **Step 2: Full verification**

```bash
npm run typecheck
cd packages/cli && npm test
```

- [ ] **Step 3: Commit**

```bash
git add docs/configuration.md
git commit -m "docs: note CLI progress and debug terminal colors"
```

---

## Task 6: Colorize approval and tool-call prompts

**Files:**
- Create: `packages/cli/src/approval-format.ts`
- Create: `packages/cli/src/approval-format.test.ts`
- Modify: `packages/cli/src/approval-tui.ts`
- Modify: `packages/cli/src/terminal-theme.ts` (add `bold` for `[A]` key)
- Modify: `docs/configuration.md` (note approval prompt colors)

**Goal:** Gate 1 and Gate 2/3 approval blocks use the same metadata-vs-content pattern as progress lines. Choice keys are color-coded so `a` / `s` / `r` (and Gate 1 `A`) stand out in the prompt.

**Visual design:**
- Section header (`=== GATE 2/3: … ===`) — cyan (`progressLabel`)
- Labels (`Args:`, `Permissions:`) — dim (`meta`)
- Values (JSON args, permissions) — default body color
- Choice prompt keys:
  - `[a]` approve — green (`ok`)
  - `[A]` always-approve (Gate 1) — bold green
  - `[s]` session — cyan (`progressLabel`)
  - `[r]` reject — red (`fail`)

**Bracket convention:** existing text `[a]pprove-once` keeps the shared letter: colored `[a]` + plain suffix `pprove-once`.

- [ ] **Step 1:** Add `bold` to `theme`; create `approval-format.ts` with `formatGate23Header`, `formatLabelValue`, `formatGate23ChoicePrompt`, `formatGate1ChoicePrompt`, and Gate 1 header/field helpers.
- [ ] **Step 2:** Update `approval-tui.ts` to print colored lines and pass colored prompts to `rl.question`.
- [ ] **Step 3:** Tests in `approval-format.test.ts` — strip ANSI, assert keys and labels present; assert stripped prompt contains `approve-once`, `session-approve`, `reject`.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`.

---

## Task 7: Colorize sandbox debug lines

**Files:**
- Modify: `packages/core/src/sandbox/sandbox-debug.ts` — optional `SandboxDebugSink` hook; plain-text fallback when unset (child processes, tests).
- Modify: `packages/core/src/index.ts` — export `setSandboxDebugSink`, `SandboxDebugSink`.
- Create: `packages/cli/src/sandbox-log-format.ts` — `writeSandboxLogLine` using `terminal-theme`.
- Create: `packages/cli/src/sandbox-log-format.test.ts`
- Modify: `packages/cli/src/repl.ts` — register sink at REPL startup.
- Modify: `packages/cli/src/terminal-theme.ts` — `sandboxBadge`.
- Modify: `docs/configuration.md`

**Visual design** (same rules as progress/debug channels):
- Magenta `SANDBOX` badge (like `DEBUG`, replaces `[meta-agent:sandbox]` when sink is active).
- Message — cyan (`progressLabel`) for normal diagnostic lines.
- Detail (`tool=… op=…`) — dim (`meta`), after ` — ` separator.
- Errors (`sandboxLogError`) — red message (`fail`), same badge and dim detail.

Child runner processes keep plain `[meta-agent:sandbox]` fallback (no CLI hook registered).

- [ ] **Step 1:** Core sink hook + exports.
- [ ] **Step 2:** CLI formatter + tests.
- [ ] **Step 3:** Register in `repl.ts`; document in configuration.md.
- [ ] **Step 4:** `npm test` + `npm run typecheck`.

---

## Future follow-ups (out of scope)

- Reuse `terminal-theme` for `/tools` table headers.
- Align registry debug prefixes with the same channel style.
- Optional `--no-color` CLI flag mirroring `NO_COLOR` for users who want plain text without setting env vars.
- Show progress on stdout instead of stderr if we add a structured logging mode later.

---

## Self-review checklist

| Requirement | Covered by |
|-------------|------------|
| Minimal color dependency | Task 1 — picocolors in CLI only |
| Metadata vs content distinction | Tasks 2–3 — `ProgressLineParts` + `writeProgressLine` |
| Debug vs progress distinction | Tasks 3–4 — separate writers and color schemes |
| Debug mode readability | Task 4 — multi-line indented payload, non-dim truncation note |
| No architecture change | All changes in `packages/cli`; core event flow unchanged |
| Plain English plan | This document |
| NO_COLOR test strategy | Conventions + Task 1 subprocess test |
| Unknown trace kinds preserved | Task 2 — `default` branch returns parts, not `null` |
| Status color from `status` field | Task 3 — `styleProgressBody`, no body regex |
| Debug timestamp semantics | Design section + Task 4 capture time |
| `resolve-debug.test.ts` prefix change | Task 4 Step 5 — explicit breaking change note |
| Test coverage — formatDebugPayload | Test coverage table + Task 4 Step 4 |
| Test coverage — formatTraceEventParts (all kinds) | Test coverage table + Task 2 Step 3 |
| Test coverage — writeDebugEvent / writeProgressLine | Test coverage table + Tasks 3–4 |
| Test coverage — formatShortTime + theme | Test coverage table + Task 1 Step 3 |
| Test coverage — createStderrDebugSink paths | Test coverage table + Task 4 Step 5 |
| Approval prompt colorization | Task 6 |
| Sandbox debug colorization | Task 7 |
