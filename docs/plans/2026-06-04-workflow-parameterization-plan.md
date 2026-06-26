# Workflow Parameterization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `/compose` promote chosen literal arguments of a lifted workflow into named, typed parameters of the resulting tool, each optionally required or defaulted to its original value.

**Architecture:** `liftFromTrace` stays pure (emits `inputs: []` + `literalFallbacks`). A new pure `parameterize` transform rewrites chosen `Literal` args into `SymRef`s targeting declared workflow `inputs`; the executor seeds those inputs at run time; the manifest's `inputSchema` is a projection of `inputs`. See [`../2026-06-04-workflow-parameterization-design.md`](../2026-06-04-workflow-parameterization-design.md).

**Tech Stack:** TypeScript (Node ≥25, `--experimental-transform-types`), `node:test` + `node:assert/strict`, Ajv for input-schema validation.

---

## Conventions for every task

- Run a single core test file: `npm test -w @meta-agent/core -- --test-name-pattern="<pattern>"` is not used here; instead run the file directly: `node --experimental-transform-types --test packages/core/src/workflow/<file>.test.ts`. If that runner differs in this repo, fall back to `npm test -w @meta-agent/core`.
- Typecheck after structural changes: `npm run typecheck`.
- Commit after each task with the message shown.

---

## File Structure

- **Create:** `packages/core/src/workflow/parameterize.ts` — `Promotion`, `parameterize()`, `jsonSchemaTypeOf()`.
- **Create:** `packages/core/src/workflow/parameterize.test.ts`.
- **Modify:** `packages/core/src/workflow/types.ts` — `WorkflowInput`; `Workflow.inputs: WorkflowInput[]`.
- **Modify:** `packages/core/src/workflow/schema.ts` — `WORKFLOW_INPUT_SCHEMA`; widen `inputs` items.
- **Modify:** `packages/core/src/workflow/lift.ts` — export `LiftError`; add `inputSchemaFromInputs()`.
- **Modify:** `packages/core/src/workflow/validator.ts` — drop v1 inputs guard; seed input scope; input checks.
- **Modify:** `packages/core/src/workflow/executor.ts` — seed inputs; drop runtime-inputs rejection.
- **Modify:** `packages/core/src/factory/factory.ts` — `previewWorkflow()`; `createWorkflow` accepts `promotions[]`.
- **Modify:** `packages/core/src/agent/agent-loop.ts` — validate workflow `inputSchema` before `executor.run`.
- **Modify:** `packages/cli/src/compose.ts` — interactive promotion loop.

---

## Task 1: Widen the IR — `WorkflowInput` type and JSON Schema

**Files:**
- Modify: `packages/core/src/workflow/types.ts`
- Modify: `packages/core/src/workflow/schema.ts`

- [ ] **Step 1: Add `WorkflowInput` and change `Workflow.inputs` in `types.ts`**

Replace the `Workflow` type's `inputs` field and add the new type above it:

```typescript
/**
 * A declared workflow parameter. In scope as a binding from step 0, so a
 * `SymRef` may target its `name`. Created by promoting a lifted literal.
 */
export type WorkflowInput = {
  name: string;                     // matches /^[a-z_][a-z0-9_]*$/i; unique; no collision with a resultBinding
  schema: Record<string, unknown>;  // inferred JSON Schema fragment, e.g. { type: "string" }
  required: boolean;
  default?: unknown;                // present iff required === false (the original literal value)
  description?: string;
};

export type WorkflowReturn = { source: SymRef } | null;

export type Workflow = {
  schemaVersion: IrSchemaVersion;
  name: string;
  description: string;
  goal: string;
  /** Declared parameters; `[]` for a closed (non-parameterized) workflow. */
  inputs: WorkflowInput[];
  steps: Step[];
  return: WorkflowReturn;
};
```

(Delete the previous `inputs: string[]` line and the previous `WorkflowReturn`/`Workflow` declarations they were part of.)

- [ ] **Step 2: Widen the `inputs` items in `schema.ts`**

Add this constant above `WORKFLOW_SCHEMA`:

```typescript
export const WORKFLOW_INPUT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    schema: { type: "object" },
    required: { type: "boolean" },
    default: {},
    description: { type: "string" },
  },
  required: ["name", "schema", "required"],
  additionalProperties: false,
} as const;
```

Then change the `inputs` line inside `WORKFLOW_SCHEMA.properties` from:

```typescript
    inputs: { type: "array", items: { type: "string", minLength: 1 } },
```

to:

```typescript
    inputs: { type: "array", items: WORKFLOW_INPUT_SCHEMA },
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (`liftFromTrace` builds `inputs: []`, which is still assignable.)

- [ ] **Step 4: Run the existing workflow tests to confirm no regression**

Run: `npm test -w @meta-agent/core`
Expected: PASS (existing tests use `inputs: []`).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow/types.ts packages/core/src/workflow/schema.ts
git commit -m "feat(workflow): widen IR inputs to typed WorkflowInput[]"
```

---

## Task 2: The `parameterize` transform

**Files:**
- Create: `packages/core/src/workflow/parameterize.ts`
- Create: `packages/core/src/workflow/parameterize.test.ts`
- Modify: `packages/core/src/workflow/lift.ts` (export `LiftError`)

- [ ] **Step 1: Export `LiftError` from `lift.ts`**

It is already declared as `export type LiftError = { code: string; message: string };` — confirm it is exported (it is). No change needed beyond verifying; if it is not exported, add `export`.

