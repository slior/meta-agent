# Workflow Parameterization — Design Spec

**Status:** Approved for implementation planning
**Date:** 2026-06-04
**Scope:** Promote literal arguments in a lifted workflow into declared, typed **parameters** of the resulting tool. Implements the parameterization slice of the **COMPOSE** tier sketched in [`2026-05-07-workflow-ir-design.md`](2026-05-07-workflow-ir-design.md) §13.

---

## 1. Background and Motivation

The Workflow IR (LEAN tier) lets the user select a contiguous slice of successful tool calls in a session and `/compose` them into a reusable **workflow** tool. Lifting is deterministic and structural: any argument whose value matches a prior step's output becomes a `SymRef`; everything else becomes a `Literal`. The lifted workflow declares `inputs: []` and is therefore **fully closed** — it always reproduces the exact original run.

That closedness is the problem. Consider the running example: a session that fetched a paper from a URL and wrote a summary to a file produced this workflow (abridged):

```jsonc
{
  "name": "summarize_paper",
  "inputs": [],
  "steps": [
    { "tool": "fetch-webpage-text",
      "arguments": { "url": { "kind": "literal", "value": "https://www.alphaxiv.org/overview/2601.10112v1.md" } }, ... },
    { "tool": "write-file-text",
      "arguments": { "content": { "kind": "literal", "value": "# Key Innovations: ..." },
                     "path":    { "kind": "literal", "value": "./tmp/rig1.md" } }, ... }
  ],
  "return": { "source": { "kind": "symref", "ref": "r_1_write_file_text" } }
}
```

The tool only ever summarizes *that* URL into *that* file. To be reusable, the user needs to externalize the `url` and the output `path` as **arguments to the tool**. More generally: any value that the lift recorded as a literal should *optionally* be promotable to a parameter.

**What this spec changes.** Adds a manual, interactive promotion step to `/compose`: the user marks which lifted literals become parameters, names them, and chooses per parameter whether it is **required** or **optional with a default** (the default being the original literal value). The chosen literals are rewritten into `SymRef`s that resolve against declared workflow inputs; the workflow's manifest gains a real `inputSchema` so the agent can call the tool with arguments.

This is the first concrete realization of the COMPOSE tier and uses only the seams that the LEAN spec deliberately reserved.

---

## 2. Goals and Non-Goals

### 2.1 Goals

1. **Manual promotion** of lifted literal arguments into named workflow parameters during `/compose`.
2. **Per-parameter required/optional** choice; optional parameters carry a default equal to the original literal value, so a no-argument call reproduces the original run.
3. **Self-describing IR**: a workflow's parameter metadata (name, type, required, default, description) lives in the workflow JSON; the manifest's `inputSchema` is a pure projection of it.
4. **End-to-end invocation**: the parameterized workflow is exposed to the LLM with a real `inputSchema`, validated on call, and executed with caller-supplied (or defaulted) inputs.
5. **Determinism preserved**: `liftFromTrace` stays pure and trace-deterministic; promotion is a separate, independently testable transform.

### 2.2 Non-Goals (deferred)

- **Distinguishing LLM-generated literals from genuine inputs.** In the example, `content` is the agent's own generated summary, not a real input; promoting it would be pointless. For now the user simply does not mark it. Automatic detection/labeling of agent-authored literals is future work.
- Workflow-calls-workflow, `propose_workflow` (LLM-authored IR), an inliner — remain COMPOSE follow-ups.
- Branching/loops (`STEP_KIND.branch`/`loop`), `SymRef.path` sub-value access — remain tier B/C.
- Type *refinement* by the user (e.g., enums, formats). Parameter schema is auto-inferred from the literal's JSON type only.

---

## 3. Architecture Overview

Promotion is layered cleanly onto the existing lift → validate → persist → execute pipeline:

```mermaid
flowchart TB
    SLICE[session slice] --> LIFT[liftFromTrace<br/>pure, inputs: []]
    LIFT -->|workflow + literalFallbacks| PREVIEW[factory.previewWorkflow]
    PREVIEW --> CLI[cli/compose.ts<br/>interactive marking]
    CLI -->|promotions[]| CREATE[factory.createWorkflow]
    CREATE --> PARAM[parameterize transform]
    PARAM --> VAL[validate]
    VAL --> SAVE[registry.save]
    SAVE --> EXEC[WorkflowExecutor.run<br/>seeds inputs]
    AL[AgentLoop.dispatchTool] -->|ajv inputSchema| EXEC
```

