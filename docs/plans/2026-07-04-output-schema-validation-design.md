# Output Contract Enforcement — Design Spec

**Status:** Approved for implementation planning  
**Date:** 2026-07-04  
**Addresses:** H5 from design review (`tmp/design_review_gpt55.md`)  
**Scope:** Enforce `outputShape` as a hard contract at both runtime dispatch and smoke test, using a shared validation helper.

---

## 1. Problem Statement

`outputShape` is declared in every tool manifest and shown to the Gate 1 reviewer, but it is never enforced at execution boundaries. The current system validates **inputs** against `inputSchema` in `AgentLoop.dispatchTool` and returns a hard `schema_violation` error on mismatch. Successful outputs pass through unchecked.

Consequences of the gap:

- Malformed outputs enter `ResultStore` and can be referenced via `$ref` in subsequent tool calls.
- Workflow steps silently pass mismatched data between tools.
- Composed tools build structural assumptions on outputs that were never structurally verified.
- The smoke test in `ToolFactory` only checks `smoke.ok` (subprocess exited without error); a tool that returns the wrong shape passes Gate 1 undetected.

---

## 2. Goals

1. Make `outputShape` a hard contract at runtime: a tool whose successful output violates its declared schema returns an error to the LLM, not the value.
2. Make `outputShape` a hard contract at creation time: a smoke test whose output violates `outputShape` enters the same repair loop as any other smoke failure.
3. Distinguish output violations from input violations so the LLM can reason appropriately.
4. Validate every schema (including `{}`), relying on Ajv's natural behavior for loose schemas rather than adding skip logic. `outputShape` is typed as `Record<string, unknown>` — object-form JSON Schema only; boolean schemas (`true` / `false`) are outside the repo's contract and are not supported.
5. Compile each unique schema exactly once (module-level cache), so per-call overhead is a single pre-compiled function call.

## 2a. Scope and Exclusions

**In scope:** atomic and composite tools created via `ToolFactory.createWithPrompt`. These go through LLM code-gen, static validation, a smoke test, and Gate 1 approval — all three of which gain output-shape enforcement under this spec.

**Out of scope (this spec): workflow tools created via `ToolFactory.createWorkflow`.**

Workflows are deterministically lifted from a trace of already-executed tool invocations — no LLM code generation happens and there is no smoke test. `lift.ts` always emits `outputShape: {}` for the resulting manifest. Validating against `{}` at creation time is a structural no-op (Ajv passes any value against an empty schema), and running a smoke test on a lifted workflow would require spinning up all its step dependencies, which is a distinct capability not in scope here.

**Runtime validation still applies to workflow tool executions** (§6 covers `runWithTracing`, which is the exit point for all three tool kinds including workflow). However, the benefit is only realised if a workflow's manifest ever carries a non-empty `outputShape`. Today it does not.

**Included in this spec:** `lift.ts` derives `outputShape` from the last step's tool manifest (§7b). `req.toolsByName` already carries every tool's manifest at lift time, so no new capability is needed. This makes runtime output validation immediately meaningful for lifted workflows.

**Workflow Gate 1 edits** are not affected by the edited-draft re-validation concern in §7a. The workflow reviewer can only edit `name` and `description` — not the manifest, `outputShape`, or workflow structure — so no re-validation is needed on that path.

---

## 3. Chosen Approach: Shared `validateToolOutput` Helper

A new focused module `packages/core/src/agent/validate-tool-output.ts` owns the validation behavior. Both `AgentLoop` and `ToolFactory` call this one function.

This mirrors the existing `coerce-tool-input.ts` pattern: a focused module for a focused transformation, importable by both dispatch and factory without creating a dependency from `factory` on `AgentLoop`.

### 3.1 Why not inline at each call site (Approach A)?

The logic (compile schema, cache validator, format error) would be duplicated between `agent-loop.ts` and `factory.ts` with no shared test target. The module-level cache cannot be shared across the two inlined copies.