- [ ] **Step 2: Write the failing test `parameterize.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parameterize, jsonSchemaTypeOf } from "./parameterize.ts";
import { ARG_KIND, STEP_KIND, IR_SCHEMA_VERSION, type Workflow } from "./types.ts";

function baseWorkflow(): Workflow {
  return {
    schemaVersion: IR_SCHEMA_VERSION,
    name: "summarize_paper",
    description: "",
    goal: "",
    inputs: [],
    steps: [
      {
        kind: STEP_KIND.tool_call,
        label: "step_0_fetch_webpage_text",
        tool: "fetch-webpage-text",
        arguments: { url: { kind: ARG_KIND.literal, value: "https://example.com/p.md" } },
        resultBinding: "r_0_fetch_webpage_text",
      },
      {
        kind: STEP_KIND.tool_call,
        label: "step_1_write_file_text",
        tool: "write-file-text",
        arguments: {
          content: { kind: ARG_KIND.symref, ref: "r_0_fetch_webpage_text" },
          path: { kind: ARG_KIND.literal, value: "./out.md" },
        },
        resultBinding: "r_1_write_file_text",
      },
    ],
    return: { source: { kind: ARG_KIND.symref, ref: "r_1_write_file_text" } },
  };
}

test("jsonSchemaTypeOf infers JSON types", () => {
  assert.deepEqual(jsonSchemaTypeOf("x"), { type: "string" });
  assert.deepEqual(jsonSchemaTypeOf(3), { type: "number" });
  assert.deepEqual(jsonSchemaTypeOf(true), { type: "boolean" });
  assert.deepEqual(jsonSchemaTypeOf([1]), { type: "array" });
  assert.deepEqual(jsonSchemaTypeOf(null), { type: "null" });
  assert.deepEqual(jsonSchemaTypeOf({ a: 1 }), { type: "object" });
});

test("parameterize: optional promotion stores default = original literal and rewrites to symref", () => {
  const out = parameterize(baseWorkflow(), [
    { stepLabel: "step_0_fetch_webpage_text", argName: "url", paramName: "url", required: false, description: "paper url" },
  ]);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.workflow.inputs, [
    { name: "url", schema: { type: "string" }, required: false, default: "https://example.com/p.md", description: "paper url" },
  ]);
  assert.deepEqual(out.workflow.steps[0]!.arguments.url, { kind: ARG_KIND.symref, ref: "url" });
});

test("parameterize: required promotion omits default", () => {
  const out = parameterize(baseWorkflow(), [
    { stepLabel: "step_1_write_file_text", argName: "path", paramName: "path", required: true },
  ]);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.workflow.inputs.length, 1);
  assert.equal(out.workflow.inputs[0]!.name, "path");
  assert.equal("default" in out.workflow.inputs[0]!, false);
});

test("parameterize: shared paramName across two occurrences collapses to one input", () => {
  const wf = baseWorkflow();
  wf.steps[0]!.arguments.dup = { kind: ARG_KIND.literal, value: "same" };
  wf.steps[1]!.arguments.dup = { kind: ARG_KIND.literal, value: "same" };
  const out = parameterize(wf, [
    { stepLabel: "step_0_fetch_webpage_text", argName: "dup", paramName: "shared", required: true },
    { stepLabel: "step_1_write_file_text", argName: "dup", paramName: "shared", required: true },
  ]);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.workflow.inputs.length, 1);
  assert.deepEqual(out.workflow.steps[0]!.arguments.dup, { kind: ARG_KIND.symref, ref: "shared" });
  assert.deepEqual(out.workflow.steps[1]!.arguments.dup, { kind: ARG_KIND.symref, ref: "shared" });
});

test("parameterize: error when target step/arg missing", () => {
  const out = parameterize(baseWorkflow(), [
    { stepLabel: "nope", argName: "url", paramName: "u", required: true },
  ]);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.errors[0]!.code, "promotion_target_missing");
});

test("parameterize: error when target arg is not a literal", () => {
  const out = parameterize(baseWorkflow(), [
    { stepLabel: "step_1_write_file_text", argName: "content", paramName: "c", required: true },
  ]);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.errors[0]!.code, "promotion_target_not_literal");
});

test("parameterize: error on conflicting metadata for shared name", () => {
  const wf = baseWorkflow();
  wf.steps[0]!.arguments.dup = { kind: ARG_KIND.literal, value: "a" };
  wf.steps[1]!.arguments.dup = { kind: ARG_KIND.literal, value: 7 };
  const out = parameterize(wf, [
    { stepLabel: "step_0_fetch_webpage_text", argName: "dup", paramName: "shared", required: true },
    { stepLabel: "step_1_write_file_text", argName: "dup", paramName: "shared", required: true },
  ]);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.errors[0]!.code, "promotion_name_conflict");
});

test("parameterize: deterministic — same input twice yields identical output", () => {
  const promos = [{ stepLabel: "step_0_fetch_webpage_text", argName: "url", paramName: "url", required: false }];
  const a = parameterize(baseWorkflow(), promos);
  const b = parameterize(baseWorkflow(), promos);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(JSON.stringify(a.workflow), JSON.stringify(b.workflow));
});

test("parameterize: no promotions returns an equivalent workflow", () => {
  const out = parameterize(baseWorkflow(), []);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.workflow.inputs, []);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --experimental-transform-types --test packages/core/src/workflow/parameterize.test.ts`
Expected: FAIL — `Cannot find module './parameterize.ts'`.

- [ ] **Step 4: Implement `parameterize.ts`**

