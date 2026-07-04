# Output Contract Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce `outputShape` as a hard contract at every execution boundary: runtime dispatch (all tool kinds), creation-time smoke tests, and edited-draft re-validation at Gate 1.

**Architecture:** A new `validate-tool-output.ts` module owns all schema validation logic with a module-level Ajv cache. `AgentLoop.runWithTracing` calls it before storing any successful result. `ToolFactory.createFromDraft` adds an output-shape repair loop after the smoke test. A new `OUTPUT_SCHEMA_VIOLATION` error kind distinguishes output violations from input violations throughout the system. `lift.ts` derives `outputShape` from the last step's tool manifest instead of hardcoding `{}`.

**Tech Stack:** Node.js ≥ 25, TypeScript with `--experimental-transform-types`, Ajv (`ajv` npm package, already a project dependency), Node built-in test runner (`node:test`).

**Spec:** `docs/superpowers/specs/2026-07-04-output-schema-validation-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/core/src/types.ts` | Modify | Add `OUTPUT_SCHEMA_VIOLATION` to `TOOL_ERROR_KIND` |
| `packages/core/src/agent/validate-tool-output.ts` | **Create** | Shared validation helper; module-level Ajv cache |
| `packages/core/src/agent/validate-tool-output.test.ts` | **Create** | Unit tests for the helper |
| `packages/core/src/agent/agent-loop.ts` | Modify | Call `validateToolOutput` in `runWithTracing`; add `errorKind` to `TRACE_KIND_TOOL_INVOKED` |
| `packages/core/src/workflow/executor.ts` | Modify | Add `errorKind` to `TRACE_KIND_WORKFLOW_STEP_END` on failure |
| `packages/core/src/workflow/lift.ts` | Modify | Derive `outputShape` from last step's tool manifest |
| `packages/core/src/factory/factory.ts` | Modify | Output-shape repair loop in `createWithPrompt`; re-validate edited drafts in `presentAndSave` |

Tests added to existing files:
- `packages/core/src/agent/agent-loop.test.ts`
- `packages/core/src/workflow/executor.test.ts`
- `packages/core/src/workflow/lift.test.ts`
- `packages/core/src/factory/factory.test.ts`

---

## Task 1: New error kind + `validate-tool-output` module

**Files:**
- Modify: `packages/core/src/types.ts`
- Create: `packages/core/src/agent/validate-tool-output.ts`
- Create: `packages/core/src/agent/validate-tool-output.test.ts`

### Step 1.1 — Add `OUTPUT_SCHEMA_VIOLATION` to `TOOL_ERROR_KIND` in `types.ts`

Open `packages/core/src/types.ts`. Find the `TOOL_ERROR_KIND` const object and add one entry:

```ts
export const TOOL_ERROR_KIND = {
  TIMEOUT: "timeout",
  PERMISSION_DENIED: "permission_denied",
  RUNTIME_ERROR: "runtime_error",
  REJECTED_BY_USER: "rejected_by_user",
  SCHEMA_VIOLATION: "schema_violation",
  OUTPUT_TRUNCATED: "output_truncated",
  DEPTH_EXCEEDED: "depth_exceeded",
  UNKNOWN_TOOL: "unknown_tool",
  OUTPUT_SCHEMA_VIOLATION: "output_schema_violation",   // ← add this
} as const;
```

No other changes in this file.

### Step 1.2 — Write the failing unit tests

Create `packages/core/src/agent/validate-tool-output.test.ts` with this full content:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateToolOutput } from "./validate-tool-output.ts";
import { TOOL_ERROR_KIND } from "../types.ts";

test("validateToolOutput: value matching schema returns ok:true, value unchanged", () => {
  const schema = { type: "object", properties: { count: { type: "number" } }, required: ["count"] };
  const value = { count: 42 };
  const result = validateToolOutput(schema, value);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, value);
});

test("validateToolOutput: value violating schema returns output_schema_violation", () => {
  const schema = { type: "object", properties: { count: { type: "number" } }, required: ["count"] };
  const result = validateToolOutput(schema, { count: "not-a-number" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, TOOL_ERROR_KIND.OUTPUT_SCHEMA_VIOLATION);
    assert.ok(result.error.message.includes("output"), "message references 'output'");
  }
});

test("validateToolOutput: empty schema {} passes any value", () => {
  assert.equal(validateToolOutput({}, "any string").ok, true);
  assert.equal(validateToolOutput({}, null).ok, true);
  assert.equal(validateToolOutput({}, [1, 2, 3]).ok, true);
  assert.equal(validateToolOutput({}, { anything: true }).ok, true);
});

test("validateToolOutput: malformed object-form schema returns output_schema_violation without throwing", () => {
  // { type: 42 } is not valid JSON Schema — type must be a string
  const result = validateToolOutput({ type: 42 } as unknown as Record<string, unknown>, "value");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, TOOL_ERROR_KIND.OUTPUT_SCHEMA_VIOLATION);
});

test("validateToolOutput: error details contains shallow-copied errors array", () => {
  const schema = { type: "number" };
  const result = validateToolOutput(schema, "not-a-number");
  assert.equal(result.ok, false);
  if (!result.ok) {
    const details = result.error.details as { errors: unknown[] } | undefined;
    assert.ok(Array.isArray(details?.errors), "details.errors is an array");
  }
});