### 3.2 Why not at the sandbox boundary (Approach C)?

- Workflow tools bypass the sandbox entirely (in-process via `WorkflowExecutor`). Output from workflow steps would remain unvalidated.
- The factory uses a raw inner sandbox for smoke tests, bypassing `PolicyEnforcedSandbox`.
- Schema validation is not a sandbox concern.

---

## 4. New Error Kind

Add `OUTPUT_SCHEMA_VIOLATION` to `TOOL_ERROR_KIND` in `packages/core/src/types.ts`:

```ts
export const TOOL_ERROR_KIND = {
  // existing:
  TIMEOUT:             "timeout",
  PERMISSION_DENIED:   "permission_denied",
  RUNTIME_ERROR:       "runtime_error",
  REJECTED_BY_USER:    "rejected_by_user",
  SCHEMA_VIOLATION:    "schema_violation",         // input violations (unchanged)
  OUTPUT_TRUNCATED:    "output_truncated",
  DEPTH_EXCEEDED:      "depth_exceeded",
  UNKNOWN_TOOL:        "unknown_tool",
  // new:
  OUTPUT_SCHEMA_VIOLATION: "output_schema_violation",
} as const;
```

Rationale: the LLM reasoning strategy differs. `schema_violation` signals "I passed wrong args." `output_schema_violation` signals "the tool returned something structurally unexpected — consider requesting a tool repair or routing around it." Keeping them separate preserves the LLM's ability to act on that distinction.

---

## 5. `validate-tool-output.ts` Module

**Location:** `packages/core/src/agent/validate-tool-output.ts`

**Contract:**

```ts
/**
 * Validates `value` against the tool's declared `outputShape`.
 *
 * Returns `{ ok: true, value }` unchanged on success.
 * Returns `{ ok: false, error: { kind: "output_schema_violation", ... } }` on failure.
 * A malformed `outputShape` (invalid JSON Schema) is also reported as a violation.
 */
export function validateToolOutput(
  schema: Record<string, unknown>,  // object-form JSON Schema only; matches ToolManifest.outputShape type
  value: unknown,
): ToolResult
```

**Internals:**

- Module-level `Ajv` instance, `strict: false` (matching the existing instance in `AgentLoop`).
- Module-level `Map<string, ValidateFunction>` keyed by `JSON.stringify(schema)`. Each unique schema is compiled once; subsequent calls reuse the compiled validator.
- If `ajv.compile(schema)` throws (malformed JSON Schema), the error is caught and returned as `output_schema_violation` — malformed declared schemas fail at first invocation rather than silently passing.
- On validation failure: `{ ok: false, error: { kind: "output_schema_violation", message: ajv.errorsText(errors, { dataVar: "output" }), details: { errors: [...errors] } } }`. Ajv reuses and mutates the `errors` array across calls, so the array is shallow-copied before being stored in the `ToolResult` to ensure diagnostic correctness.
- Empty schema `{}` is compiled and validated normally; Ajv passes any value through `{}`, so no special-casing is needed.

---

## 6. `AgentLoop.runWithTracing` Integration

**File:** `packages/core/src/agent/agent-loop.ts`

**Change:** After `const result = await executeFn()`, gate the output before tracing or `ResultStore` writes:

```ts
const result = await executeFn();
const durationMs = Date.now() - started;

// REJECTED_BY_USER path is unchanged (early return, no TOOL_INVOKED trace).

// NEW: validate successful output; convert to output_schema_violation if needed.
// effectiveResult flows into the TOOL_INVOKED trace and ResultStore writes below,
// so a violation is traced as a failed invocation and never stored.
let effectiveResult: ToolResult = result;
if (result.ok) {
  const outputCheck = validateToolOutput(tool.manifest.outputShape, result.value);
  if (!outputCheck.ok) effectiveResult = outputCheck;
}

// remaining tracing, ResultStore, and onToolInvoked calls use effectiveResult (not result)
```