```typescript
import { ARG_KIND, type Argument, type ToolCallStep, type Workflow, type WorkflowInput } from "./types.ts";
import type { LiftError } from "./lift.ts";

/** A user-chosen promotion of one literal argument into a named workflow parameter. */
export type Promotion = {
  stepLabel: string;
  argName: string;
  paramName: string;
  required: boolean;
  description?: string;
};

export type ParameterizeResult =
  | { ok: true; workflow: Workflow }
  | { ok: false; errors: LiftError[] };

/** Infers a shallow JSON Schema fragment ({ type }) from a concrete value. */
export function jsonSchemaTypeOf(value: unknown): Record<string, unknown> {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array" };
  switch (typeof value) {
    case "string": return { type: "string" };
    case "number": return { type: "number" };
    case "boolean": return { type: "boolean" };
    default: return { type: "object" };
  }
}

function findStep(workflow: Workflow, label: string): ToolCallStep | undefined {
  return workflow.steps.find((s) => s.label === label);
}

/**
 * Rewrites chosen literal arguments into SymRefs that target declared workflow
 * inputs. Pure and deterministic. Scope/name-format/collision rules are left to
 * the validator (run immediately after) so there is a single source of truth.
 */
export function parameterize(workflow: Workflow, promotions: Promotion[]): ParameterizeResult {
  const errors: LiftError[] = [];
  // Deep clone via JSON: IR is plain JSON by construction.
  const wf: Workflow = JSON.parse(JSON.stringify(workflow));
  const inputsByName = new Map<string, WorkflowInput>();

  for (const p of promotions) {
    const step = findStep(wf, p.stepLabel);
    const arg = step?.arguments[p.argName];
    if (!step || arg === undefined) {
      errors.push({ code: "promotion_target_missing", message: `no argument '${p.argName}' on step '${p.stepLabel}'` });
      continue;
    }
    if (arg.kind !== ARG_KIND.literal) {
      errors.push({ code: "promotion_target_not_literal", message: `argument '${p.argName}' on step '${p.stepLabel}' is not a literal` });
      continue;
    }

    const schema = jsonSchemaTypeOf(arg.value);
    const input: WorkflowInput = {
      name: p.paramName,
      schema,
      required: p.required,
      ...(p.required ? {} : { default: arg.value }),
      ...(p.description !== undefined ? { description: p.description } : {}),
    };

    const existing = inputsByName.get(p.paramName);
    if (existing) {
      const sameSchema = JSON.stringify(existing.schema) === JSON.stringify(schema);
      const sameRequired = existing.required === p.required;
      const sameDefault = JSON.stringify(existing.default) === JSON.stringify(input.default);
      if (!sameSchema || !sameRequired || !sameDefault) {
        errors.push({ code: "promotion_name_conflict", message: `parameter '${p.paramName}' promoted with conflicting type/required/default` });
        continue;
      }
    } else {
      inputsByName.set(p.paramName, input);
    }

    const newArg: Argument = { kind: ARG_KIND.symref, ref: p.paramName };
    step.arguments[p.argName] = newArg;
  }

  if (errors.length > 0) return { ok: false, errors };

  wf.inputs = Array.from(inputsByName.values());
  return { ok: true, workflow: wf };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --experimental-transform-types --test packages/core/src/workflow/parameterize.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/workflow/parameterize.ts packages/core/src/workflow/parameterize.test.ts
git commit -m "feat(workflow): add parameterize transform promoting literals to inputs"
```

---

## Task 3: `inputSchemaFromInputs` projection helper

**Files:**
- Modify: `packages/core/src/workflow/lift.ts`
- Modify: `packages/core/src/workflow/lift.test.ts`

- [ ] **Step 1: Write the failing test (append to `lift.test.ts`)**

Add the import at the top (extend the existing `./lift.ts` import):

```typescript
import { liftFromTrace, inputSchemaFromInputs } from "./lift.ts";
```

Append these tests:

```typescript
test("inputSchemaFromInputs: empty inputs project to {}", () => {
  assert.deepEqual(inputSchemaFromInputs([]), {});
});

test("inputSchemaFromInputs: required, defaults, and descriptions project correctly", () => {
  const schema = inputSchemaFromInputs([
    { name: "path", schema: { type: "string" }, required: true },
    { name: "url", schema: { type: "string" }, required: false, default: "https://x", description: "the url" },
  ]);
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      path: { type: "string" },
      url: { type: "string", description: "the url", default: "https://x" },
    },
    required: ["path"],
    additionalProperties: false,
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-transform-types --test packages/core/src/workflow/lift.test.ts`
Expected: FAIL — `inputSchemaFromInputs is not a function`.

- [ ] **Step 3: Implement `inputSchemaFromInputs` in `lift.ts`**

Add the import of `WorkflowInput` to the existing `./types.ts` import line, then add the exported function (near the top-level helpers):

```typescript
import { IR_SCHEMA_VERSION, STEP_KIND, ARG_KIND, type Argument, type ToolCallStep, type Workflow, type WorkflowInput } from "./types.ts";

/**
 * Projects declared workflow inputs into a JSON Schema for the manifest's
 * `inputSchema`. Empty inputs project to `{}` (a closed workflow). Defaults and
 * descriptions are advertised for the LLM; defaults are applied by the executor.
 */
export function inputSchemaFromInputs(inputs: WorkflowInput[]): Record<string, unknown> {
  if (inputs.length === 0) return {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const inp of inputs) {
    properties[inp.name] = {
      ...inp.schema,
      ...(inp.description !== undefined ? { description: inp.description } : {}),
      ...(inp.default !== undefined ? { default: inp.default } : {}),
    };
    if (inp.required) required.push(inp.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --experimental-transform-types --test packages/core/src/workflow/lift.test.ts`