test("validateToolOutput: same schema compiled once — repeated calls with same schema work", () => {
  const schema = { type: "string" };
  // First call: pass
  const r1 = validateToolOutput(schema, "hello");
  assert.equal(r1.ok, true);
  // Second call same schema: also pass (cache hit, no double-compile error)
  const r2 = validateToolOutput(schema, "world");
  assert.equal(r2.ok, true);
  // Third call: fail (violation still detected from cached validator)
  const r3 = validateToolOutput(schema, 42);
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.equal(r3.error.kind, TOOL_ERROR_KIND.OUTPUT_SCHEMA_VIOLATION);
});
```

### Step 1.3 — Run the tests to confirm they fail

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/agent/validate-tool-output.test.ts
```

Expected: module not found / import error, because `validate-tool-output.ts` does not exist yet.

### Step 1.4 — Implement `validate-tool-output.ts`

Create `packages/core/src/agent/validate-tool-output.ts` with this full content:

```ts
import Ajv, { type ValidateFunction, type ErrorObject } from "ajv";
import { TOOL_ERROR_KIND, type ToolResult } from "../types.ts";

/** Module-level Ajv instance shared across all calls (strict:false matches the agent-loop instance). */
const ajv = new Ajv({ strict: false });

/**
 * Cache of compiled validators keyed by JSON.stringify(schema).
 * Each unique object-form schema is compiled exactly once.
 */
const validatorCache = new Map<string, ValidateFunction>();

function getValidator(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = validatorCache.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    validatorCache.set(key, validate);
  }
  return validate;
}

/**
 * Validates `value` against the tool's declared `outputShape`.
 *
 * Returns `{ ok: true, value }` unchanged on success.
 * Returns `{ ok: false, error: { kind: "output_schema_violation", ... } }` on failure.
 * A malformed `outputShape` (invalid object-form JSON Schema) is also reported as a violation.
 *
 * `outputShape` must be object-form JSON Schema (`Record<string, unknown>`); boolean schemas
 * are outside the repo's contract and are not supported.
 */
export function validateToolOutput(
  schema: Record<string, unknown>,
  value: unknown,
): ToolResult {
  let validate: ValidateFunction;
  try {
    validate = getValidator(schema);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        kind: TOOL_ERROR_KIND.OUTPUT_SCHEMA_VIOLATION,
        message: `outputShape is not a valid JSON Schema: ${message}`,
      },
    };
  }

  const valid = validate(value);
  if (!valid) {
    const errors: ErrorObject[] = validate.errors ?? [];
    return {
      ok: false,
      error: {
        kind: TOOL_ERROR_KIND.OUTPUT_SCHEMA_VIOLATION,
        // Ajv reuses and mutates errors[] across calls — shallow-copy before storing.
        message: ajv.errorsText(errors, { dataVar: "output" }),
        details: { errors: [...errors] },
      },
    };
  }

  return { ok: true, value };
}
```

### Step 1.5 — Run tests to confirm they pass

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/agent/validate-tool-output.test.ts
```

Expected: all 6 tests pass.

### Step 1.6 — Typecheck

```bash
npm run typecheck
```

Expected: no errors.

- [ ] Step 1.1 — Add `OUTPUT_SCHEMA_VIOLATION` to `types.ts`
- [ ] Step 1.2 — Write failing unit tests
- [ ] Step 1.3 — Run tests, confirm they fail
- [ ] Step 1.4 — Implement `validate-tool-output.ts`
- [ ] Step 1.5 — Run tests, confirm they pass
- [ ] Step 1.6 — Typecheck

---

## Task 2: Wire output validation into `AgentLoop.runWithTracing`

**Files:**
- Modify: `packages/core/src/agent/agent-loop.ts`
- Modify: `packages/core/src/agent/agent-loop.test.ts`

### Step 2.1 — Write the failing agent-loop test

Add the following test to the **end** of `packages/core/src/agent/agent-loop.test.ts`.

This test registers a real tool whose code intentionally returns the wrong shape, asks the LLM to call it, then asserts the agent loop catches the violation before storing the result.

```ts
// ─── output schema violation ──────────────────────────────────────────────────

const OUTPUT_VIOLATION_TOOL = makeConsistentTool(
  {
    name: "wrong-shape",
    description: "Returns wrong shape on purpose.",
    rationale: "test",
    inputSchema: { type: "object" },
    // Declares number, but code returns a string
    outputShape: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 5000, maxOldSpaceSizeMb: 64 },
    createdAt: "2026-01-01T00:00:00Z",
    kind: "atomic",
  },
  // Returns { count: "oops" } — a string instead of the declared number
  `export async function run(_i) { return { count: "oops" }; }`,
);

