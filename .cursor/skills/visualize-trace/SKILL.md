---
name: visualize-trace
description: >-
  Parses a meta-agent JSONL trace file and writes a self-contained HTML report with
  a nested execution-flow tree (turns, dispatches, workflows, steps), color-coded
  step cards, collapsible raw events, and optional config/analysis sections. Use when
  the user asks to visualize a trace, explain a trace flow, generate a trace report,
  or provides a trace file path and output path for documentation.
---

# Visualize trace

Generate a **self-contained HTML report** from a meta-agent session trace (`.jsonl`).

The **primary output** is a **nested execution flow**: every trace event as a color-coded step card, indented under its parent (turn → dispatch → workflow → step). Raw payloads live in collapsed `<details>` blocks; summaries stay scannable.

## Required inputs

Both are **mandatory**. If either is missing, ask before proceeding.

| Input | Description |
|-------|-------------|
| **Trace file path** | Path to the `.jsonl` trace (e.g. `tmp/tmp/traces/2026-06-09T14-39-54-058Z-mq6qxs5m.jsonl`) |
| **Output path** | Where to write the HTML report (e.g. `tmp/trace_report.html`) |

## Optional input

| Input | Description |
|-------|-------------|
| **Config file path** | Path to the meta-agent JSON config used for the session. If omitted, the header shows **Configuration unknown**. |

## Quick checklist

```
Visualize trace
- [ ] Step 1: Read trace file (all lines)
- [ ] Step 2: Run generate-trace-html.py (preferred) OR build tree manually
- [ ] Step 3: Verify output — nesting, colors, collapsed raw events
- [ ] Step 4: Tell user the output path (`open path/to/report.html`)
```

## Workflow

### Step 1 — Read the trace

1. Read the entire trace file (JSONL: one JSON object per line).
2. Skip blank lines. Parse each line as `{ ts, sessionId, kind, data }`.
3. If parse fails on a line, note it when building analysis (truncated/corrupt trace).
4. Record first/last `ts`, `sessionId`, and trace basename for the header.

### Step 2 — Generate HTML (preferred)

**Always prefer the generator script** — it implements the canonical nested layout:

```bash
python3 .cursor/skills/visualize-trace/generate-trace-html.py TRACE.jsonl OUTPUT.html
python3 .cursor/skills/visualize-trace/generate-trace-html.py TRACE.jsonl OUTPUT.html --config CONFIG.json
python3 .cursor/skills/visualize-trace/generate-trace-html.py TRACE.jsonl OUTPUT.html --no-analysis
```

The script:

1. Parses events and builds the nested tree ([nested-flow.md](nested-flow.md))
2. Renders step cards with kind colors, meta grids, and compact raw JSON
3. Fills [report-template.html](report-template.html) and writes the output path

**Manual fallback** (script unavailable): follow [nested-flow.md](nested-flow.md) exactly and fill `report-template.html` placeholders yourself. Do not invent a different layout.

### Step 3 — Verify output

Confirm all of the following before telling the user the report is ready:

| Check | Expected |
|-------|----------|
| File exists at requested output path | Yes |
| No unresolved `{{PLACEHOLDER}}` tokens | None |
| Every trace event appears once | Count matches JSONL line count |
| Turns nest LLM + dispatch children | `llm-turn-start` is parent of turn events |
| Workflows nest under dispatch | `workflow-start` inside `tool-dispatch-start` for composites |
| Steps nest workflow internals | `tool-invoked` / capability `llm-call` inside `workflow-step-start` |
| Raw events collapsed | Each step has `<details class="raw">`; LLM bodies not inline |
| Kind accent colors | Match table in [nested-flow.md](nested-flow.md) |
| Opens standalone | No CDN, no JavaScript, no external assets |

Tell the user: `open path/to/report.html`

## Nested tree rules (summary)

Full spec: [nested-flow.md](nested-flow.md). Event kinds: [trace-kinds.md](trace-kinds.md).

```
llm-turn-start          → root turn block
  llm-call, llm-turn    → children of turn
  tool-dispatch-start   → child of turn
    workflow-start      → child of dispatch
      workflow-step-start → child of workflow
        tool-invoked, llm-call (capability), workflow-step-end → children of step
      workflow-end      → child of workflow
    tool-call           → child of dispatch (after workflow)
llm-synthesis-start     → root synthesis block
  llm-call (synthesis), llm-synthesis → children
```

## Step card format

Each event renders as:

```html
<article class="step nested" style="--accent:#58a6ff" data-kind="llm-turn-start">
  <header class="head">
    <span class="num">1</span>
    <span class="badge">llm-turn-start</span>
    <h3>Turn 0 start</h3>
    <time>14:41:48.847</time>
  </header>
  <dl class="meta-grid">…</dl>          <!-- optional, kind-specific -->
  <details class="raw"><summary>Raw event</summary><pre>…</pre></details>
  <div class="children">…nested steps…</div>
</article>
```

Patterns and title rules: [step-format.md](step-format.md) (formerly svg-defaults.md).

## Display rules

- **Truncate** inline strings at **60 characters** with `…` (meta grid, titles)
- **Collapsible raw JSON** on every step — default collapsed
- **Compact `llm-call` raw data** — never include `request.messages`; truncate response content/args
- **Never omit** when present in trace: refs, error kinds, byte counts, durations, token usage
- **Do not invent** events or values not in the trace

## Optional sections

The generator includes by default:

| Section | When |
|---------|------|
| Configuration table | `--config` path provided |
| Analysis findings | unless `--no-analysis`; basic heuristics from [analysis-heuristics.md](analysis-heuristics.md) |

For deeper analysis (reference chains, SVG dependency graphs, narrative prose), extend the report **below** the execution flow — do not replace or flatten the nested tree.

## Kind accent colors

| Color | Kinds |
|-------|-------|
| `#58a6ff` | turn start/end |
| `#bc8cff` | llm-call |
| `#39c5cf` | tool dispatch/call |
| `#3fb950` | tool-invoked |
| `#d29922` | workflow start/end |
| `#e3b341` | workflow step start/end |
| `#f85149` | synthesis, execution-denied, tool-rejected |
| `#8b949e` | factory events |

## Additional resources

- [generate-trace-html.py](generate-trace-html.py) — canonical generator (run this first)
- [nested-flow.md](nested-flow.md) — tree algorithm, titles, compact raw JSON
- [step-format.md](step-format.md) — HTML step card patterns
- [report-template.html](report-template.html) — HTML skeleton with placeholders
- [trace-kinds.md](trace-kinds.md) — all event kinds and `data` fields
- [config-format.md](config-format.md) — optional agent config flattening
- [analysis-heuristics.md](analysis-heuristics.md) — issue patterns for analysis section
- [diagrams.md](diagrams.md) — optional SVG diagrams (secondary to nested flow)

## Example invocation

**User:** "Visualize `tmp/tmp/traces/foo.jsonl` to `tmp/report.html`"

**Agent:** Read skill → run `generate-trace-html.py` → verify → confirm path.

**User:** "Visualize `tmp/traces/foo.jsonl` to `tmp/report.html` using config `tmp/meta-agent.json`"

**Agent:** Read skill → run generator with `--config` → verify → confirm path.