Expected: PASS (existing lift tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow/lift.ts packages/core/src/workflow/lift.test.ts
git commit -m "feat(workflow): project workflow inputs into manifest inputSchema"
```

---

## Task 4: Validator — allow inputs, seed scope, add input checks

**Files:**
- Modify: `packages/core/src/workflow/validator.ts`
- Modify: `packages/core/src/workflow/validator.test.ts`

- [ ] **Step 1: Write the failing tests (append to `validator.test.ts`)**

Use the existing test helpers/registry mock in that file. Add tests that build a parameterized workflow:

```typescript
test("validator: input SymRef resolves in scope; parameterized workflow is valid", async () => {
  const wf: Workflow = {
    schemaVersion: 1, name: "p", description: "", goal: "",
    inputs: [{ name: "url", schema: { type: "string" }, required: true }],
    steps: [{
      kind: "tool_call", label: "s0", tool: "fetch-webpage-text",
      arguments: { url: { kind: "symref", ref: "url" } }, resultBinding: "r0",
    }],
    return: { source: { kind: "symref", ref: "r0" } },
  };
  const res = await validate(wf, registry); // `registry` = the file's mock that knows fetch-webpage-text
  assert.equal(res.ok, true, res.ok ? "" : res.errors.map((e) => e.code).join(","));
});

test("validator: invalid_input_name", async () => {
  const wf = paramWf({ name: "1bad", schema: { type: "string" }, required: true });
  const res = await validate(wf, registry);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.code === "invalid_input_name"));
});

test("validator: duplicate_input", async () => {
  const wf = paramWf(
    { name: "x", schema: { type: "string" }, required: true },
    { name: "x", schema: { type: "string" }, required: true },
  );
  const res = await validate(wf, registry);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.code === "duplicate_input"));
});

test("validator: input_binding_collision", async () => {
  // input name equals a step resultBinding
  const wf = paramWf({ name: "r0", schema: { type: "string" }, required: true });
  const res = await validate(wf, registry);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.code === "input_binding_collision"));
});

test("validator: optional_input_missing_default", async () => {
  const wf = paramWf({ name: "x", schema: { type: "string" }, required: false }); // no default
  const res = await validate(wf, registry);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.code === "optional_input_missing_default"));
});

test("validator: invalid_input_schema", async () => {
  const wf = paramWf({ name: "x", schema: null as unknown as Record<string, unknown>, required: true });
  const res = await validate(wf, registry);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.code === "invalid_input_schema"));
});
```

Add a `paramWf` helper near the top of the test file (adjust the tool name to one the file's `registry` mock resolves; reuse the existing mock pattern):

```typescript
function paramWf(...inputs: Workflow["inputs"]): Workflow {
  return {
    schemaVersion: 1, name: "p", description: "", goal: "",
    inputs,
    steps: [{
      kind: "tool_call", label: "s0", tool: "fetch-webpage-text",
      arguments: {}, resultBinding: "r0",
    }],
    return: null,
  };
}
```

> If `validator.test.ts` does not already expose a `registry` mock that resolves a real tool with a permissive `inputSchema` (`{}` or no `required`), reuse the registry-construction pattern from `lift.test.ts` (the `ToolRegistry` literal with `get: async (n) => tools[n] ?? null`) and a `fetch-webpage-text` tool whose `inputSchema` is `{}`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-transform-types --test packages/core/src/workflow/validator.test.ts`
Expected: FAIL — parameterized workflow currently rejected by `inputs_not_supported_in_v1`; new codes absent.

- [ ] **Step 3: Edit `validator.ts`**

Remove the v1 inputs guard block:

```typescript
  if (workflow.inputs.length !== 0) {
    pushValidationError(errors, "inputs_not_supported_in_v1", "workflow.inputs must be [] in v1; tier B / COMPOSE will widen", { pointer: "/inputs", });
  }
```

Replace the binding-set initialization. Change:

```typescript
  const seenLabels = new Set<string>();
  const bindings = new Set<string>();
```

to seed inputs and pre-collect result bindings for collision detection:

```typescript
  const seenLabels = new Set<string>();
  const bindings = new Set<string>();

  const resultBindings = new Set<string>();
  for (const s of workflow.steps) {
    if (s.kind === STEP_KIND.tool_call && s.resultBinding !== null) resultBindings.add(s.resultBinding);
  }

  const seenInputs = new Set<string>();
  for (let i = 0; i < workflow.inputs.length; i++) {
    const inp = workflow.inputs[i]!;
    const ptr = `/inputs/${i}`;
    if (!BINDING_NAME.test(inp.name)) {
      pushValidationError(errors, "invalid_input_name", `input name '${inp.name}' must match /^[a-z_][a-z0-9_]*$/i`, { pointer: `${ptr}/name` });
    }
    if (seenInputs.has(inp.name)) {
      pushValidationError(errors, "duplicate_input", `input '${inp.name}' is declared more than once`, { pointer: `${ptr}/name` });
    }
    seenInputs.add(inp.name);
    if (resultBindings.has(inp.name)) {
      pushValidationError(errors, "input_binding_collision", `input '${inp.name}' collides with a step resultBinding`, { pointer: `${ptr}/name` });
    }
    if (inp.required === false && !("default" in inp)) {
      pushValidationError(errors, "optional_input_missing_default", `optional input '${inp.name}' must declare a default`, { pointer: ptr });
    }
    if (inp.schema === null || typeof inp.schema !== "object" || Array.isArray(inp.schema)) {
      pushValidationError(errors, "invalid_input_schema", `input '${inp.name}' schema must be an object`, { pointer: `${ptr}/schema` });
    }
    // Inputs are in scope from step 0.
    bindings.add(inp.name);
  }
```