test("agent: output_schema_violation returned to LLM and value not stored in ResultStore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-osv-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    await registry.save(OUTPUT_VIOLATION_TOOL, makeConsistentApproval(OUTPUT_VIOLATION_TOOL));
    const index = await HybridToolIndex.open(registry);
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const prompter = {
      promptGate1: async () => { throw new Error("no"); },
      promptGate23: async () => ({ decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false }),
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const events: TraceEvent[] = [];
    const tracer = await Tracer.open(join(dir, "traces"), "s", { observers: [(e) => events.push(e)] });

    let invokedBinding: string | undefined = "sentinel"; // truthy sentinel
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "i1", name: META_FN.invokeTool, args: { name: "wrong-shape", args: {} } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });
    const loop = new AgentLoop({
      llm, registry, index, sandbox, approval, factory, tracer,
      onToolInvoked: (ev) => { invokedBinding = ev.binding; },
    });

    await loop.run("invoke wrong-shape");

    // 1. The result returned to the LLM must be ok:false with the new error kind
    const secondReq = llm.calls.chat[1];
    assert.ok(secondReq);
    const toolMsg = secondReq.messages.find((m) => m.role === CHAT_ROLE.tool);
    assert.ok(toolMsg, "expected a tool message in second chat call");
    const parsed = JSON.parse(toolMsg.content as string) as { ok: boolean; error?: { kind: string } };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error?.kind, TOOL_ERROR_KIND.OUTPUT_SCHEMA_VIOLATION);

    // 2. TRACE_KIND_TOOL_INVOKED must carry errorKind
    const invokedEvent = events.find((e) => e.kind === TRACE_KIND_TOOL_INVOKED && e.data.ok === false);
    assert.ok(invokedEvent, "expected a failed TRACE_KIND_TOOL_INVOKED event");
    assert.equal(invokedEvent.data.errorKind, TOOL_ERROR_KIND.OUTPUT_SCHEMA_VIOLATION);

    // 3. The bad value must NOT be stored in ResultStore (no binding assigned)
    assert.equal(invokedBinding, undefined, "output_schema_violation must not produce a ResultStore binding");

    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

### Step 2.2 — Run the new test to confirm it fails

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/agent/agent-loop.test.ts \
  --test-name-pattern "output_schema_violation"
```

Expected: test fails — the result is currently `ok: true` (no output validation).

### Step 2.3 — Implement the change in `agent-loop.ts`

**a) Add import** at the top of `packages/core/src/agent/agent-loop.ts`, alongside the existing local imports:

```ts
import { validateToolOutput } from "./validate-tool-output.ts";
```

**b) Replace `runWithTracing`** (currently lines 567–598). Find the method and replace its body with:

```ts
private async runWithTracing(
  tool: Tool,
  input: unknown,
  recordArgs: unknown,
  task: Task,
  depth: number,
  executeFn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const name = tool.manifest.name;
  const started = Date.now();
  const result = await executeFn();
  const durationMs = Date.now() - started;

  if (!result.ok && result.error.kind === TOOL_ERROR_KIND.REJECTED_BY_USER) {
    this.opts.tracer.log(TRACE_KIND_EXECUTION_DENIED, { name, reason: result.error.message });
    return result;
  }

  // Validate successful output against declared outputShape before storing.
  // effectiveResult may be replaced with an output_schema_violation if the value
  // does not match the manifest's declared contract.
  let effectiveResult: ToolResult = result;
  if (result.ok) {
    const outputCheck = validateToolOutput(tool.manifest.outputShape, result.value);
    if (!outputCheck.ok) effectiveResult = outputCheck;
  }

  this.opts.tracer.log(TRACE_KIND_TOOL_INVOKED, {
    name,
    duration: durationMs,
    ok: effectiveResult.ok,
    ...(!effectiveResult.ok ? { errorKind: effectiveResult.error.kind } : {}),
  });
  if (depth === 0) {
    const binding = this.storeDepth0Result(name, effectiveResult);
    this.opts.onToolInvoked?.({
      name, args: recordArgs, ok: effectiveResult.ok, durationMs,
      value: effectiveResult.ok ? effectiveResult.value : undefined,
      ...(binding !== null ? { binding } : {}),
    });
  } else {
    this.opts.onToolInvoked?.({
      name, args: input, ok: effectiveResult.ok, durationMs,
      value: effectiveResult.ok ? effectiveResult.value : undefined,
    });
  }
  if (effectiveResult.ok) task.invokedThisSession.add(name);
  return effectiveResult;
}
```

### Step 2.4 — Run all agent-loop tests

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/agent/agent-loop.test.ts
```

Expected: all tests pass including the new one.

### Step 2.5 — Typecheck

```bash
npm run typecheck
```

Expected: no errors.

- [ ] Step 2.1 — Write failing agent-loop test
- [ ] Step 2.2 — Run test, confirm it fails
- [ ] Step 2.3 — Implement `runWithTracing` change + import
- [ ] Step 2.4 — Run all agent-loop tests, confirm they pass
- [ ] Step 2.5 — Typecheck

---

## Task 3: Add `errorKind` to `TRACE_KIND_WORKFLOW_STEP_END`

**Files:**
- Modify: `packages/core/src/workflow/executor.ts`
- Modify: `packages/core/src/workflow/executor.test.ts`

### Step 3.1 — Write the failing executor test

Add the following test to the **end** of `packages/core/src/workflow/executor.test.ts`.