**Why after execution but before tracing:** the tool ran and completed — that execution should be traceable (`TRACE_KIND_TOOL_INVOKED` fires with `ok: false`) and `onToolInvoked` should fire with `ok: false, value: undefined`, consistent with every other failure kind (`runtime_error`, `timeout`, `schema_violation`). Using a local `effectiveResult` variable achieves this without an early return.

**ResultStore safety:** `storeDepth0Result` already has an existing `if (!result.ok) { return null; }` guard that applies to all failures, including `output_schema_violation`. No new code is needed to keep the bad value out of `ResultStore`.

**`onToolInvoked` semantics:** the callback fires for all non-`REJECTED_BY_USER` results today — including failures — and passes `value: result.ok ? result.value : undefined`. An `output_schema_violation` result fires the callback with `ok: false, value: undefined`. The bad value is never passed as non-`undefined` to any consumer. The CLI's `/compose` invocation list collects this as an `ok: false` entry; `liftFromTrace` already filters those out with `slice.filter(s => s.ok)`, so the violation is naturally excluded from workflow lift with no additional logic.

**Invariant:** the bad value never enters `ResultStore` or is passed as a non-`undefined` `value` to any consumer. Both are guaranteed by pre-existing code paths, not by suppressing the callback.

**Coverage:** `runWithTracing` is the shared exit point for all three tool kinds (atomic, composite, workflow). This single insertion point covers them all.

**Existing `this.ajv` instance:** not used for output validation (that instance compiles `inputSchema`). The module-level cache in `validate-tool-output.ts` handles output validators independently.

---

## 7. `ToolFactory.createFromDraft` Integration

**File:** `packages/core/src/factory/factory.ts`

**Current logic (simplified):**

```ts
const smoke = await this.smokeTest(smokeTool, draft.smokeTestInput);
if (!smoke.ok) { /* existing repair loop */ }
return this.presentAndSave(draft, smoke);
```

**Change:** After the existing runtime-error repair loop, add an output-shape check:

```ts
const smoke = await this.smokeTest(smokeTool, draft.smokeTestInput);
if (!smoke.ok) { /* existing repair loop — unchanged */ }

// NEW: check smoke output against declared outputShape
const outputCheck = validateToolOutput(draft.outputShape, smoke.value);
if (!outputCheck.ok) {
  attempts = 0;
  // currentFailure tracks the most recent error so each repair call
  // receives the actual current failure, not the original one.
  let currentFailure = `smoke output does not match outputShape: ${outputCheck.error.message}`;
  while (attempts < this.maxRepair) {
    attempts++;
    draft = await this.repair(draft, [currentFailure]);
    const v = staticValidateDraft(draft, { existingNames, tombstoned: this.opts.tombstoned });
    if (!v.ok) {
      currentFailure = `static validation: ${v.errors.join("; ")}`;
      continue;
    }
    const retry = await this.smokeTest(this.draftToTool(draft), draft.smokeTestInput);
    if (!retry.ok) {
      currentFailure = `smoke test failed: ${retry.error.kind}: ${retry.error.message}`;
      continue;
    }
    const retryCheck = validateToolOutput(draft.outputShape, retry.value);
    if (retryCheck.ok) { return this.presentAndSave(draft, retry); }
    currentFailure = `smoke output does not match outputShape: ${retryCheck.error.message}`;
  }
  this.opts.tracer.log(TRACE_KIND_TOOL_REJECTED, {
    name: draft.name,
    reason: `smoke output schema: ${currentFailure}`,
  });
  return { ok: false, reason: currentFailure };
}

return this.presentAndSave(draft, smoke);
```

**`currentFailure` variable:** initialized from the first output-shape mismatch, then updated on each iteration depending on what actually failed — static validation, smoke runtime error, or a different output-shape mismatch. Every repair call receives the real current failure. The trace and final return value also use `currentFailure`, so they reflect the actual last error rather than the original one.