**Key insight (unchanged from LEAN):** parameters are not a new argument kind. An input is simply a binding that is *in scope from step 0*. Promotion rewrites a `Literal` into a `SymRef` whose `ref` is an input name, and the executor seeds those names into `env` before the first step runs. This is why the IR shape barely changes and the executor's resolution logic is reused verbatim.

---

## 4. IR Shape Change

`packages/core/src/workflow/types.ts` — `Workflow.inputs` changes from `string[]` to `WorkflowInput[]`:

```typescript
export type WorkflowInput = {
  name: string;                     // matches BINDING_NAME (/^[a-z_][a-z0-9_]*$/i); unique; in scope from step 0
  schema: Record<string, unknown>;  // inferred JSON Schema fragment, e.g. { type: "string" }
  required: boolean;
  default?: unknown;                // present iff required === false (the original literal value)
  description?: string;
};

export type Workflow = {
  schemaVersion: IrSchemaVersion;
  name: string;
  description: string;
  goal: string;
  inputs: WorkflowInput[];          // was string[]; v1 still allows [] (a closed workflow)
  steps: Step[];
  return: WorkflowReturn;
};
```

**Namespace.** A `SymRef.ref` now resolves to **either** a prior step's `resultBinding` **or** an input `name`. Both share one namespace, so an input name must not collide with any `resultBinding`.

`packages/core/src/workflow/schema.ts` — `WORKFLOW_SCHEMA.inputs` widens from an array of strings to an array of objects:

```typescript
const WORKFLOW_INPUT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    schema: { type: "object" },
    required: { type: "boolean" },
    default: {},                       // any JSON value; only meaningful when required === false
    description: { type: "string" },
  },
  required: ["name", "schema", "required"],
  additionalProperties: false,
} as const;
// WORKFLOW_SCHEMA.properties.inputs = { type: "array", items: WORKFLOW_INPUT_SCHEMA }
```

Existing persisted workflows (`inputs: []`) parse unchanged — an empty array satisfies both the old and new item schema.

---

## 5. Lift Stays Pure; `parameterize` Does the Promotion

`liftFromTrace` is **unchanged**: it still emits `inputs: []` and the `literalFallbacks` list (`{ stepLabel, argName, canonicalValue }`). Promotion is a separate, pure, deterministic transform in a new file `packages/core/src/workflow/parameterize.ts`:

```typescript
export type Promotion = {
  stepLabel: string;
  argName: string;
  paramName: string;
  required: boolean;
  description?: string;
};

export type ParameterizeResult =
  | { ok: true; workflow: Workflow }
  | { ok: false; errors: LiftError[] };   // reuse LiftError { code, message } from lift.ts

export function parameterize(workflow: Workflow, promotions: Promotion[]): ParameterizeResult;
```

Algorithm:

1. For each promotion, locate the step by `stepLabel` and the argument by `argName`.
   - Step/arg not found → error `promotion_target_missing`.
   - Argument is not currently a `Literal` (already a `SymRef`) → error `promotion_target_not_literal`.
2. Infer the parameter schema from the literal's value via `jsonSchemaTypeOf(value)`:
   - `string`→`{type:"string"}`, `number`→`{type:"number"}`, `boolean`→`{type:"boolean"}`, array→`{type:"array"}`, `null`→`{type:"null"}`, object→`{type:"object"}`.
3. Build the `WorkflowInput`:
   - `name = paramName`, `schema = inferred`, `required = promotion.required`,
   - `default = (required ? omitted : the original literal value)`,
   - `description` if provided.
4. Rewrite the argument to `{ kind: "symref", ref: paramName }`.
5. Append the input. **Shared name collapse:** if `paramName` was already added by an earlier promotion, do not duplicate the input; both arguments point at the same `SymRef`. The two promotions must agree on inferred `schema` and `required` (and default value) — otherwise error `promotion_name_conflict`.

