# Nested execution flow

The **primary deliverable** of trace visualization is a nested step tree rendered as HTML cards. Every event appears exactly once, in trace order, inside the correct parent container.

## Tree rules

Walk events in order. Maintain pointers to the current turn, dispatch, workflow, and workflow step.

| Event kind | Container | Action |
|------------|-----------|--------|
| `llm-turn-start` | root | Start new turn block; reset dispatch/workflow/step |
| `llm-synthesis-start` | root | Start synthesis block; nest following synthesis events until `llm-synthesis` |
| `tool-dispatch-start` | current turn | Start dispatch block under turn |
| `workflow-start` | current dispatch (else turn) | Start workflow under dispatch |
| `workflow-step-start` | current workflow | Start step under workflow |
| `workflow-step-end` | current step | Append as child of open step; clear step pointer |
| `workflow-end` | current workflow | Append as child of workflow; clear workflow/step |
| everything else | innermost open container | Append to step → workflow → dispatch → turn |

**Nesting example** (successful composite invoke):

```
Turn 3
  LLM (orchestration)
  Turn 3 end
  Dispatch · invoke_tool
    Workflow · summarize_online_paper
      Step · step_0_fetch_webpage_text
        tool-invoked · fetch-webpage-text
        workflow-step-end
      Step · step_1_llm_generate
        LLM (capability)
        tool-invoked · llm_generate
        workflow-step-end
      Step · step_2_write_file_text
        tool-invoked · write-file-text
        workflow-step-end
      workflow-end
  tool-call · invoke_tool ✓
```

## Step card structure

Each event becomes an `<article class="step">` with:

1. **Header** — sequential `#`, kind badge, human title, timestamp
2. **Meta grid** (`<dl class="meta-grid">`) — kind-specific summary fields (never full LLM bodies)
3. **Raw event** — `<details class="raw">` with compact JSON (collapsed by default)
4. **Children** — `<div class="children">` with dashed left border for nested steps

Add class `nested` on steps that have children.

## Kind accent colors

Set `style="--accent: COLOR"` on each step. Use this map:

| Kind(s) | Color | Label |
|---------|-------|-------|
| `llm-turn-start`, `llm-turn` | `#58a6ff` | turn |
| `llm-call` | `#bc8cff` | llm |
| `tool-dispatch-start`, `tool-call` | `#39c5cf` | tool |
| `tool-invoked` | `#3fb950` | invoked |
| `workflow-start`, `workflow-end` | `#d29922` | workflow |
| `workflow-step-start`, `workflow-step-end` | `#e3b341` | step |
| `llm-synthesis-start`, `llm-synthesis` | `#f85149` | synthesis |
| `execution-denied`, `tool-rejected` | `#f85149` | error |
| `tool-created`, factory kinds | `#8b949e` | factory |

## Human titles

Titles appear in the step header `<h3>`. Keep them scannable; put detail in the meta grid or raw block.

| Kind | Title pattern |
|------|---------------|
| `llm-turn-start` | `Turn {n} start` |
| `llm-turn` | `Turn {n} end · {prompt}/{completion} tokens` |
| `llm-call` | `LLM ({phase}) → {tool names or "response"} · {prompt}/{completion} tok` |
| `tool-dispatch-start` | `Dispatch · {name}` |
| `tool-call` | `{name} → {inner}` + `✓/✗` + error/ref/bytes |
| `tool-invoked` | `{name} · {duration}ms · ok/fail` |
| `workflow-start` | `Workflow · {name} · depth {depth}` |
| `workflow-step-start` | `Step · {label} · tool {tool}` |
| `workflow-step-end` | `Step end · {label} · {durationMs}ms · ok/fail` |
| `workflow-end` | `Workflow end · {name} · {durationMs}ms · ok/fail` |
| `llm-synthesis-start` | `Synthesis start` |
| `llm-synthesis` | `Synthesis end · {prompt}/{completion} tok` |

Truncate inline strings at **60 characters** with `…`.

## Meta grid fields

Show only high-signal fields inline. Never dump orchestration system prompts or full capability inputs.

| Kind | Fields |
|------|--------|
| orchestration `llm-call` | User (first real user message), Chosen (tool + truncated args) |
| `tool-call` | Args (truncated JSON), Ref if present |
| capability `llm-call` | Instructions (before `--- INPUT ---`), Input size, Output preview |
| synthesis `llm-call` | Answer |
| `find_tool` / find in tool-call | Query |

## Compact raw JSON

The collapsible raw block must stay small enough to open quickly:

- **Non-`llm-call` events**: full `data` object
- **`llm-call` events**: `{ phase, method, usage, response }` only
  - `response.tool_calls`: name + truncated arguments (200 chars)
  - `response.content`: truncated to 500 chars
  - **Never** include `request.messages` in raw JSON

## Timestamps

Display as `HH:MM:SS.mmm` (local wall time from ISO `ts`, milliseconds only).

## Implementation

Prefer running [generate-trace-html.py](generate-trace-html.py):

```bash
python3 .cursor/skills/visualize-trace/generate-trace-html.py TRACE.jsonl OUTPUT.html
python3 .cursor/skills/visualize-trace/generate-trace-html.py TRACE.jsonl OUTPUT.html --config tmp/meta-agent.json
```

Manual fallback: follow this doc and fill [report-template.html](report-template.html) placeholders.