The existing steps loop (with its `unbound_symref` check via `bindings`) now resolves input SymRefs automatically because `bindings` is pre-seeded.

> Note: there is a pre-existing line `if (... && !bindings.has(step.resultBinding)) bindings.add(step.resultBinding);`. With inputs seeded into `bindings`, a `resultBinding` equal to an input name will be caught by `input_binding_collision` above; keep the existing duplicate-binding logic unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `node --experimental-transform-types --test packages/core/src/workflow/validator.test.ts`
Expected: PASS (existing + new). Confirm the old `inputs_not_supported_in_v1` positive test, if present, is removed/updated — search the file for that code and delete that single test.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow/validator.ts packages/core/src/workflow/validator.test.ts
git commit -m "feat(workflow): validate workflow inputs and resolve input symrefs in scope"
```

---

## Task 5: Executor — seed inputs, drop runtime-inputs rejection

**Files:**
- Modify: `packages/core/src/workflow/executor.ts`
- Modify: `packages/core/src/workflow/executor.test.ts`

- [ ] **Step 1: Write the failing tests (append to `executor.test.ts`)**

Reuse the file's existing dispatch/tracer setup pattern. Add a small workflow with one input-consuming step and a stub dispatch that echoes its args:

```typescript
test("executor: seeds required input from runtimeInputs", async () => {
  const tracer = await Tracer.open(await mkdtemp(join(tmpdir(), "wf-")), "t"); // match existing helper
  const exec = new WorkflowExecutor({ tracer });
  const wf: Workflow = {
    schemaVersion: 1, name: "p", description: "", goal: "",
    inputs: [{ name: "url", schema: { type: "string" }, required: true }],
    steps: [{ kind: "tool_call", label: "s0", tool: "echo",
      arguments: { url: { kind: "symref", ref: "url" } }, resultBinding: "r0" }],
    return: { source: { kind: "symref", ref: "r0" } },
  };
  const dispatch = async (_n: string, args: unknown) => ({ ok: true as const, value: args });
  const res = await exec.run(wf, { url: "https://a" }, dispatch, 0);
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.value, { url: "https://a" });
  await tracer.close();
});

test("executor: optional input falls back to default when omitted", async () => {
  const tracer = await Tracer.open(await mkdtemp(join(tmpdir(), "wf-")), "t");
  const exec = new WorkflowExecutor({ tracer });
  const wf: Workflow = {
    schemaVersion: 1, name: "p", description: "", goal: "",
    inputs: [{ name: "path", schema: { type: "string" }, required: false, default: "./d.md" }],
    steps: [{ kind: "tool_call", label: "s0", tool: "echo",
      arguments: { path: { kind: "symref", ref: "path" } }, resultBinding: "r0" }],
    return: { source: { kind: "symref", ref: "r0" } },
  };
  const dispatch = async (_n: string, args: unknown) => ({ ok: true as const, value: args });
  const res = await exec.run(wf, {}, dispatch, 0);
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.value, { path: "./d.md" });
  await tracer.close();
});

test("executor: missing required input fails", async () => {
  const tracer = await Tracer.open(await mkdtemp(join(tmpdir(), "wf-")), "t");
  const exec = new WorkflowExecutor({ tracer });
  const wf: Workflow = {
    schemaVersion: 1, name: "p", description: "", goal: "",
    inputs: [{ name: "url", schema: { type: "string" }, required: true }],
    steps: [{ kind: "tool_call", label: "s0", tool: "echo",
      arguments: { url: { kind: "symref", ref: "url" } }, resultBinding: "r0" }],
    return: null,
  };
  const dispatch = async () => ({ ok: true as const, value: null });
  const res = await exec.run(wf, {}, dispatch, 0);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal((res.error.details as { code?: string }).code, "missing_required_input");
  await tracer.close();
});
```

> Match the file's existing imports for `Tracer`, `mkdtemp`, `tmpdir`, `join`, `WorkflowExecutor`, `Workflow`. If the existing tests construct the tracer differently, mirror that exactly.

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-transform-types --test packages/core/src/workflow/executor.test.ts`
Expected: FAIL — current `run` rejects any non-empty `runtimeInputs`; symrefs to inputs are unbound.

- [ ] **Step 3: Edit `executor.ts`**

In `run`, delete the rejection block:

```typescript
    if (Object.keys(runtimeInputs).length !== 0) {
      return {
        ok: false,
        error: {
          kind: "schema_violation",
          message: "v1 workflows do not accept runtime inputs",
          details: { code: "inputs_not_supported_in_v1" },
        },
      };
    }
```

Replace it with input seeding right after `const env = new Map<string, unknown>();`:

```typescript
    const env = new Map<string, unknown>();
    for (const input of workflow.inputs) {
      if (Object.prototype.hasOwnProperty.call(runtimeInputs, input.name)) {
        env.set(input.name, runtimeInputs[input.name]);
      } else if (input.required === false) {
        env.set(input.name, input.default);
      } else {
        this.opts.tracer.log(TRACE_KIND_WORKFLOW_START, { name: workflow.name, depth });
        return {
          ok: false,
          error: {
            kind: "schema_violation",
            message: `missing required input '${input.name}'`,
            details: { code: "missing_required_input", workflow: workflow.name, input: input.name },
          },
        };
      }
    }
```

> Keep the existing `this.opts.tracer.log(TRACE_KIND_WORKFLOW_START, ...)` call that follows; the early-return path above logs start once for trace symmetry. If you prefer a single start log, move the existing start-log call to before the seeding loop and drop the extra log in the error branch — either is fine as long as tests pass.

- [ ] **Step 4: Run to verify it passes**