**Note:** the existing runtime-error repair loop (above this block) has the same staleness pattern — it reuses `smoke.error.kind/message` from outside its loop across all iterations. Fixing that is a pre-existing concern outside this spec's scope, but the new loop deliberately avoids repeating it.

---

## 7a. `ToolFactory.presentAndSave` — Edited Draft Re-validation

**Problem:** `presentAndSave` currently takes `decision.editedDraft ?? draft` and saves it directly, bypassing all validation. The original design spec (§4.5) says edits should be "re-validated and re-smoke-tested before acceptance." This gap is pre-existing but becomes especially visible with output-shape enforcement: a reviewer who edits `outputShape` to something the actual code violates would save a broken tool, making the creation-time guarantee false for edited drafts.

**Fix:** When `decision.editedDraft` is present, re-run the full creation-time pipeline on the edited draft before saving:

1. Static validation (`staticValidateDraft`)
2. Smoke test (`smokeTest`)
3. Output-shape validation (`validateToolOutput`)

If any step fails, `presentAndSave` returns `{ ok: false, reason: "edited draft failed re-validation: ..." }` immediately — no retry loop, no second Gate 1 prompt. The reviewer edited the draft and it is broken; the failure is surfaced directly.

```ts
private async presentAndSave(draft: ToolDraft, smoke: ToolResult): Promise<FactoryOutcome> {
  const decision = await this.opts.approval.reviewDraft({ kind: GATE1_KIND.CODE, draft, smoke });
  // ... reject handling unchanged ...

  const finalDraft = decision.editedDraft ?? draft;

  // NEW: if reviewer edited the draft, re-validate before saving
  if (decision.editedDraft) {
    const sv = staticValidateDraft(finalDraft, { existingNames, tombstoned: this.opts.tombstoned });
    if (!sv.ok) {
      this.opts.tracer.log(TRACE_KIND_TOOL_REJECTED, { name: finalDraft.name, reason: `edit failed static: ${sv.errors.join("; ")}` });
      return { ok: false, reason: `edited draft failed static validation: ${sv.errors.join("; ")}` };
    }
    const editSmoke = await this.smokeTest(this.draftToTool(finalDraft), finalDraft.smokeTestInput);
    if (!editSmoke.ok) {
      this.opts.tracer.log(TRACE_KIND_TOOL_REJECTED, { name: finalDraft.name, reason: `edit failed smoke: ${editSmoke.error.message}` });
      return { ok: false, reason: `edited draft failed smoke test: ${editSmoke.error.message}` };
    }
    const editOutputCheck = validateToolOutput(finalDraft.outputShape, editSmoke.value);
    if (!editOutputCheck.ok) {
      this.opts.tracer.log(TRACE_KIND_TOOL_REJECTED, { name: finalDraft.name, reason: `edit failed output schema: ${editOutputCheck.error.message}` });
      return { ok: false, reason: `edited draft output does not match outputShape: ${editOutputCheck.error.message}` };
    }
  }

  // save proceeds as before
  const tool = this.draftToTool(finalDraft);
  // ...
}
```

**Key properties:**
- No second Gate 1 prompt — the reviewer already saw and approved the edit.
- No retry loop — a broken reviewer edit is not an LLM problem; it is surfaced as a failure immediately.
- The fast path (no edit) is unchanged — no overhead added for the common case.
- `existingNames` must be threaded into `presentAndSave` (it is already available in `createFromDraft` which is the only caller).

---

## 7b. `lift.ts` — Derive `outputShape` from the Last Step

**File:** `packages/core/src/workflow/lift.ts`

**Problem:** `liftFromTrace` always emits `outputShape: {}` for the workflow manifest. Since `runWithTracing` validates against `outputShape`, this makes runtime enforcement a structural no-op for all lifted workflows.