The transform does not itself enforce name format / binding collisions; those are caught by the validator (run immediately after) so there is a single source of truth for scope rules. Keeping `parameterize` separate from `liftFromTrace` preserves "same trace ⇒ byte-identical lift" and makes promotion independently unit-testable.

---

## 6. Manifest `inputSchema` Projection

`packages/core/src/workflow/lift.ts` derives the manifest. Today `inputSchema: {}`. It becomes a projection of `workflow.inputs`. Because `liftFromTrace` emits `inputs: []`, the projection helper is shared and called again after `parameterize`. Concretely, `createWorkflow` re-derives the manifest from the parameterized workflow:

```typescript
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

This object is what the LLM sees in the tool catalog (so the agent knows to pass `url`/`path`) and what Ajv validates against at dispatch. Defaults are advertised in the schema for the model's benefit but are **applied by the executor** (single source of truth — see §8).

---

## 7. Compose UX — Interactive Marking

The factory is split so the CLI can surface fallbacks *before* committing:

- `factory.previewWorkflow(req: CreateWorkflowReq)` → `{ ok: true; workflow; literalFallbacks } | { ok: false; reason }`. Lifts and validates but does **not** persist.
- `factory.createWorkflow(req)` gains `promotions: Promotion[]`. It lifts, applies `parameterize`, re-derives the manifest via `inputSchemaFromInputs`, validates, and saves (as today).

`packages/cli/src/compose.ts` flow after the slice/name/intent/description are collected:

1. Call `previewWorkflow` to obtain `literalFallbacks`.
2. For each fallback, prompt:

```
Literal: step_0_fetch_webpage_text.url = "https://www.alphaxiv.org/overview/2601.10112v1.md"
  Parameter name (blank = keep as literal): url
  Required? [y/N]: n
  Description (optional): URL of the paper text to summarize