First, add these imports if not already present at the top of the file:
```ts
import { TRACE_KIND_WORKFLOW_STEP_END, type TraceEvent } from "../tracer.ts";
```

Then add the test:

```ts
test("executor: failed step emits errorKind in TRACE_KIND_WORKFLOW_STEP_END", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const events: TraceEvent[] = [];
    // Reopen tracer with observer to capture events
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { Tracer: T } = await import("../tracer.ts");
    const observingTracer = await T.open(dir + "/obs", "obs", {
      observers: [(e) => events.push(e)],
    });

    const dispatch = async (): Promise<ToolResult> => ({
      ok: false,
      error: { kind: "runtime_error", message: "boom" },
    });
    const exec = new WorkflowExecutor({ tracer: observingTracer });
    await exec.run(TWO_STEP, {}, dispatch, 0);

    const stepEndEvent = events.find(
      (e) => e.kind === TRACE_KIND_WORKFLOW_STEP_END && e.data.ok === false,
    );
    assert.ok(stepEndEvent, "expected a failed workflow-step-end event");
    assert.equal(stepEndEvent.data.errorKind, "runtime_error");
    await observingTracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

First, update the existing `"../tracer.ts"` import at the top of `executor.test.ts` to add the new names:

```ts
// Before:
import { Tracer } from "../tracer.ts";
// After:
import { Tracer, TRACE_KIND_WORKFLOW_STEP_END, type TraceEvent } from "../tracer.ts";
```

Then add the test. `mkdtemp`, `rm`, `join`, `tmpdir` are already statically imported at the top of this file — do not duplicate them:

```ts
test("executor: failed step emits errorKind in TRACE_KIND_WORKFLOW_STEP_END", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exec-err-"));
  try {
    const events: TraceEvent[] = [];
    const tracer = await Tracer.open(join(dir, "traces"), "s", {
      observers: [(e) => events.push(e)],
    });

    const dispatch = async (): Promise<ToolResult> => ({
      ok: false,
      error: { kind: "runtime_error", message: "boom" },
    });
    const exec = new WorkflowExecutor({ tracer });
    await exec.run(TWO_STEP, {}, dispatch, 0);

    const stepEndEvent = events.find(
      (e) => e.kind === TRACE_KIND_WORKFLOW_STEP_END && e.data.ok === false,
    );
    assert.ok(stepEndEvent, "expected a failed workflow-step-end event");
    assert.equal(stepEndEvent.data.errorKind, "runtime_error");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

### Step 3.2 — Run the test to confirm it fails

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/workflow/executor.test.ts \
  --test-name-pattern "errorKind"
```

Expected: `stepEndEvent.data.errorKind` is `undefined`, assertion fails.

### Step 3.3 — Implement in `executor.ts`

In `packages/core/src/workflow/executor.ts`, find the `TRACE_KIND_WORKFLOW_STEP_END` log call (currently logging `{ workflow, label, tool, ok, durationMs }`) and add `errorKind` on failure:

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

### Step 3.4 — Run all executor tests

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/workflow/executor.test.ts
```

Expected: all tests pass.

### Step 3.5 — Typecheck

```bash
npm run typecheck
```

- [ ] Step 3.1 — Write failing executor test
- [ ] Step 3.2 — Run test, confirm it fails
- [ ] Step 3.3 — Add `errorKind` to `TRACE_KIND_WORKFLOW_STEP_END` in `executor.ts`
- [ ] Step 3.4 — Run all executor tests, confirm they pass
- [ ] Step 3.5 — Typecheck

---

## Task 4: Derive `outputShape` from last step in `lift.ts`

**Files:**
- Modify: `packages/core/src/workflow/lift.ts`
- Modify: `packages/core/src/workflow/lift.test.ts`

### Step 4.1 — Write the failing lift tests

Add the following tests to the **end** of `packages/core/src/workflow/lift.test.ts`.

First, define two tools with distinct non-empty `outputShape` values near the top of the test file, alongside the existing `FETCH`, `FILTER`, `COUNT` constants:

```ts
const STRING_OUT: Tool = {
  ...FETCH,
  manifest: {
    ...FETCH.manifest,
    name: "string-tool",
    outputShape: { type: "string" },
  },
};
const NUMBER_OUT: Tool = {
  ...FETCH,
  manifest: {
    ...FETCH.manifest,
    name: "number-tool",
    outputShape: { type: "number" },
  },
};
```

Then add the tests:

```ts
test("lift: outputShape derived from last step's tool manifest", () => {
  const out = liftFromTrace({
    slice: [
      { name: "read-csv", args: {}, ok: true, value: ["row"] },
      { name: "string-tool", args: { rows: ["row"] }, ok: true, value: "result" },
    ],
    name: "csv-to-string",
    description: "",
    goal: "",
    toolsByName: { "read-csv": FETCH, "string-tool": STRING_OUT },
  });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.manifest.outputShape, { type: "string" });
});

test("lift: outputShape is last step's shape, not first step's", () => {
  const out = liftFromTrace({
    slice: [
      { name: "number-tool", args: {}, ok: true, value: 1 },
      { name: "string-tool", args: { n: 1 }, ok: true, value: "done" },
    ],
    name: "num-then-str",
    description: "",
    goal: "",
    toolsByName: { "number-tool": NUMBER_OUT, "string-tool": STRING_OUT },
  });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.manifest.outputShape, { type: "string" });
});

test("lift: outputShape falls back to {} when last step's resultBinding is null", () => {
  // A single-step trace where the step discards its result (resultBinding: null).
  // liftFromTrace always sets resultBinding = `r_${i}_${safe}`, so we need to
  // check via a step that would produce null — this is an edge case covered by
  // deriveWorkflowOutputShape internally. Verify {} is the output when the
  // tool itself has outputShape: {}.
  const out = liftFromTrace({
    slice: [{ name: "read-csv", args: {}, ok: true, value: ["row"] }],
    name: "just-read",
    description: "",
    goal: "",
    toolsByName: { "read-csv": FETCH },
  });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  // FETCH.manifest.outputShape is {} — derives through
  assert.deepEqual(out.manifest.outputShape, {});
});
```

### Step 4.2 — Run the tests to confirm they fail

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/workflow/lift.test.ts \
  --test-name-pattern "outputShape"
```

Expected: the first two tests fail — `outputShape` is currently always `{}`.

### Step 4.3 — Implement in `lift.ts`

In `packages/core/src/workflow/lift.ts`, add the following private helper function **before** `liftFromTrace`:

```ts
/**
 * Derives the workflow's `outputShape` from the last step's tool manifest.
 * Returns `{}` when the last step discards its result (`resultBinding === null`)
 * or when the last step's tool is not found in the registry snapshot.
 */
function deriveWorkflowOutputShape(
  steps: ToolCallStep[],
  toolsByName: Record<string, Tool>,
): Record<string, unknown> {
  if (steps.length === 0) return {};
  const lastStep = steps[steps.length - 1]!;
  if (lastStep.resultBinding === null) return {};
  return toolsByName[lastStep.tool]?.manifest.outputShape ?? {};
}
```

Then, in the manifest construction inside `liftFromTrace`, change:

```ts
outputShape: {}, permissions,
```

to:

```ts
outputShape: deriveWorkflowOutputShape(steps, req.toolsByName), permissions,
```

The `steps` variable is already in scope (computed two lines above). The `req.toolsByName` is the registry snapshot parameter.

### Step 4.4 — Run all lift tests

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/workflow/lift.test.ts
```

Expected: all tests pass.

### Step 4.5 — Typecheck

```bash
npm run typecheck
```

- [ ] Step 4.1 — Write failing lift tests
- [ ] Step 4.2 — Run tests, confirm they fail
- [ ] Step 4.3 — Add `deriveWorkflowOutputShape` + wire into manifest
- [ ] Step 4.4 — Run all lift tests, confirm they pass
- [ ] Step 4.5 — Typecheck

---

## Task 5: Output-shape repair loop in `ToolFactory.createWithPrompt`

**Files:**
- Modify: `packages/core/src/factory/factory.ts`
- Modify: `packages/core/src/factory/factory.test.ts`

### Step 5.1 — Write the failing factory tests

Add the following tests to the **end** of `packages/core/src/factory/factory.test.ts`.

First, check the imports at the top of `factory.test.ts` and add any that are missing:

```ts
import { TOOL_ERROR_KIND } from "../types.ts";
```

Then add these tests. They use `MockLLMProvider.onStructured` to control what drafts the LLM returns, and a real `NodePermissionSandbox` that will actually run the code:

```ts
// A draft whose code always returns the wrong shape (string instead of declared number)
const WRONG_OUTPUT_DRAFT: ToolDraft = {
  name: "wrong-output",
  description: "Returns wrong shape.",
  rationale: "test",
  inputSchema: { type: "object" },
  outputShape: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
  permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  code: `export async function run(_i) { return { n: "oops" }; }`,
  dependencies: [],
  smokeTestInput: {},
  kind: "atomic",
};

// A draft that fixes the shape on retry
const FIXED_OUTPUT_DRAFT: ToolDraft = {
  ...WRONG_OUTPUT_DRAFT,
  code: `export async function run(_i) { return { n: 42 }; }`,
};

test("factory: smoke output violating outputShape enters repair loop and succeeds on fix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fac-osv-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    // LLM: first returns wrong draft, second (repair) returns fixed draft
    const llm = new MockLLMProvider()
      .onStructured<ToolDraft>(() => WRONG_OUTPUT_DRAFT)
      .onStructured<ToolDraft>(() => FIXED_OUTPUT_DRAFT);
    const prompter = {
      promptGate1: async () => ({ kind: GATE1_KIND.CODE, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false }),
      promptGate23: async () => { throw new Error("no"); },
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const out = await factory.createAtomic({ intent: "test", rationale: "test", existingToolsConsidered: [] });
    assert.equal(out.ok, true, `expected ok:true but got: ${JSON.stringify(out)}`);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("factory: smoke output violating outputShape exhausts repair and rejects tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fac-osv-exhaust-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    // LLM always returns the wrong draft (maxRepair = 2 by default, so 3 total attempts)
    const llm = new MockLLMProvider()
      .onStructured<ToolDraft>(() => WRONG_OUTPUT_DRAFT)
      .onStructured<ToolDraft>(() => WRONG_OUTPUT_DRAFT)
      .onStructured<ToolDraft>(() => WRONG_OUTPUT_DRAFT);
    const prompter = {
      promptGate1: async () => { throw new Error("should not reach Gate 1"); },
      promptGate23: async () => { throw new Error("no"); },
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const out = await factory.createAtomic({ intent: "test", rationale: "test", existingToolsConsidered: [] });
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.ok(
        out.reason.includes("outputShape") || out.reason.includes("output_schema"),
        `expected outputShape error in reason, got: ${out.reason}`,
      );
    }
    assert.equal(await registry.has("wrong-output"), false, "rejected tool must not be in registry");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

### Step 5.2 — Run the failing tests

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/factory/factory.test.ts \
  --test-name-pattern "smoke output"
```

Expected: first test fails (tool is approved even with wrong output), second test fails (Gate 1 is reached despite wrong output).

### Step 5.3 — Add import to `factory.ts`

Add `validateToolOutput` import at the top of `packages/core/src/factory/factory.ts`, alongside the existing local imports:

```ts
import { validateToolOutput } from "../agent/validate-tool-output.ts";
```

### Step 5.4 — Add the output-shape repair loop in `createWithPrompt`

In `packages/core/src/factory/factory.ts`, find the `createWithPrompt` private method. Locate this block near the end of the method:

```ts
    return this.presentAndSave(draft, smoke);
  }
```

Replace it with:

```ts
    // NEW: check smoke output against declared outputShape
    const outputCheck = validateToolOutput(draft.outputShape, smoke.value);
    if (!outputCheck.ok) {
      attempts = 0;
      // currentFailure tracks the real current error so each repair call
      // receives the actual failure, not the original one.
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
        if (retryCheck.ok) { return this.presentAndSave(draft, retry, existingNames); }
        currentFailure = `smoke output does not match outputShape: ${retryCheck.error.message}`;
      }
      this.opts.tracer.log(TRACE_KIND_TOOL_REJECTED, {
        name: draft.name,
        reason: `smoke output schema: ${currentFailure}`,
      });
      return { ok: false, reason: currentFailure };
    }

    return this.presentAndSave(draft, smoke, existingNames);
  }
```

Note: `existingNames` is threaded into `presentAndSave` — you will update `presentAndSave`'s signature in Task 6. For now, TypeScript will report an error on those calls; that is expected until Task 6 is complete.

Also update the two other `presentAndSave` calls earlier in `createWithPrompt` (inside the existing smoke-repair loop) to also pass `existingNames`:

Find:
```ts
        if (retry.ok) { return this.presentAndSave(draft, retry); }
```
Replace with:
```ts
        if (retry.ok) { return this.presentAndSave(draft, retry, existingNames); }
```

And the unconditional path at the original end of the method (before you added the new block) was replaced above. There should now be exactly three `this.presentAndSave(...)` calls in `createWithPrompt`, all passing `existingNames`.

### Step 5.5 — Run factory tests (can proceed now)

At this point `presentAndSave` still has the old 2-parameter signature in TypeScript, but `--experimental-transform-types` strips types and does not type-check: the extra `existingNames` argument is silently ignored by JavaScript at runtime. Tests can run and should demonstrate the repair-loop behavior:

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/factory/factory.test.ts \
  --test-name-pattern "smoke output"
```

Expected: the repair-and-succeed test passes; the exhaust-and-reject test passes. Proceed to Task 6 to complete the `presentAndSave` signature and enable the edited-draft re-validation.

- [ ] Step 5.1 — Write failing factory tests
- [ ] Step 5.2 — Run tests, confirm they fail
- [ ] Step 5.3 — Add `validateToolOutput` import to `factory.ts`
- [ ] Step 5.4 — Add output-shape repair loop; update `presentAndSave` call sites
- [ ] Step 5.5 — Note: typecheck deferred to Task 6

---

## Task 6: Edited-draft re-validation in `ToolFactory.presentAndSave`

**Files:**
- Modify: `packages/core/src/factory/factory.ts`
- Modify: `packages/core/src/factory/factory.test.ts`

### Step 6.1 — Write the failing edited-draft test

Add the following test to the **end** of `packages/core/src/factory/factory.test.ts`. This test simulates a reviewer who edits the draft code to break it, ensuring the factory rejects the edited result.

```ts
test("factory: presentAndSave re-validates edited draft and rejects if output violates outputShape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fac-edit-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider().onStructured<ToolDraft>(() => GOOD_DRAFT);
    // Gate 1 reviewer returns an edited draft whose code now returns the wrong shape
    const brokenEditedDraft: ToolDraft = {
      ...GOOD_DRAFT,
      code: `export async function run(i){ return { doubled: "oops" }; }`,  // string instead of integer
    };
    const prompter = {
      promptGate1: async (payload: Gate1ReviewPayload) => ({
        kind: GATE1_KIND.CODE,
        decision: APPROVAL_DECISION.APPROVE,
        alwaysApprove: false,
        editedDraft: payload.kind === GATE1_KIND.CODE ? brokenEditedDraft : undefined,
      }),
      promptGate23: async () => { throw new Error("no"); },
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const out = await factory.createAtomic({ intent: "test", rationale: "test", existingToolsConsidered: [] });
    assert.equal(out.ok, false, "edited draft with wrong output shape must be rejected");
    assert.equal(await registry.has("double-int"), false, "broken tool must not be in registry");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

### Step 6.2 — Run the test to confirm it fails

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/factory/factory.test.ts \
  --test-name-pattern "re-validates edited"
```

Expected: test fails — the edited draft is currently saved without re-validation.

### Step 6.3 — Update `presentAndSave` signature and body

In `packages/core/src/factory/factory.ts`, update the `presentAndSave` private method.

**Change the signature** to accept `existingNames`:

```ts
private async presentAndSave(
  draft: ToolDraft,
  smoke: ToolResult,
  existingNames: Set<string>,
): Promise<FactoryOutcome> {
```

**Replace the body** with:

```ts
  const decision = await this.opts.approval.reviewDraft({ kind: GATE1_KIND.CODE, draft, smoke });
  if (decision.kind !== GATE1_KIND.CODE) {
    return { ok: false, reason: "unexpected decision kind from Gate 1 review" };
  }
  if (decision.decision === APPROVAL_DECISION.REJECT) {
    this.opts.tracer.log(TRACE_KIND_TOOL_REJECTED, { name: draft.name, reason: decision.reason });
    return { ok: false, reason: decision.reason };
  }

  const finalDraft = decision.editedDraft ?? draft;

  // NEW: if the reviewer edited the draft, re-run full creation-time validation before saving.
  // No retry loop — if the reviewer's edit is broken, surface the failure directly.
  if (decision.editedDraft) {
    const sv = staticValidateDraft(finalDraft, { existingNames, tombstoned: this.opts.tombstoned });
    if (!sv.ok) {
      this.opts.tracer.log(TRACE_KIND_TOOL_REJECTED, {
        name: finalDraft.name,
        reason: `edit failed static: ${sv.errors.join("; ")}`,
      });
      return { ok: false, reason: `edited draft failed static validation: ${sv.errors.join("; ")}` };
    }
    const editSmoke = await this.smokeTest(this.draftToTool(finalDraft), finalDraft.smokeTestInput);
    if (!editSmoke.ok) {
      this.opts.tracer.log(TRACE_KIND_TOOL_REJECTED, {
        name: finalDraft.name,
        reason: `edit failed smoke: ${editSmoke.error.message}`,
      });
      return { ok: false, reason: `edited draft failed smoke test: ${editSmoke.error.message}` };
    }
    const editOutputCheck = validateToolOutput(finalDraft.outputShape, editSmoke.value);
    if (!editOutputCheck.ok) {
      this.opts.tracer.log(TRACE_KIND_TOOL_REJECTED, {
        name: finalDraft.name,
        reason: `edit failed output schema: ${editOutputCheck.error.message}`,
      });
      return {
        ok: false,
        reason: `edited draft output does not match outputShape: ${editOutputCheck.error.message}`,
      };
    }
  }

  const tool = this.draftToTool(finalDraft);
  const approval: ApprovalRecord = {
    hash: tool.manifest.hash,
    approvedAt: new Date().toISOString(),
    approvedBy: this.approvedBy,
    alwaysApprove: decision.alwaysApprove,
    ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
  };
  await this.opts.registry.save(tool, approval);
  this.opts.tracer.log(TRACE_KIND_TOOL_CREATED, {
    name: tool.manifest.name,
    hash: tool.manifest.hash,
    approvedBy: this.approvedBy,
  });
  return { ok: true, tool, approval };
}
```

### Step 6.4 — Run all factory tests

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/factory/factory.test.ts
```

Expected: all tests pass.

### Step 6.5 — Typecheck

```bash
npm run typecheck
```

Expected: no errors. All three `presentAndSave` call sites now pass `existingNames`, and the signature matches.

- [ ] Step 6.1 — Write failing edited-draft test
- [ ] Step 6.2 — Run test, confirm it fails
- [ ] Step 6.3 — Update `presentAndSave` signature and body
- [ ] Step 6.4 — Run all factory tests, confirm they pass
- [ ] Step 6.5 — Typecheck

---

## Task 7: Full test suite + final verification

### Step 7.1 — Run the full core test suite

```bash
npm test -w @meta-agent/core
```

Expected: all tests pass. If any test was broken by the new output validation (e.g., an existing tool fixture has a non-empty `outputShape` that the test's mock sandbox violates), update that fixture's `outputShape` to `{}` or update the mock sandbox return value to match.

### Step 7.2 — Run full typecheck across all packages

```bash
npm run typecheck
```

Expected: no errors across `packages/core` and `packages/cli`.

### Step 7.3 — Smoke test the validate-tool-output module independently

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/agent/validate-tool-output.test.ts \
  packages/core/src/agent/agent-loop.test.ts \
  packages/core/src/workflow/executor.test.ts \
  packages/core/src/workflow/lift.test.ts \
  packages/core/src/factory/factory.test.ts
```

Expected: all pass.

- [ ] Step 7.1 — Run full core test suite
- [ ] Step 7.2 — Run typecheck across all packages
- [ ] Step 7.3 — Run targeted test files together

---

## Task 8: Code cleanup pass on all modified/created source files

Apply the `code-cleanup` skill to each source file touched in Tasks 1–6. Run one file at a time. Test files are excluded (they are not exported and have no public API surface).

**Skill checklist to apply to each file:**
```
- [ ] Protocol/id literals → const object + types aligned
- [ ] `as const` member keys → UPPERCASE (values unchanged)
- [ ] Repeated unions → named `export type` + JSDoc, wire signatures
- [ ] Magic numbers → named module constants
- [ ] Trace/event kinds → TRACE_KIND_* near Tracer, consumers updated
- [ ] Fat blocks → helpers with explicit params + preserved side-effect order
- [ ] Package index / cross-package imports updated
- [ ] Exported types / functions / classes → JSDoc with @param / @returns
- [ ] tsc clean for touched packages
```

### Step 8.1 — Cleanup `packages/core/src/agent/validate-tool-output.ts`

This is the new file with the only public export (`validateToolOutput`). Apply the skill:

- Verify `validateToolOutput` has JSDoc with `@param` and `@returns`.
- Verify there are no magic strings; `TOOL_ERROR_KIND.OUTPUT_SCHEMA_VIOLATION` is already a named constant.
- If the error-message prefix `"outputShape is not a valid JSON Schema: "` appears more than once, extract a constant.
- Run `npm run typecheck` — expect no errors.

### Step 8.2 — Cleanup `packages/core/src/types.ts`

- Verify the new `OUTPUT_SCHEMA_VIOLATION` key follows the SCREAMING_SNAKE naming convention already established by existing keys.
- Check that `TOOL_ERROR_KIND` and derived `ToolErrorKind` types are JSDoc-documented. Add if missing.
- Run `npm run typecheck` — expect no errors.

### Step 8.3 — Cleanup `packages/core/src/agent/agent-loop.ts`

Focus only on the `runWithTracing` method and the new `validateToolOutput` import:

- Verify `effectiveResult` variable name is clear and consistent throughout the method.
- Check whether the output-validation block is a good candidate for an extracted private helper (e.g., `applyOutputValidation`). Only extract if it would genuinely clarify `runWithTracing`'s flow; do not over-extract.
- Verify JSDoc on `runWithTracing` (it is private, so JSDoc only if behavior is non-obvious).
- Run `npm run typecheck`.

### Step 8.4 — Cleanup `packages/core/src/workflow/executor.ts`

- Verify the `errorKind` spread (`...(!result.ok ? { errorKind: result.error.kind } : {})`) reads clearly.
- Check JSDoc on any public methods touched.
- Run `npm run typecheck`.

### Step 8.5 — Cleanup `packages/core/src/workflow/lift.ts`

- Verify the new `deriveWorkflowOutputShape` helper has JSDoc (`@param steps`, `@param toolsByName`, `@returns`).
- Check whether `deriveWorkflowOutputShape` is module-private (it should not be exported).
- Run `npm run typecheck`.

### Step 8.6 — Cleanup `packages/core/src/factory/factory.ts`

- Verify the updated `presentAndSave` signature has JSDoc updated to include the new `existingNames` parameter.
- Check whether the new `if (decision.editedDraft)` block is clear or would benefit from an extracted private helper (e.g., `revalidateEditedDraft`). Extract only if the method body is meaningfully harder to read without it.
- Verify there are no new magic strings; all trace kind references should use imported constants.
- Run `npm run typecheck`.

### Step 8.7 — Final typecheck after all cleanup

```bash
npm run typecheck
```

Expected: no errors across `packages/core` and `packages/cli`.

- [ ] Step 8.1 — Cleanup `validate-tool-output.ts`
- [ ] Step 8.2 — Cleanup `types.ts`
- [ ] Step 8.3 — Cleanup `agent-loop.ts`
- [ ] Step 8.4 — Cleanup `executor.ts`
- [ ] Step 8.5 — Cleanup `lift.ts`
- [ ] Step 8.6 — Cleanup `factory.ts`
- [ ] Step 8.7 — Final typecheck

---

## Quick Reference: Key Invariants

| Invariant | Enforced by |
|---|---|
| Bad output never enters `ResultStore` | `storeDepth0Result` pre-existing `!result.ok` guard (no new code) |
| Bad output never passed as non-`undefined` to `onToolInvoked` | `value: effectiveResult.ok ? effectiveResult.value : undefined` |
| `output_schema_violation` visible in nested traces | `errorKind` added to `TRACE_KIND_TOOL_INVOKED` and `TRACE_KIND_WORKFLOW_STEP_END` |
| Smoke test enforces outputShape | Output-shape repair loop in `createWithPrompt` |
| Gate 1 edits can't bypass enforcement | `presentAndSave` re-validates edited drafts |
| Workflow `outputShape` is meaningful | `deriveWorkflowOutputShape` in `lift.ts` |
| Same schema compiled once | Module-level `validatorCache` in `validate-tool-output.ts` |
| Ajv error array not mutated after capture | `[...errors]` shallow copy |