**Fix:** At lift time, look up the last step's tool in `req.toolsByName` (already available as a registry snapshot) and copy its `manifest.outputShape` to the workflow manifest.

```ts
function deriveWorkflowOutputShape(
  steps: ToolCallStep[],
  toolsByName: Record<string, Tool>,
): Record<string, unknown> {
  if (steps.length === 0) return {};
  const lastStep = steps[steps.length - 1]!;
  if (lastStep.resultBinding === null) return {}; // result discarded, no meaningful output contract
  return toolsByName[lastStep.tool]?.manifest.outputShape ?? {};
}
```

In `liftFromTrace`, the manifest construction changes from:

```ts
outputShape: {}, permissions,
```

to:

```ts
outputShape: deriveWorkflowOutputShape(steps, req.toolsByName), permissions,
```

**Why the last step:** `workflow.return` always resolves to the last step's `resultBinding` — this is structurally enforced by the lift code. The last step's tool is therefore always the one whose output shape the workflow exposes.

**Edge cases:**

| Situation | Derived `outputShape` |
|---|---|
| Last step's `resultBinding` is `null` (result discarded) | `{}` — no meaningful contract |
| Last step's tool not found in `toolsByName` | `{}` — defensive fallback (cannot happen: lift already rejects unknown tools earlier) |
| Last step's tool declares `outputShape: {}` | `{}` — passes through; runtime validation is a no-op, same as before |
| Last step's tool has a non-trivial `outputShape` | That schema is used; runtime violations are now caught |

**Hash impact:** The workflow manifest hash includes `outputShape`. A freshly lifted workflow whose last step has a non-`{}` outputShape will get a different hash than it would have under the old code. This only affects newly created workflows — existing registry entries are not re-hashed.

---

## 8. Tracing

No new trace event kind is needed, but two existing events need a targeted field addition.

**Two separate trace paths exist for tool execution:**

- **`TRACE_KIND_TOOL_CALL`** — fired by the main dispatch loop at depth 0 only (top-level LLM-dispatched calls). Includes `result: toolResultForTrace(result)`, which carries the full `{ ok, error: { kind, message } }` payload. `error.kind` is already visible here.
- **`TRACE_KIND_TOOL_INVOKED`** — fired by `runWithTracing` at all depths. Currently logs only `{ name, duration, ok }`. No `error.kind`.
- **`TRACE_KIND_WORKFLOW_STEP_END`** — fired by `WorkflowExecutor` per step. Currently logs only `{ workflow, label, tool, ok, durationMs }`. No `error.kind`.

For nested calls — composite sub-tools at depth > 0, or individual workflow steps — only `TRACE_KIND_TOOL_INVOKED` (and `TRACE_KIND_WORKFLOW_STEP_END` for workflow steps) fire. At those depths, trace viewers see only `ok: false`; the distinction promised by `output_schema_violation` is invisible.

**Fix:** Add `errorKind` to both events when `!ok`. This closes the gap for all failure kinds, not just the new one.

In `runWithTracing` (`agent-loop.ts`):

```ts
// use effectiveResult (may be output_schema_violation) not result
this.opts.tracer.log(TRACE_KIND_TOOL_INVOKED, {
  name,
  duration: durationMs,
  ok: effectiveResult.ok,
  ...(!effectiveResult.ok ? { errorKind: effectiveResult.error.kind } : {}),
});
```

In `WorkflowExecutor` (`workflow/executor.ts`):

```ts
this.opts.tracer.log(TRACE_KIND_WORKFLOW_STEP_END, {
  workflow: workflow.name,
  label: step.label,
  tool: step.tool,
  ok: result.ok,
  durationMs: Date.now() - stepStarted,
  ...(!result.ok ? { errorKind: result.error.kind } : {}),
});
```

The design doc's `§5.5` result-shape comment should also be updated to include `output_schema_violation` in the discriminator union.

---

## 9. Tests