Run: `node --experimental-transform-types --test packages/core/src/workflow/executor.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow/executor.ts packages/core/src/workflow/executor.test.ts
git commit -m "feat(workflow): seed declared inputs (with defaults) in the executor"
```

---

## Task 6: Factory — `previewWorkflow` and `createWorkflow(promotions)`

**Files:**
- Modify: `packages/core/src/factory/factory.ts`
- Modify: `packages/core/src/factory/factory.test.ts`

- [ ] **Step 1: Write the failing test (append to `factory.test.ts`)**

Reuse the file's existing factory construction. Add:

```typescript
test("createWorkflow: promotes a literal to a required input and projects inputSchema", async () => {
  // Arrange a factory whose registry has fetch-webpage-text + write-file-text (reuse this file's helpers).
  const slice = [
    { name: "fetch-webpage-text", args: { url: "https://x/p.md" }, ok: true, value: "text" },
    { name: "write-file-text", args: { path: "./o.md", content: "text" }, ok: true, value: { written: true } },
  ];
  const out = await factory.createWorkflow({
    slice, name: "summarize_paper", intent: "summarize", description: "d",
    promotions: [
      { stepLabel: "step_0_fetch_webpage_text", argName: "url", paramName: "url", required: true },
      { stepLabel: "step_1_write_file_text", argName: "path", paramName: "path", required: false, description: "out path" },
    ],
  });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const schema = out.tool.manifest.inputSchema as { required?: string[]; properties: Record<string, unknown> };
  assert.deepEqual(schema.required, ["url"]);
  assert.ok("path" in schema.properties);
});

test("previewWorkflow: returns literalFallbacks without persisting", async () => {
  const slice = [{ name: "fetch-webpage-text", args: { url: "https://x" }, ok: true, value: "t" }];
  const pv = await factory.previewWorkflow({ slice, name: "x", intent: "", description: "" });
  assert.equal(pv.ok, true);
  if (!pv.ok) return;
  assert.ok(pv.literalFallbacks.some((f) => f.argName === "url"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-transform-types --test packages/core/src/factory/factory.test.ts`
Expected: FAIL — `promotions` not accepted; `previewWorkflow` undefined.

- [ ] **Step 3: Edit `factory.ts`**

Add imports:

```typescript
import { liftFromTrace, inputSchemaFromInputs, type Invocation, type LiftResult } from "../workflow/lift.ts";
import { parameterize, type Promotion } from "../workflow/parameterize.ts";
```

Extend the request type:

```typescript
export type CreateWorkflowReq = {
  slice: Invocation[];
  name: string;
  intent: string;
  description: string;
  promotions?: Promotion[];
};

export type PreviewWorkflowOutcome =
  | { ok: true; workflow: import("../workflow/types.ts").Workflow; literalFallbacks: import("../workflow/lift.ts").LiftResult extends { literalFallbacks: infer L } ? L : never }
  | { ok: false; reason: string };
```

> Simpler: import the concrete types and avoid the conditional type:

```typescript
import type { Workflow } from "../workflow/types.ts";
import type { LiteralFallback } from "../workflow/lift.ts";

export type PreviewWorkflowOutcome =
  | { ok: true; workflow: Workflow; literalFallbacks: LiteralFallback[] }
  | { ok: false; reason: string };
```

(Ensure `LiteralFallback` is exported from `lift.ts` — it already is.)

Add a private helper that builds `toolsByName` + lifts (factor out of the current `createWorkflow`):

```typescript
private async liftSlice(req: CreateWorkflowReq): Promise<LiftResult> {
  const toolsByName: Record<string, Tool> = {};
  for (const summary of this.opts.registry.listSync()) {
    const tool = await this.opts.registry.get(summary.name);
    if (tool) toolsByName[summary.name] = tool;
  }
  return liftFromTrace({
    slice: req.slice, name: req.name, description: req.description, goal: req.intent, toolsByName,
  });
}
```

Add `previewWorkflow`:

```typescript
async previewWorkflow(req: CreateWorkflowReq): Promise<PreviewWorkflowOutcome> {
  const liftResult = await this.liftSlice(req);
  if (!liftResult.ok) return { ok: false, reason: `lift failed: ${liftResult.errors.map((e) => e.message).join("; ")}` };
  return { ok: true, workflow: liftResult.workflow, literalFallbacks: liftResult.literalFallbacks };
}
```

Rewrite `createWorkflow` to apply promotions and re-derive the manifest from the parameterized workflow:

```typescript
async createWorkflow(req: CreateWorkflowReq): Promise<FactoryOutcome> {
  const liftResult = await this.liftSlice(req);
  if (!liftResult.ok) return { ok: false, reason: `lift failed: ${liftResult.errors.map((e) => e.message).join("; ")}` };

  let { workflow, manifest, literalFallbacks } = liftResult;

  if (req.promotions && req.promotions.length > 0) {
    const pr = parameterize(workflow, req.promotions);
    if (!pr.ok) return { ok: false, reason: `parameterize failed: ${pr.errors.map((e) => e.message).join("; ")}` };
    workflow = pr.workflow;
    manifest = { ...manifest, inputSchema: inputSchemaFromInputs(workflow.inputs) };
  }

  const validation = await validateWorkflow(workflow, this.opts.registry);
  if (!validation.ok) return { ok: false, reason: `validation failed: ${validation.errors.map((e) => e.message).join("; ")}` };

  const workflowJson = JSON.stringify(workflow, null, 2);
  const { hash: _liftHash, ...manifestSansHash } = manifest;
  const tool = this.toolFromManifestAndCode(manifestSansHash, workflowJson);

  console.log("\n--- Lifted Workflow ---");
  console.log(renderLiterate(workflow));
  console.log("\n--- Literal Fallbacks ---");
  if (literalFallbacks.length === 0) {
    console.log("(none - all arguments are symrefs)");
  } else {
    for (const fb of literalFallbacks) {
      console.log(`  ${fb.stepLabel}.${fb.argName}: ${fb.canonicalValue.slice(0, 80)}...`);
    }
  }
  console.log("");

  const approval: ApprovalRecord = {
    hash: tool.manifest.hash,
    approvedAt: new Date().toISOString(),
    approvedBy: this.approvedBy,
    alwaysApprove: false,
  };

  await this.opts.registry.save(tool, approval);
  this.opts.tracer.log("tool-created", { name: tool.manifest.name, hash: tool.manifest.hash, approvedBy: this.approvedBy });
  return { ok: true, tool, approval };
}
```

