# Meta-agent trace event kinds

Each line in a trace file is one JSON object: `{ ts, sessionId, kind, data }`.

Use this reference when parsing events and deciding what to show in the report.

## Agent loop (orchestration)

| kind | When | Key `data` fields |
|------|------|-------------------|
| `llm-turn-start` | Before orchestrator LLM call for a turn | `turn` (number, resets to 0 per user task) |
| `llm-turn` | After orchestrator LLM returns | `turn`, `usage` (`promptTokens`, `completionTokens`) |
| `llm-call` | Full request/response of any host LLM call | `phase`, `method`, `request`, `response`, `usage` |
| `tool-dispatch-start` | Before handling one model tool call | `name` (meta-tool name, e.g. `invoke_tool`) |
| `tool-call` | After meta-tool completes | `name`, `args`, `ok`, `result` (may include `ref`, `error`) |
| `llm-synthesis-start` | Before final user-facing LLM pass | `{}` |
| `llm-synthesis` | After synthesis LLM | `usage` |
| `execution-denied` | Approval rejected tool before sandbox | `name`, `reason` |

### `llm-call` phases (`data.phase`)

| phase | Meaning |
|-------|---------|
| `orchestration` | Main agent turn — tool picking |
| `synthesis` | Post-`stop` reply to user |
| `capability` | Inside a registry tool (e.g. `llm_generate`) |
| `factory-draft` | Tool factory draft generation |
| `factory-repair` | Tool factory schema repair |
| `unknown` | Fallback |

## Registry tools (sandbox)

| kind | When | Key `data` fields |
|------|------|-------------------|
| `tool-invoked` | Registry tool finished in sandbox | `name`, `duration` (ms), `ok` |

`tool-invoked` pairs with `tool-call` when `tool-call.name === "invoke_tool"`: dispatch-start → optional workflow events → tool-invoked → tool-call with full result.

## Workflows (composite tools)

| kind | When | Key `data` fields |
|------|------|-------------------|
| `workflow-start` | Composite workflow begins | `name`, `depth` |
| `workflow-step-start` | Step dispatch begins | `workflow`, `label`, `tool` |
| `workflow-step-end` | Step finished | `workflow`, `label`, `tool`, `ok`, `durationMs` |
| `workflow-end` | Workflow finished | `name`, `ok`, `durationMs` |

Workflow events nest **inside** an `invoke_tool` → composite tool call. Draw them as an expanded sub-flow.

## Tool factory (between tasks or during propose)

| kind | When | Key `data` fields |
|------|------|-------------------|
| `tool-created` | Tool approved and registered | `name`, `hash`, `approvedBy` |
| `tool-rejected` | Tool draft rejected | `name`, `reason` |
| `factory-gen-draft` | Draft generation started | `phase` (usually `"start"`) |
| `factory-repair-llm` | Schema repair LLM started | `phase` (usually `"start"`) |

## Result references (`$ref`)

Non-trivial tool results in orchestration often appear as:

```json
{ "ok": true, "ref": "r_0_fetch_webpage_text", "shape": {...}, "preview": "..." }
```

Later tools consume prior output via:

```json
{ "$ref": "r_0_fetch_webpage_text", "path": "text" }
```

Track refs across the session for dependency diagrams and the reference table.

## Segmenting user tasks

A **new user task** usually starts when:

1. `llm-turn-start` with `turn: 0` appears after a prior `llm-synthesis`, or
2. The first event in the file.

Extract the user message from the first `llm-call` with `phase: "orchestration"` in that segment (from `request.messages`, last `role: "user"` before new assistant turns).

Interludes (no user message) include `tool-created`, `tool-rejected`, factory events between tasks.

## Collapsible content rules

Put inside `<details>` when longer than ~120 characters or ~3 lines:

- Full `llm-call` request/response bodies
- Tool `result.value` payloads
- Error messages and stack traces
- `preview` is enough in the summary line; full JSON goes in `<pre>` inside details
