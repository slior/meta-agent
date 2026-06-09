---
name: visualize-trace
description: >-
  Parses a meta-agent JSONL trace file and writes a self-contained HTML report with
  narrative, SVG flow diagrams, reference chains, issue analysis, and optional agent
  configuration. Use when the user asks to visualize a trace, explain a trace flow,
  generate a trace report, or provides a trace file path and output path for documentation.
---

# Visualize trace

Generate a **self-contained HTML report** from a meta-agent session trace (`.jsonl`).

## Required inputs

Both are **mandatory**. If either is missing, ask before proceeding.

| Input | Description |
|-------|-------------|
| **Trace file path** | Path to the `.jsonl` trace (e.g. `tmp/tmp/traces/2026-06-09T14-39-54-058Z-mq6qxs5m.jsonl`) |
| **Output path** | Where to write the HTML report (e.g. `tmp/trace_report.html`) |

## Optional input

| Input | Description |
|-------|-------------|
| **Config file path** | Path to the meta-agent JSON config used for the session (e.g. `config/meta-agent.example.json`, `tmp/meta-agent.json`). If omitted, the Overview shows **Configuration unknown**. |

## Quick checklist

Copy and track progress:

```
Visualize trace
- [ ] Step 1: Read trace file (all lines)
- [ ] Step 1b: Read config file (if path given)
- [ ] Step 2: Parse events and build session model
- [ ] Step 3: Segment user tasks and interludes
- [ ] Step 4: Extract refs, workflows, failures
- [ ] Step 5: Write narrative (turn-by-turn)
- [ ] Step 6: Build SVG diagrams
- [ ] Step 7: Run analysis heuristics
- [ ] Step 8: Fill report-template.html → write output
- [ ] Step 9: Verify output file exists and opens standalone
```

## Workflow

### Step 1 — Read the trace

1. Read the entire trace file (JSONL: one JSON object per line).
2. Skip blank lines. Parse each line as `{ ts, sessionId, kind, data }`.
3. If parse fails on a line, note it in Analysis as **Warning** (truncated/corrupt trace).
4. Record **first** and **last** `ts` for the header; **sessionId** from any event; basename of trace file for footer.

Large files: read in chunks, but **every line** must be represented in the event timeline (Step 8).

### Step 1b — Read agent configuration (optional)

1. If the user **did not** provide a config file path → set `{{CONFIG_SECTION_HTML}}` to the **unknown** template in [config-format.md](config-format.md).
2. If a config path **was** provided:
   - Read and parse the JSON file.
   - Flatten all keys to dot notation (see [config-format.md](config-format.md)).
   - Build the configuration table HTML; include source basename.
   - On read/parse error → use the **error** template; add an Info finding in Analysis.
3. Use config values when analyzing the trace (e.g. `yolo: false` explains `execution-denied` events; `maxTurns` vs actual turn count).

### Step 2 — Build the session model

Walk events in order. For each event, classify using [trace-kinds.md](trace-kinds.md).

Track:

- **Turns**: pair `llm-turn-start` / `llm-turn` by `data.turn`
- **Tool calls**: `tool-dispatch-start` → optional workflow events → `tool-invoked` → `tool-call`
- **LLM calls**: `llm-call` with `data.phase` (orchestration, capability, synthesis, factory-*)
- **Workflows**: nest `workflow-step-*` between `workflow-start` and `workflow-end`
- **Refs**: from `tool-call.result.ref` and `$ref` in subsequent `tool-call.args`
- **Factory**: `tool-created`, `tool-rejected`, `factory-gen-draft`, `factory-repair-llm`
- **Denials**: `execution-denied`

### Step 3 — Segment user tasks

Split the session into **segments**:

| Segment type | How to detect |
|--------------|---------------|
| **User task** | Starts at first event or at `llm-turn-start` with `turn: 0` after prior `llm-synthesis` |
| **Interlude** | Events between tasks with no new user message: `tool-created`, `tool-rejected`, factory events |

For each user task, extract:

- **User message** — from first orchestration `llm-call` in segment: last `role: "user"` in `request.messages` (ignore recovery hints and system prompts)
- **Turns** — orchestration cycles from turn 0 through `stop` + synthesis
- **Outcome** — synthesis text or final successful tool results

Label tasks **Task 1**, **Task 2**, … Interludes get a descriptive badge (e.g. `tool lift`, `factory`).

### Step 4 — Extract data dependencies

Build a **reference table** (all `r_*` bindings):

| Ref | Produced by | Consumed by |
|-----|-------------|-------------|

Rules:

- Producer = `tool-call` or workflow step that emitted `result.ref` or composite output ref
- Consumer = later `tool-call` whose `args` contain `{ "$ref": "…", "path": "…" }`
- Include workflow-internal refs when visible in trace

### Step 5 — Write the narrative

For **each segment**, write plain-language prose a human can follow.

**Per orchestration turn**, include:

1. **Reasoning** — why the agent picked this tool (catalog match, recovery, composite, etc.)
2. **Tools called** — meta-tool name and underlying registry tool if `invoke_tool`
3. **Args** — show values; **truncate strings longer than 20 chars** with `…` in summary text
4. **Result** — `ok` / error, ref name, key metrics (bytes, duration, token usage)
5. **Data passed** — explicit `$ref` and `path` between steps