> Note: the re-derived `manifest.inputSchema` changes the hash. `toolFromManifestAndCode` already recomputes the hash over `code` + manifest, so the persisted hash is correct. The `manifest.hash` produced by `liftFromTrace` is unused here (it's stripped via `_liftHash`).

- [ ] **Step 4: Run to verify it passes**

Run: `node --experimental-transform-types --test packages/core/src/factory/factory.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Typecheck + full core tests**

Run: `npm run typecheck && npm test -w @meta-agent/core`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/factory/factory.ts packages/core/src/factory/factory.test.ts
git commit -m "feat(factory): apply promotions and project inputSchema in createWorkflow; add previewWorkflow"
```

---

## Task 7: Agent loop — validate workflow inputSchema before execution

**Files:**
- Modify: `packages/core/src/agent/agent-loop.ts`
- Modify: `packages/core/src/agent/agent-loop.test.ts`

- [ ] **Step 1: Write the failing tests (append to `agent-loop.test.ts`)**

Reuse the file's existing harness for registering a tool and dispatching. Register a parameterized workflow tool (manifest `kind: "workflow"`, `inputSchema` with `required: ["url"]`, `additionalProperties:false`) plus its dependency, then:

```typescript
test("dispatch: workflow rejects missing required input via Ajv", async () => {
  // ...register workflow `wf` requiring `url`, dep `echo`...
  const res = await loop.testDispatch("wf", {}, 0); // use the harness's dispatch entrypoint
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "schema_violation");
});

test("dispatch: workflow rejects unknown key via Ajv", async () => {
  const res = await loop.testDispatch("wf", { url: "https://a", bogus: 1 }, 0);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "schema_violation");
});

test("dispatch: workflow runs with valid input", async () => {
  const res = await loop.testDispatch("wf", { url: "https://a" }, 0);
  assert.equal(res.ok, true);
});
```

> If `agent-loop.test.ts` has no public dispatch entrypoint, follow the file's existing approach for exercising tool dispatch (it already tests `invoke_tool` paths). Mirror that exact mechanism rather than inventing `testDispatch`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-transform-types --test packages/core/src/agent/agent-loop.test.ts`
Expected: FAIL — workflow branch currently skips schema validation, so missing/unknown keys are not rejected.

- [ ] **Step 3: Edit `dispatchTool` in `agent-loop.ts`**

Replace the workflow branch:

```typescript
    if (tool.manifest.kind === TOOL_KIND.workflow) {
      const wf = await this.opts.registry.getWorkflow(name);
      if (!wf) return toolError("unknown_tool", `workflow '${name}' not found`);
      const schema = tool.manifest.inputSchema as Record<string, unknown>;
      const input = coerceStringifiedJsonInput(args, rootJsonSchemaKind(schema));
      if (!this.ajv.validate(schema, input)) {
        return toolError("schema_violation", `input does not match schema: ${this.ajv.errorsText()}`);
      }
      return this.executor.run(wf, input as Record<string, unknown>, async (toolName, toolArgs, d) => {
        return this.dispatchTool(toolName, toolArgs, task, d);
      }, depth);
    }
```

> `coerceStringifiedJsonInput` and `rootJsonSchemaKind` are already imported (used by the atomic/composite path). An empty `inputSchema` (`{}`) validates anything, so closed workflows keep working.

- [ ] **Step 4: Run to verify it passes**

Run: `node --experimental-transform-types --test packages/core/src/agent/agent-loop.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/agent-loop.ts packages/core/src/agent/agent-loop.test.ts
git commit -m "feat(agent): validate workflow inputs against inputSchema before execution"
```

---

## Task 8: CLI — interactive promotion in `/compose`

**Files:**
- Modify: `packages/cli/src/compose.ts`

- [ ] **Step 1: Edit `compose.ts` to preview, prompt per fallback, then create**

Replace the body after `const description = ...` with a preview → prompt → create flow:

```typescript
  const description = (await rl.question("Description: ")).trim();

  const liftSlice = slice.map((s) => ({ name: s.name, args: s.args, ok: s.ok, value: s.value ?? null }));

  const preview = await factory.previewWorkflow({ slice: liftSlice, name, intent, description });
  if (!preview.ok) { console.log(`rejected: ${preview.reason}`); return; }

  const promotions: Promotion[] = [];
  if (preview.literalFallbacks.length === 0) {
    console.log("(no literal arguments to parameterize)");
  } else {
    console.log("\nParameterize literal arguments (blank name = keep literal):");
    for (const fb of preview.literalFallbacks) {
      const preview1 = fb.canonicalValue.length > 80 ? fb.canonicalValue.slice(0, 80) + "..." : fb.canonicalValue;
      console.log(`  ${fb.stepLabel}.${fb.argName} = ${preview1}`);
      const paramName = (await rl.question("    Parameter name: ")).trim();
      if (!paramName) continue;
      const reqAns = (await rl.question("    Required? [y/N]: ")).trim().toLowerCase();
      const required = reqAns === "y" || reqAns === "yes";
      const desc = (await rl.question("    Description (optional): ")).trim();
      promotions.push({
        stepLabel: fb.stepLabel,
        argName: fb.argName,
        paramName,
        required,
        ...(desc ? { description: desc } : {}),
      });
    }
  }

  const out = await factory.createWorkflow({ slice: liftSlice, name, intent, description, promotions });
  console.log(out.ok ? `created workflow '${out.tool.manifest.name}'` : `rejected: ${out.reason}`);
}
```

Add the import at the top:

```typescript
import type { ToolFactory, Promotion } from "@meta-agent/core";
```

> Ensure `Promotion` is re-exported from `@meta-agent/core` (see Step 2).

- [ ] **Step 2: Re-export `Promotion` (and confirm `previewWorkflow` types) from core's `index.ts`**

In `packages/core/src/index.ts`, add `Promotion` and `parameterize`/`previewWorkflow` types to the public exports (follow the existing export style there). Minimum:

```typescript
export { parameterize, jsonSchemaTypeOf, type Promotion } from "./workflow/parameterize.ts";
export { inputSchemaFromInputs } from "./workflow/lift.ts";
```

- [ ] **Step 3: Typecheck both packages**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/compose.ts packages/core/src/index.ts
git commit -m "feat(cli): interactive parameter promotion in /compose"
```

---

## Task 9: End-to-end parameterization test

**Files:**
- Modify: `packages/core/src/workflow/e2e-lift.test.ts`

- [ ] **Step 1: Write the failing e2e test (append a new test)**

Build on the file's `setupTestEnv` and atomic tools. Use `ADD_TOOL` (params `a`, `b`). Lift a `add(2,3)` trace, promote both `a` and `b` (one required, one optional with default), persist via `parameterize` + `inputSchemaFromInputs`, then execute twice through the executor:

```typescript
test("E2E: parameterized workflow runs with caller inputs and defaults", async () => {
  const { dir, registry, tracer, sandbox } = await setupTestEnv();
  try {
    await registry.save(ADD_TOOL, APPROVAL);

    const invocations = [{ name: "add", args: { a: 2, b: 3 }, ok: true as const, value: 5 }];
    const lifted = liftFromTrace({ slice: invocations, name: "add-wf", description: "", goal: "", toolsByName: { add: ADD_TOOL } });
    assert.equal(lifted.ok, true);
    if (!lifted.ok) return;

    const pr = parameterize(lifted.workflow, [
      { stepLabel: "step_0_add", argName: "a", paramName: "a", required: true },
      { stepLabel: "step_0_add", argName: "b", paramName: "b", required: false },
    ]);
    assert.equal(pr.ok, true);
    if (!pr.ok) return;
    const workflow = pr.workflow;

    const validation = await validate(workflow, registry);
    assert.equal(validation.ok, true, validation.ok ? "" : validation.errors.map((e) => e.code).join(","));

    const executor = new WorkflowExecutor({ tracer });
    const dispatch = async (name: string, args: unknown): Promise<ToolResult> => {
      const tool = await registry.get(name);
      if (!tool) return toolError("unknown_tool", name);
      return sandbox.execute(tool, args, "token");
    };

    // Provide both inputs.
    const r1 = await executor.run(workflow, { a: 10, b: 20 }, dispatch, 0);
    assert.equal(r1.ok, true);
    if (r1.ok) assert.equal(r1.value, 30);

    // Omit optional b → falls back to default (3).
    const r2 = await executor.run(workflow, { a: 100 }, dispatch, 0);
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.value, 103);

    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

Add the import for `parameterize` at the top of the file:

```typescript
import { parameterize } from "./parameterize.ts";
```

- [ ] **Step 2: Run to verify it fails first (if written before earlier tasks) / passes now**

Run: `node --experimental-transform-types --test packages/core/src/workflow/e2e-lift.test.ts`
Expected: PASS (all earlier tasks complete). The `b` optional default is `3` because that was the original literal value at lift time.

- [ ] **Step 3: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/workflow/e2e-lift.test.ts
git commit -m "test(workflow): e2e parameterized workflow with inputs and defaults"
```

---

## Manual verification (after Task 9)

- [ ] Run the REPL, reproduce a 2-tool session (fetch a URL, write a file), then `/compose`, select the slice, and at the prompts promote `url` (required) and the output `path` (optional). Confirm the saved `./tools/<name>/workflow.json` has a non-empty `inputs[]` and the manifest's `inputSchema` lists `url` as required.
- [ ] In a new session, ask the agent to use the new tool with a different URL/path and confirm it passes `{ url, path }` and the workflow runs end-to-end.

---

## Self-Review (completed during planning)

- **Spec coverage:** §4 IR → Task 1; §5 parameterize → Task 2; §6 projection → Task 3; §10 validator → Task 4; §8 executor → Task 5; §7 factory/preview → Task 6; §9 agent-loop → Task 7; §7 CLI UX → Task 8; §12 e2e → Task 9. All design sections map to a task.
- **Type consistency:** `WorkflowInput`, `Promotion`, `parameterize()`, `jsonSchemaTypeOf()`, `inputSchemaFromInputs()`, `previewWorkflow()`, `CreateWorkflowReq.promotions` are named identically across tasks.
- **Out of scope (per design §2.2):** LLM-generated-literal detection, workflow-calls-workflow, branching/loops — not in any task by design.