```

   - Blank name → keep literal (no promotion).
   - `Required? [y/N]` default is **No** → optional, default = the shown literal value.
   - Long literal values are truncated for display.
3. Pass the collected `promotions[]` to `createWorkflow`. The existing literate render + literal-fallback report still print for final confirmation.

---

## 8. Executor Seeds Inputs

`packages/core/src/workflow/executor.ts`:

- **Remove** the "v1 workflows do not accept runtime inputs" rejection.
- Before running steps, seed `env` from `workflow.inputs`:
  - input `name` present in `runtimeInputs` → bind that value;
  - else `required === false` → bind `input.default`;
  - else (required and absent from `runtimeInputs`) → fail with `{ kind: "schema_violation", details: { code: "missing_required_input", input: name } }` (defense-in-depth; the agent loop validates first).
- Extra keys in `runtimeInputs` not declared as inputs are ignored by the executor (the agent loop rejects them via `additionalProperties: false`).
- SymRef resolution is otherwise unchanged; it now also finds input-seeded names in `env`.

---

## 9. Agent-Loop Validation

`packages/core/src/agent/agent-loop.ts` — the `dispatchTool` workflow branch currently bypasses schema validation. Add the same coerce + Ajv block used for atomic/composite tools, before `executor.run`:

```typescript
if (tool.manifest.kind === TOOL_KIND.workflow) {
  const wf = await this.opts.registry.getWorkflow(name);
  if (!wf) return toolError("unknown_tool", `workflow '${name}' not found`);
  const schema = tool.manifest.inputSchema as Record<string, unknown>;
  const input = coerceStringifiedJsonInput(args, rootJsonSchemaKind(schema));
  if (!this.ajv.validate(schema, input)) {
    return toolError("schema_violation", `input does not match schema: ${this.ajv.errorsText()}`);
  }
  return this.executor.run(wf, input as Record<string, unknown>, /* dispatch */, depth);
}
```

Required inputs are enforced here; defaults remain the executor's responsibility (the `inputSchema` advertises defaults but Ajv is **not** configured with `useDefaults`, so the executor stays the single source of truth).

---

## 10. Validator Changes

`packages/core/src/workflow/validator.ts`:

- **Remove** the `inputs_not_supported_in_v1` check.
- **Seed scope:** initialize the in-scope binding set with every `input.name` before walking steps, so input `SymRef`s resolve (existing check #8 then passes for inputs).
- **New input checks** (before/while seeding):
  - `input.name` matches `BINDING_NAME` → `invalid_input_name`.
  - `input.name` unique among inputs → `duplicate_input`.
  - `input.name` does not collide with any step `resultBinding` → `input_binding_collision`.
  - `required === false` ⇒ `default` key present → `optional_input_missing_default`.
  - `input.schema` is a non-null object → `invalid_input_schema`.
- `branch`/`loop` step kinds stay rejected (`step_kind_not_supported_in_v1`).

The IR remains **acyclic by construction**: inputs are in scope from the start and refs only ever point backwards.

---

## 11. Module / File Layout

### New file

```
packages/core/src/workflow/parameterize.ts   # Promotion type, parameterize(), jsonSchemaTypeOf()
```

### Touch sites

- `packages/core/src/workflow/types.ts` — `WorkflowInput`; `Workflow.inputs: WorkflowInput[]`.
- `packages/core/src/workflow/schema.ts` — `WORKFLOW_INPUT_SCHEMA`; widen `inputs` items.
- `packages/core/src/workflow/validator.ts` — input checks; seed scope; drop v1 inputs guard.
- `packages/core/src/workflow/executor.ts` — seed inputs; drop runtime-inputs rejection.
- `packages/core/src/workflow/lift.ts` — `inputSchemaFromInputs()` projection helper; export `LiftError`.
- `packages/core/src/factory/factory.ts` — `previewWorkflow()`; `createWorkflow` accepts `promotions[]`, applies `parameterize`, re-derives manifest.
- `packages/core/src/agent/agent-loop.ts` — validate workflow `inputSchema` before `executor.run`.
- `packages/cli/src/compose.ts` — interactive marking loop; build `promotions[]`.

---

## 12. Test Plan

`node:test`, matching existing style.

- `parameterize.test.ts` — literal→symref rewrite; `jsonSchemaTypeOf` per type; required (no default) vs. optional (default = original value); shared-name collapse; `promotion_target_missing`; `promotion_target_not_literal`; `promotion_name_conflict`; determinism (same input ⇒ byte-identical output).
- `validator.test.ts` — input SymRef resolves in scope; `invalid_input_name`; `duplicate_input`; `input_binding_collision`; `optional_input_missing_default`; `invalid_input_schema`; closed workflow (`inputs: []`) still valid.
- `executor.test.ts` — seed from `runtimeInputs`; default fallback when optional input omitted; `missing_required_input` when required input absent; extra keys ignored.
- `lift.test.ts` — `inputSchemaFromInputs` projection (required array, defaults, descriptions, empty ⇒ `{}`); existing lift tests updated for new `inputs` shape.
- `e2e-lift.test.ts` — promote `url` + `path`, persist, then invoke the workflow twice with different values; assert the second run hits the new values and an omitted optional input falls back to its default.
- `agent-loop.test.ts` — workflow dispatch rejects unknown keys / missing required input via Ajv.

---

## 13. Risks and Open Questions

1. **IR-shape change vs. the LEAN doc's "no IR change" claim.** The LEAN spec assumed `inputs` could stay `string[]`. Per-parameter defaults make that insufficient, so we widen it. The change is additive and backward-compatible (`inputs: []` unaffected), and keeps the workflow JSON the single source of truth.
2. **LLM-generated literals as defaults.** Marking `content` would store a multi-KB default. Out of scope per §2.2; the UX truncates display and the user is expected not to mark such literals. Revisit when agent-authored literals are labeled.
3. **Type inference is shallow.** Only the JSON type is inferred; no enums/formats/object-property schemas. Acceptable for v1; richer schemas are a later refinement.
4. **Shared-value vs. shared-name.** Promotion is per `(stepLabel, argName)` occurrence, not per value. Two identical literals in different positions stay independent unless the user gives them the same `paramName` (then they collapse). This avoids surprising value-based coupling.

---

## 14. References

- [`2026-05-07-workflow-ir-design.md`](2026-05-07-workflow-ir-design.md) — LEAN-tier IR design; §13 COMPOSE sketch (seams used here).
- Erik Meijer, "From Function Frustrations to Framework Flexibility", Queue, 2025 — symbolic indirection / parameterization motivation.