### 9.1 Unit tests for `validate-tool-output.ts`

New file: `packages/core/src/agent/validate-tool-output.test.ts`

| Scenario | Expected |
|---|---|
| Value matches declared schema | `{ ok: true, value }` (value unchanged) |
| Value violates declared schema | `{ ok: false, error.kind === "output_schema_violation" }` |
| Schema is `{}` (empty) | Always `{ ok: true }` — Ajv passes any value |
| Schema is `{ type: "object", properties: { n: { type: "number" } }, required: ["n"] }`, value has `{ n: "oops" }` | `{ ok: false, ... }` with message mentioning `.n` |
| Malformed object-form schema (e.g. `{ type: 42 }`) | `{ ok: false, error.kind === "output_schema_violation" }` — no throw |
| Same schema object called twice | Second call returns immediately (cache hit — validator compiled once) |

### 9.2 `AgentLoop` integration test

In `packages/core/src/agent/agent-loop.test.ts`:

- Mock tool declares `outputShape: { type: "object", properties: { count: { type: "number" } }, required: ["count"] }`
- Mock sandbox returns `{ ok: true, value: { count: "not-a-number" } }`
- Expected: `dispatchTool` returns `{ ok: false, error: { kind: "output_schema_violation", ... } }`
- Verify: the bad value is **not** stored in `ResultStore` (no `$ref` binding assigned)

### 9.3 Trace `errorKind` visibility tests

In `packages/core/src/agent/agent-loop.test.ts` or a dedicated trace test file:

- **Depth-0 violation:** Tool at depth 0 returns wrong shape. `TRACE_KIND_TOOL_INVOKED` event has `{ ok: false, errorKind: "output_schema_violation" }`. `TRACE_KIND_TOOL_CALL` event has full result with `error.kind: "output_schema_violation"`.
- **Nested violation (composite sub-tool, depth > 1):** Tool called from inside a composite returns wrong shape. `TRACE_KIND_TOOL_INVOKED` event for that nested call has `{ ok: false, errorKind: "output_schema_violation" }`. No `TRACE_KIND_TOOL_CALL` event fires for nested calls.
- **Workflow step violation:** Workflow step tool returns wrong shape. `TRACE_KIND_WORKFLOW_STEP_END` has `{ ok: false, errorKind: "output_schema_violation" }`.
- **Non-output failure (regression):** A `runtime_error` at depth > 0. `TRACE_KIND_TOOL_INVOKED` has `{ ok: false, errorKind: "runtime_error" }` — confirming the `errorKind` field is populated for all failure kinds, not just the new one.

### 9.4 `lift.ts` unit tests

In `packages/core/src/workflow/lift.test.ts`:

| Scenario | Expected `manifest.outputShape` |
|---|---|
| Last step tool has `outputShape: { type: "string" }` | `{ type: "string" }` |
| Last step tool has `outputShape: {}` | `{}` |
| Last step `resultBinding` is `null` | `{}` |
| Two-step trace; first tool has `outputShape: { type: "number" }`, second has `{ type: "string" }` | `{ type: "string" }` (last step wins) |

### 9.5 `ToolFactory` integration tests

In `packages/core/src/factory/factory.test.ts` (or existing factory test file):

**Repair loop exhaustion:**
- Smoke test returns `{ ok: true, value: "a string" }` but `outputShape` declares `{ type: "object" }`
- First repair attempt: smoke still returns wrong shape
- Second attempt (maxRepair = 2): same
- Expected: factory returns `{ ok: false, reason: "smoke output does not match outputShape: ..." }` and logs `tool-rejected`

**Edited draft — valid edit:**
- Reviewer returns `editedDraft` whose code correctly matches the declared `outputShape`
- Re-validation passes: static ✓, smoke ✓, output-shape ✓
- Expected: tool is saved and factory returns `{ ok: true, ... }`

