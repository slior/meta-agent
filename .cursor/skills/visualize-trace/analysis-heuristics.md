# Trace analysis heuristics

After building the narrative, scan the parsed session for issues. Report each finding in the **Analysis** section with: severity, evidence (event `ts` + `kind`), impact, suggested fix.

Use severity labels: **Critical**, **Warning**, **Info**.

## Tool invocation failures

| Pattern | Severity | Suggested fix |
|---------|----------|---------------|
| `tool-call` with `ok: false` and `error.kind: "schema_violation"` | Warning | Agent used wrong arg names; ensure catalog/`find_tool` exposes `inputSchema`; consider aliasing common mistakes (`file_path` → `outfile`) |
| Same schema error repeated in later tasks | Warning | Agent did not learn param names; improve tool description in registry or add examples to system prompt |
| `execution-denied` | Warning | Review approval policy; document why tool was blocked |
| `tool-rejected` (factory) | Info/Critical | Fix draft validation, smoke test, or user rejection reason |

## Recovery behavior

| Pattern | Severity | Suggested fix |
|---------|----------|---------------|
| Failed `invoke_tool` followed by `find_tool` or `list_tools` | Info | Working as designed — note recovery latency (extra turns) |
| Failed `invoke_tool` with no recovery meta-tool before `stop` | Critical | Agent violated recovery guidance |
| Recovery hint in transcript but agent apologizes without meta-tools | Critical | Strengthen recovery prompt enforcement |

## Reference and data flow

| Pattern | Severity | Suggested fix |
|---------|----------|---------------|
| Agent summarizes/transforms in assistant text instead of `llm_generate` with `$ref` | Warning | Reinforce system prompt rule #8 |
| `$ref` points to missing or failed ref | Critical | Bug in result store or premature reference |
| Manual re-typing of large values into args instead of `$ref` | Warning | Use reference bindings for composability |

## Workflow / composite tools

| Pattern | Severity | Suggested fix |
|---------|----------|---------------|
| `llm-call` capability phase instructions mention wrong paper/topic vs fetched URL | Warning | Workflow `argsTemplate` hardcodes RIG-specific instructions; parameterize `instructions` |
| `workflow-end` with `ok: false` | Critical | Fix workflow step bindings or underlying tool |
| Step `durationMs` dominates total (e.g. llm >> fetch+write) | Info | Expected for LLM steps; note for cost/latency |
| `workflow-step-end` ok false | Critical | Inspect failing step tool and args |

## Orchestration efficiency

| Pattern | Severity | Suggested fix |
|---------|----------|---------------|
| Manual 3-step chain when matching composite exists in catalog | Info | Agent could use composite tool in one call |
| `find_tool` before obvious catalog match | Info | Acceptable when ambiguous; wasteful if repeated every task |
| High turn count for simple task | Warning | Check for retry loops or schema errors |
| `stop` in same turn as other tool calls | Critical | Violates guidance rule #7 |

## LLM usage

| Pattern | Severity | Suggested fix |
|---------|----------|---------------|
| Very high `promptTokens` on orchestration turns | Info | Long tool catalog or transcript; consider pruning |
| Synthesis phase when task already clear from tool results | Info | Optional optimization |
| `yolo: false` with no `execution-denied` events | Info | Approval flow working as configured |
| Actual orchestration turns ≥ `maxTurns` from config | Warning | Session may hit turn limit; consider raising `maxTurns` |
| Config file provided but unreadable | Info | Fix config path or JSON syntax |

## Session integrity

| Pattern | Severity | Suggested fix |
|---------|----------|---------------|
| `llm-turn-start` without matching `llm-turn` | Warning | Truncated trace or crash mid-turn |
| Duplicate `sessionId` mismatch | Critical | File corruption or merged traces |
| Gaps in timestamps (>5 min) with no events | Info | User idle or external tool approval wait |

## Output format for each finding

```html
<div class="finding finding-warning">
  <div class="finding-header">
    <span class="severity">Warning</span>
    <strong>Repeated schema violation: file_path vs outfile</strong>
  </div>
  <p><strong>Evidence:</strong> tool-call @ 14:47:24, 14:50:29 — schema_violation</p>
  <p><strong>Impact:</strong> +2 extra turns per task (find_tool recovery).</p>
  <p><strong>Suggested fix:</strong> Add <code>outfile</code> to tool catalog snippet; alias <code>file_path</code> in schema or validator.</p>
</div>
```

If no issues found, state: "No significant issues detected" and list 1–2 positive observations (e.g. correct `$ref` chaining, successful recovery).