**Workflow segments**: describe each `workflow-step-start` → `workflow-step-end` with `tool`, `durationMs`, and data flow (fetch text → llm summary → write path).

**Interludes**: who approved/rejected, tool name, hash if present.

Use HTML turn cards (see [svg-defaults.md](svg-defaults.md)). Put long JSON, full LLM bodies, and complete `result.value` inside `<details>` collapsibles.

### Step 6 — Build SVG diagrams

Requirements:

- **Self-contained inline SVG** only — no Mermaid, no CDN, no JavaScript
- Follow colors and patterns in [diagrams.md](diagrams.md)
- Use unique marker ids per diagram on the page

Minimum diagrams:

| Diagram | When |
|---------|------|
| Per-task flow | One per user task — manual chain, composite, or recovery branch |
| Ref dependency graph | When session has 2+ refs or 2+ tasks |
| Workflow expansion | When `workflow-start` appears — dashed box with steps |

Label edges with ref names (`.text`, `$ref`) and truncated URLs/paths.

### Step 7 — Analyze issues

Apply every heuristic in [analysis-heuristics.md](analysis-heuristics.md). For each finding:

- Assign **Critical**, **Warning**, or **Info**
- Cite evidence: `ts`, `kind`, and short quote
- State impact and **suggested fix**

Render findings as `.finding` blocks (see analysis-heuristics.md HTML pattern).

**Observations** section: neutral patterns (efficiency, good `$ref` usage, successful recovery) — separate from issues.

If no issues: say so explicitly; still list 1–2 positive observations.

### Step 8 — Fill the template and write output

1. Read [report-template.html](report-template.html) — **do not invent a new layout**
2. Replace every `{{PLACEHOLDER}}`:

| Placeholder | Content |
|-------------|---------|
| `{{SESSION_ID}}` | From trace |
| `{{TRACE_BASENAME}}` | Filename only |
| `{{START_TIME}}` / `{{END_TIME}}` | Short local or ISO time from first/last event |
| `{{OVERVIEW_PARAGRAPH}}` | 2–4 sentences: task count, main tools, arc of session |
| `{{CONFIG_SECTION_HTML}}` | Configuration subsection — see [config-format.md](config-format.md) |
| `{{TASK_SECTIONS_HTML}}` | All task + interlude `<section>` blocks |
| `{{REF_TABLE_ROWS}}` | `<tr>…</tr>` rows |
| `{{SVG_REF_DEPENDENCY_GRAPH}}` | Custom SVG for this session |
| `{{ANALYSIS_SUMMARY}}` | 1–2 sentence analysis overview |
| `{{FINDINGS_HTML}}` | Finding cards |
| `{{OBSERVATIONS_LIST_HTML}}` | `<ul><li>…</li></ul>` |
| `{{EVENT_COUNT}}` | Line count |
| `{{TIMELINE_ROWS_HTML}}` | One `.timeline-row` per event |

3. Write the filled HTML to the **output path** (create parent dirs if needed).
4. Ensure the file is valid HTML5, standalone, no external assets.

### Step 9 — Verify

- Output file exists at the requested path
- Placeholders are fully replaced (no `{{` left)
- Report includes: Overview (with Configuration subsection), ≥1 task section, Analysis, Event timeline
- Tell the user the output path and how to open it (`open path/to/report.html`)

## Display rules

- **Truncate** inline arg values at **20 characters** with `…`
- **Collapsible** (`<details>`) for: full JSON results, `llm-call` bodies, errors, previews longer than 3 lines
- **Never omit** refs, error kinds, byte counts, durations, or token usage when present in trace
- **Do not invent** events or values not in the trace

## Tool tag CSS classes

| Class | Use for |
|-------|---------|
| `tool-orchestrator` | stop, synthesis |
| `tool-fetch` | fetch-webpage-text, fetch-rss-feed |
| `tool-llm` | llm_generate |
| `tool-write` | write-file-text |
| `tool-meta` | find_tool, list_tools, propose_* |
| `tool-composite` | composite / workflow invoke |
| `tool-error` | failed calls, schema violations |
| `tool-factory` | tool-created, tool-rejected, factory-* |

## Additional resources

- [config-format.md](config-format.md) — optional agent config flattening and HTML templates
- [trace-kinds.md](trace-kinds.md) — all event kinds and `data` fields
- [analysis-heuristics.md](analysis-heuristics.md) — issue patterns and fixes
- [diagrams.md](diagrams.md) — SVG layout patterns
- [svg-defaults.md](svg-defaults.md) — HTML snippets for turn cards and timeline rows
- [report-template.html](report-template.html) — deterministic HTML skeleton

## Example invocation

**User:** "Visualize `tmp/tmp/traces/foo.jsonl` to `tmp/report.html`"

**Agent:** Read skill → parse trace → config unknown → fill template → write `tmp/report.html` → confirm.

**User:** "Visualize `tmp/traces/foo.jsonl` to `tmp/report.html` using config `tmp/meta-agent.json`"

**Agent:** Read skill → parse trace → flatten config → fill template → write report → confirm.