**Edited draft — broken `outputShape`:**
- Reviewer returns `editedDraft` with `outputShape` that the actual smoke output violates
- Expected: factory returns `{ ok: false, reason: "edited draft output does not match outputShape: ..." }` and logs `tool-rejected`; tool is **not** written to registry

**Repair loop receives fresh feedback per iteration:**
- First repair attempt passes static validation and smoke, but the retry output still fails schema → `currentFailure` is updated to the new output-shape error message
- Second attempt fails static validation → `currentFailure` is updated to the static error; repair call receives static error, not the original output-shape error
- Expected: each `repair()` call in the mock captures the message it was given; assert that message 2 is the static error, not the original output-shape error

---

## 10. Files Changed

| File | Change |
|---|---|
| `packages/core/src/types.ts` | Add `OUTPUT_SCHEMA_VIOLATION` to `TOOL_ERROR_KIND` |
| `packages/core/src/agent/validate-tool-output.ts` | **New** — validation helper with module-level Ajv cache |
| `packages/core/src/agent/validate-tool-output.test.ts` | **New** — unit tests |
| `packages/core/src/agent/agent-loop.ts` | Call `validateToolOutput` in `runWithTracing`; add `errorKind` to `TRACE_KIND_TOOL_INVOKED` on failure |
| `packages/core/src/workflow/executor.ts` | Add `errorKind` to `TRACE_KIND_WORKFLOW_STEP_END` on failure |
| `packages/core/src/factory/factory.ts` | Add output-shape repair loop after smoke-test success check; re-validate edited drafts in `presentAndSave` |
| `packages/core/src/workflow/lift.ts` | Derive `outputShape` from last step's tool manifest instead of hardcoding `{}` |
| `packages/core/src/index.ts` | No change needed — `index.ts` already re-exports `TOOL_ERROR_KIND` from `types.ts`; adding `OUTPUT_SCHEMA_VIOLATION` to that const object is sufficient |

No changes to the sandbox, approval policy, registry, or CLI layers.

---

## 11. Trade-offs Accepted

- **Per-call overhead:** A single pre-compiled `ValidateFunction` call per successful tool invocation. For simple schemas this is microseconds; negligible against the 20–80ms subprocess spawn cost.
- **Repair loop latency:** A tool whose LLM-generated code returns the wrong shape adds up to `maxRepair` extra LLM round-trips during creation. This is the desired behavior — it enforces the contract earlier rather than at runtime.
- **Existing tools with incorrect `outputShape`:** Tools already in the registry may have `outputShape` declarations that do not match what the tool actually returns. These will fail at first invocation with `output_schema_violation`. There is currently no in-place repair meta-tool (`repair_tool` / `update_tool` do not exist). Recovery paths are:
  1. **User edits on disk** — the registry is human-inspectable. Fix either `manifest.json` (`outputShape`) or `tool.ts` (return value). Either change alters the content hash; the approval record becomes stale and the tool re-prompts at Gate 2/3 before the next run.
  2. **Agent workaround** — the agent receives the structured `output_schema_violation` result, can route around the broken tool (use an alternative or call `propose_new_tool` to create a functionally equivalent replacement under a new name).
  3. **Agent reports and stops** — the agent calls `stop` and surfaces the violation to the user for manual remediation.
  Loose schemas (e.g. `{}`) continue to pass validation and are unaffected.
- **`outputShape` derivation in `lift.ts` changes the manifest hash** for newly lifted workflows whose last step has a non-`{}` outputShape. Existing registry entries are unaffected. This is the desired behavior — the manifest hash reflects actual declared contracts.
- **Edited-draft re-validation adds a smoke-test round-trip for reviewer edits.** This is a good trade-off: the contract is real rather than aspirational. Reviewers who edit only comments or `outputShape` descriptions will see one extra subprocess spawn; reviewers who edit `code` or `outputShape` in a breaking way will see a clear failure instead of a silently broken registry entry.
