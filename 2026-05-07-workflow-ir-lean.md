# Workflow IR (LEAN) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the LEAN tier of the Workflow IR per [`docs/superpowers/specs/2026-05-07-workflow-ir-design.md`](../specs/2026-05-07-workflow-ir-design.md): a formal, persisted IR for tool-call sequences as the new source of truth for composites, replacing `/compose`'s LLM-codegen path with a deterministic structural lift.

**Architecture:** New `packages/core/src/workflow/` module (types + JSON Schema + parser + validator + executor + lift + literate renderer). New `kind: "workflow"` registry entries persist `workflow.json` instead of `tool.ts`. The executor is in-process; each step's tool call flows through the existing `AgentLoop.dispatchTool` / `Sandbox` / approval pipeline. `factory.createWorkflow` replaces the now-removed `createReactive`.

**Tech Stack:** TypeScript (strict), Node.js ≥ 25, `node:test` + `node:assert/strict`, Ajv for JSON Schema validation. No new runtime deps — Ajv and the openai SDK are already present.

---

## File Structure

### Created (new module)

| File | Responsibility |
|---|---|
| `packages/core/src/workflow/types.ts` | IR types: `Workflow`, `Step`, `Argument`, `SymRef`, `Literal`, plus `STEP_KIND` / `ARG_KIND` enums and `IR_SCHEMA_VERSION`. |
| `packages/core/src/workflow/schema.ts` | JSON Schema for the IR (used by `parser.ts`). v1 only allows `kind: "tool_call"` steps. |
| `packages/core/src/workflow/parser.ts` | `parseWorkflow(json) → ParseResult`. Structural-only check via Ajv against `schema.ts`. |
| `packages/core/src/workflow/validator.ts` | `validate(workflow, registry) → ValidationResult`. Higher-level checks (scope, uniqueness, registry presence, argument key match). |
| `packages/core/src/workflow/executor.ts` | `WorkflowExecutor` class. Runs an in-memory `Workflow` against a `DispatchTool` callback. |
| `packages/core/src/workflow/lift.ts` | `liftFromTrace(slice, opts) → LiftResult`. Deterministic, structural, no LLM. |
| `packages/core/src/workflow/renderer.ts` | `renderLiterate(workflow, env?) → string`. Article-1-style projection. |
| `packages/core/src/workflow/index.ts` | Barrel exports for the module. |
| `packages/core/src/workflow/<file>.test.ts` | One test file per source file above (no test for `index.ts`). |

### Modified

| File | Change |
|---|---|
| `packages/core/src/types.ts` | Add `workflow` to `TOOL_KIND`. Add 5 reserved-future optional fields to `ToolManifest`. |
| `packages/core/src/registry/fs-registry.ts` | Branch on `manifest.kind === "workflow"` in `rehydrate` and `save`; add `getWorkflow(name)` method. |
| `packages/core/src/registry/interface.ts` | Add `getWorkflow(name): Promise<Workflow | null>`. |
| `packages/core/src/tracer.ts` | Add 4 new `TRACE_KIND_*` constants. |
| `packages/core/src/agent/agent-loop.ts` | Hold a `WorkflowExecutor`; branch on `kind === "workflow"` in `dispatchTool`; extend `ToolInvokedEvent` with `value`/`error`. |
| `packages/core/src/factory/factory.ts` | New `createWorkflow({slice, name, intent, description})`; remove `createReactive`. |
| `packages/core/src/factory/code-gen-prompts.ts` | Remove `reactivePrompt` export. |
| `packages/core/src/index.ts` | Re-export workflow public surface; remove now-deleted symbols. |
| `packages/cli/src/compose.ts` | Replace LLM-codegen flow with `factory.createWorkflow`; show literate render + literal-fallback list before persistence. Collect `value` per `InvocationRecord`. |
| `packages/cli/src/repl.ts` (or wherever `onToolInvoked` builds `InvocationRecord`) | Pass `value`/`error` through to the compose collector. |
| `packages/core/src/e2e.test.ts` | Add round-trip test: invoke atomic tools → lift slice → execute lifted workflow → confirm parity. |

---

## Conventions used by every task

- All TS source files use `.ts` extension on imports (Node 25 + `--experimental-transform-types`).
- All tests use `node:test` + `node:assert/strict`.
- **Run a single test file:** `cd packages/core && node --test --experimental-transform-types --no-warnings src/workflow/<name>.test.ts`
- **Run all core tests:** `cd packages/core && npm test`
- **Run all CLI tests:** `cd packages/cli && npm test`
- **Run typecheck:** `npm run typecheck` (from repo root)
- After each task's "commit" step, the working tree should be clean and all tests + typecheck must pass.

---

## Phase 1 — `workflow/` module (no consumers)

### Task 1: IR types

**Files:**
- Create: `packages/core/src/workflow/types.ts`

This task is type-only — no runtime tests. Verification is `tsc -b`.

- [ ] **Step 1: Write the types file**

```typescript
/**
 * Workflow IR (LEAN tier).
 *
 * Mirrors the symbolic-indirection model from Meijer's "From Function
 * Frustrations to Framework Flexibility" (Queue 2025) and "Guardians of
 * the Agents" (CACM 2026). v1 implements tier A: linear ordered
 * tool_call steps with whole-value SymRefs. branch (tier B) and loop
 * (tier C) are typed-but-rejected.
 */

export const IR_SCHEMA_VERSION = 1 as const;
export type IrSchemaVersion = typeof IR_SCHEMA_VERSION;

/** Step-kind catalog. v1 implements only `tool_call`. */
export const STEP_KIND = {
  tool_call: "tool_call",
  // Reserved for tier B (parser rejects in v1):
  branch: "branch",
  // Reserved for tier C (parser rejects in v1):
  loop: "loop",
} as const;
export type StepKind = (typeof STEP_KIND)[keyof typeof STEP_KIND];

/** Argument-kind catalog. */
export const ARG_KIND = {
  literal: "literal",
  symref: "symref",
} as const;
export type ArgKind = (typeof ARG_KIND)[keyof typeof ARG_KIND];

export type Literal = {
  kind: typeof ARG_KIND.literal;
  value: unknown;
};

export type SymRef = {
  kind: typeof ARG_KIND.symref;
  ref: string;
  // Reserved for tier B (parser rejects non-undefined `path` in v1):
  // path?: string;
};

export type Argument = Literal | SymRef;

export type ToolCallStep = {
  kind: typeof STEP_KIND.tool_call;
  label: string;
  tool: string;
  arguments: Record<string, Argument>;
  resultBinding: string | null;
};

/** v1: only `ToolCallStep`. Tier B widens to `ToolCallStep | BranchStep`. */
export type Step = ToolCallStep;

export type WorkflowReturn = { source: SymRef } | null;

export type Workflow = {
  schemaVersion: IrSchemaVersion;
  name: string;
  description: string;
  goal: string;
  /** v1 MUST be `[]`. Tier B / COMPOSE widens. */
  inputs: string[];
  steps: Step[];
  return: WorkflowReturn;
};
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/workflow/types.ts
git commit -m "feat(workflow): IR types (LEAN tier)"
```

---

### Task 2: JSON Schema

**Files:**
- Create: `packages/core/src/workflow/schema.ts`

The schema is the structural contract used by the parser. v1 only accepts `kind: "tool_call"`; tier B/C will widen this schema.

- [ ] **Step 1: Write the schema**

```typescript
/**
 * JSON Schema for the LEAN-tier Workflow IR. Used by `parser.ts` to
 * structurally validate untrusted JSON before we treat it as a
 * `Workflow`. Higher-level checks (scope, uniqueness, registry
 * presence) live in `validator.ts`.
 */

export const ARGUMENT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "literal" },
        value: {},
      },
      required: ["kind", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "symref" },
        ref: { type: "string", minLength: 1 },
      },
      required: ["kind", "ref"],
      additionalProperties: false,
    },
  ],
} as const;

export const TOOL_CALL_STEP_SCHEMA = {
  type: "object",
  properties: {
    kind: { const: "tool_call" },
    label: { type: "string", minLength: 1 },
    tool: { type: "string", minLength: 1 },
    arguments: {
      type: "object",
      additionalProperties: ARGUMENT_SCHEMA,
    },
    resultBinding: {
      oneOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    },
  },
  required: ["kind", "label", "tool", "arguments", "resultBinding"],
  additionalProperties: false,
} as const;

export const WORKFLOW_RETURN_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        source: {
          type: "object",
          properties: {
            kind: { const: "symref" },
            ref: { type: "string", minLength: 1 },
          },
          required: ["kind", "ref"],
          additionalProperties: false,
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
    { type: "null" },
  ],
} as const;

export const WORKFLOW_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { const: 1 },
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    goal: { type: "string" },
    inputs: { type: "array", items: { type: "string", minLength: 1 } },
    steps: { type: "array", items: TOOL_CALL_STEP_SCHEMA, minItems: 1 },
    return: WORKFLOW_RETURN_SCHEMA,
  },
  required: ["schemaVersion", "name", "description", "goal", "inputs", "steps", "return"],
  additionalProperties: false,
} as const;
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/workflow/schema.ts
git commit -m "feat(workflow): JSON Schema for LEAN IR"
```

---

### Task 3: Parser

**Files:**
- Create: `packages/core/src/workflow/parser.ts`
- Create: `packages/core/src/workflow/parser.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow } from "./parser.ts";
import type { Workflow } from "./types.ts";

const VALID: Workflow = {
  schemaVersion: 1,
  name: "fetch-and-summarize",
  description: "demo",
  goal: "demo",
  inputs: [],
  steps: [
    {
      kind: "tool_call",
      label: "fetch",
      tool: "fetch-mail",
      arguments: { folder: { kind: "literal", value: "inbox" } },
      resultBinding: "emails",
    },
    {
      kind: "tool_call",
      label: "summarize",
      tool: "summarize-list",
      arguments: { items: { kind: "symref", ref: "emails" } },
      resultBinding: "summary",
    },
  ],
  return: { source: { kind: "symref", ref: "summary" } },
};

test("parser: accepts a valid workflow", () => {
  const out = parseWorkflow(VALID);
  assert.equal(out.ok, true);
  if (out.ok) assert.deepEqual(out.workflow, VALID);
});

test("parser: rejects missing required fields", () => {
  const out = parseWorkflow({ schemaVersion: 1, steps: [] });
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.length > 0);
});

test("parser: rejects unknown step kinds at structural level", () => {
  const bad = { ...VALID, steps: [{ ...VALID.steps[0], kind: "branch" }] };
  const out = parseWorkflow(bad);
  assert.equal(out.ok, false);
});

test("parser: rejects literal {ref:'x'} as a SymRef shape", () => {
  // The discriminator on `kind` keeps this unambiguous.
  const bad = {
    ...VALID,
    steps: [{ ...VALID.steps[0], arguments: { folder: { ref: "emails" } } }],
  };
  const out = parseWorkflow(bad);
  assert.equal(out.ok, false);
});

test("parser: rejects extra top-level keys (additionalProperties:false)", () => {
  const bad = { ...VALID, mystery: 1 } as unknown;
  const out = parseWorkflow(bad);
  assert.equal(out.ok, false);
});

test("parser: rejects empty steps array", () => {
  const bad = { ...VALID, steps: [] };
  const out = parseWorkflow(bad);
  assert.equal(out.ok, false);
});

test("parser: accepts null return", () => {
  const ok = { ...VALID, return: null };
  const out = parseWorkflow(ok);
  assert.equal(out.ok, true);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/workflow/parser.test.ts`
Expected: FAIL — `parser.ts` does not exist.

- [ ] **Step 3: Implement the parser**

```typescript
import Ajv, { type ErrorObject } from "ajv";
import { WORKFLOW_SCHEMA } from "./schema.ts";
import type { Workflow } from "./types.ts";

export type ParseError = {
  pointer: string;
  message: string;
};

export type ParseResult =
  | { ok: true; workflow: Workflow }
  | { ok: false; errors: ParseError[] };

const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(WORKFLOW_SCHEMA);

export function parseWorkflow(input: unknown): ParseResult {
  if (validate(input)) {
    return { ok: true, workflow: input as Workflow };
  }
  return { ok: false, errors: (validate.errors ?? []).map(toParseError) };
}

function toParseError(e: ErrorObject): ParseError {
  return {
    pointer: e.instancePath || "/",
    message: `${e.message ?? "invalid"}${e.params ? " " + JSON.stringify(e.params) : ""}`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/workflow/parser.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow/parser.ts packages/core/src/workflow/parser.test.ts
git commit -m "feat(workflow): structural parser via Ajv"
```

---

### Task 4: Validator

**Files:**
- Create: `packages/core/src/workflow/validator.ts`
- Create: `packages/core/src/workflow/validator.test.ts`

The validator runs all checks beyond the JSON Schema: scope, uniqueness, registry presence, argument-key compatibility, branch/loop rejection (defense-in-depth in case a non-parser code path produces a malformed Step), `inputs.length === 0`, `SymRef.path` reservation.

- [ ] **Step 1: Write the failing tests**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "./validator.ts";
import type { Workflow } from "./types.ts";
import type { ToolRegistry } from "../registry/interface.ts";
import type { Tool, ToolSummary } from "../types.ts";

function fakeRegistry(tools: Record<string, Tool>): ToolRegistry {
  const summaries: ToolSummary[] = Object.values(tools).map((t) => ({
    name: t.manifest.name,
    description: t.manifest.description,
    hash: t.manifest.hash,
    kind: t.manifest.kind,
  }));
  return {
    list: async () => summaries,
    listSync: () => summaries,
    has: async (n) => n in tools,
    get: async (n) => tools[n] ?? null,
    getApproval: async () => null,
    save: async () => {},
    delete: async () => {},
    getDependents: async () => [],
    rootDir: () => "/tmp",
  };
}

const ATOMIC = (
  name: string,
  inputSchema: Record<string, unknown> = { type: "object", properties: {}, additionalProperties: true },
): Tool => ({
  manifest: {
    name,
    description: "",
    rationale: "",
    inputSchema,
    outputShape: {},
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 1000, maxOldSpaceSizeMb: 64 },
    hash: "sha256:0",
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "atomic",
  },
  code: "export async function run(){return null}",
});

const FETCH = ATOMIC("fetch-mail");
const SUMMARIZE = ATOMIC("summarize-list", {
  type: "object",
  properties: { items: {} },
  required: ["items"],
  additionalProperties: false,
});

function baseWorkflow(): Workflow {
  return {
    schemaVersion: 1,
    name: "wf",
    description: "",
    goal: "",
    inputs: [],
    steps: [
      {
        kind: "tool_call",
        label: "fetch",
        tool: "fetch-mail",
        arguments: {},
        resultBinding: "emails",
      },
      {
        kind: "tool_call",
        label: "summarize",
        tool: "summarize-list",
        arguments: { items: { kind: "symref", ref: "emails" } },
        resultBinding: "summary",
      },
    ],
    return: { source: { kind: "symref", ref: "summary" } },
  };
}

test("validator: happy path", async () => {
  const reg = fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE });
  const out = await validate(baseWorkflow(), reg);
  assert.equal(out.ok, true);
});

test("validator: rejects unsupported_schema_version", async () => {
  const wf = { ...baseWorkflow(), schemaVersion: 999 as 1 };
  const out = await validate(wf, fakeRegistry({}));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "unsupported_schema_version"));
});

test("validator: rejects non-empty inputs in v1", async () => {
  const wf = { ...baseWorkflow(), inputs: ["x"] };
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "inputs_not_supported_in_v1"));
});

test("validator: rejects duplicate step labels", async () => {
  const wf = baseWorkflow();
  wf.steps[1]!.label = wf.steps[0]!.label;
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "duplicate_step_label"));
});

test("validator: rejects duplicate result bindings", async () => {
  const wf = baseWorkflow();
  wf.steps[1]!.resultBinding = wf.steps[0]!.resultBinding;
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "duplicate_binding"));
});

test("validator: rejects invalid binding name", async () => {
  const wf = baseWorkflow();
  wf.steps[0]!.resultBinding = "bad-binding-with-dash";
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "invalid_binding_name"));
});

test("validator: rejects unknown_tool", async () => {
  const wf = baseWorkflow();
  wf.steps[0]!.tool = "no-such-tool";
  const out = await validate(wf, fakeRegistry({ "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "unknown_tool"));
});

test("validator: rejects meta_tool_not_callable_from_workflow", async () => {
  const wf = baseWorkflow();
  wf.steps[0]!.tool = "find_tool";
  const out = await validate(wf, fakeRegistry({ "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "meta_tool_not_callable_from_workflow"));
});

test("validator: rejects unbound symref", async () => {
  const wf = baseWorkflow();
  wf.steps[1]!.arguments = { items: { kind: "symref", ref: "no_such_binding" } };
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "unbound_symref"));
});

test("validator: rejects missing_required_arg", async () => {
  const wf = baseWorkflow();
  wf.steps[1]!.arguments = {};
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "missing_required_arg"));
});

test("validator: rejects unknown_arg when additionalProperties:false", async () => {
  const wf = baseWorkflow();
  wf.steps[1]!.arguments = {
    items: { kind: "symref", ref: "emails" },
    extra: { kind: "literal", value: 1 },
  };
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "unknown_arg"));
});

test("validator: rejects unbound return", async () => {
  const wf = baseWorkflow();
  wf.return = { source: { kind: "symref", ref: "no_such_binding" } };
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "unbound_return"));
});

test("validator: accepts null return", async () => {
  const wf = baseWorkflow();
  wf.return = null;
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, true);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/workflow/validator.test.ts`
Expected: FAIL — `validator.ts` does not exist.

- [ ] **Step 3: Implement the validator**

```typescript
import { META_TOOL_NAMES } from "../agent/meta-tools.ts";
import type { ToolRegistry } from "../registry/interface.ts";
import { IR_SCHEMA_VERSION, STEP_KIND, ARG_KIND, type Argument, type Step, type Workflow } from "./types.ts";

export type ValidationError = {
  code: string;
  message: string;
  stepLabel?: string;
  pointer?: string;
};

export type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] };

const BINDING_NAME = /^[a-z_][a-z0-9_]*$/i;

export async function validate(workflow: Workflow, registry: ToolRegistry): Promise<ValidationResult> {
  const errors: ValidationError[] = [];

  if (workflow.schemaVersion !== IR_SCHEMA_VERSION) {
    errors.push({
      code: "unsupported_schema_version",
      message: `expected schemaVersion ${IR_SCHEMA_VERSION}, got ${workflow.schemaVersion}`,
      pointer: "/schemaVersion",
    });
  }

  if (workflow.inputs.length !== 0) {
    errors.push({
      code: "inputs_not_supported_in_v1",
      message: "workflow.inputs must be [] in v1; tier B / COMPOSE will widen",
      pointer: "/inputs",
    });
  }

  const seenLabels = new Set<string>();
  const bindings = new Set<string>();

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i]!;
    const stepPtr = `/steps/${i}`;

    if (step.kind !== STEP_KIND.tool_call) {
      errors.push({
        code: "step_kind_not_supported_in_v1",
        message: `step kind '${(step as Step).kind}' is reserved for a future tier`,
        stepLabel: step.label,
        pointer: stepPtr,
      });
      continue;
    }

    if (seenLabels.has(step.label)) {
      errors.push({
        code: "duplicate_step_label",
        message: `step label '${step.label}' is not unique`,
        stepLabel: step.label,
        pointer: `${stepPtr}/label`,
      });
    }
    seenLabels.add(step.label);

    if (step.resultBinding !== null) {
      if (!BINDING_NAME.test(step.resultBinding)) {
        errors.push({
          code: "invalid_binding_name",
          message: `binding '${step.resultBinding}' must match /^[a-z_][a-z0-9_]*$/i`,
          stepLabel: step.label,
          pointer: `${stepPtr}/resultBinding`,
        });
      }
      if (bindings.has(step.resultBinding)) {
        errors.push({
          code: "duplicate_binding",
          message: `binding '${step.resultBinding}' is not unique`,
          stepLabel: step.label,
          pointer: `${stepPtr}/resultBinding`,
        });
      }
    }

    if (META_TOOL_NAMES.has(step.tool)) {
      errors.push({
        code: "meta_tool_not_callable_from_workflow",
        message: `meta-tool '${step.tool}' may not be called from a workflow`,
        stepLabel: step.label,
        pointer: `${stepPtr}/tool`,
      });
    }

    const callee = await registry.get(step.tool);
    if (!callee && !META_TOOL_NAMES.has(step.tool)) {
      errors.push({
        code: "unknown_tool",
        message: `tool '${step.tool}' is not in the registry`,
        stepLabel: step.label,
        pointer: `${stepPtr}/tool`,
      });
    }

    for (const [argName, arg] of Object.entries(step.arguments)) {
      const argPtr = `${stepPtr}/arguments/${argName}`;
      if (arg.kind === ARG_KIND.symref) {
        if (!bindings.has(arg.ref)) {
          errors.push({
            code: "unbound_symref",
            message: `argument '${argName}' references unbound name '${arg.ref}'`,
            stepLabel: step.label,
            pointer: argPtr,
          });
        }
        if ((arg as Argument & { path?: unknown }).path !== undefined) {
          errors.push({
            code: "symref_path_not_supported_in_v1",
            message: `SymRef.path is reserved for tier B`,
            stepLabel: step.label,
            pointer: argPtr,
          });
        }
      }
    }

    if (callee) {
      checkArgumentKeysAgainstSchema(step, callee.manifest.inputSchema, errors, stepPtr);
    }

    if (step.resultBinding !== null && BINDING_NAME.test(step.resultBinding) && !bindings.has(step.resultBinding)) {
      bindings.add(step.resultBinding);
    }
  }

  if (workflow.return !== null) {
    if (!bindings.has(workflow.return.source.ref)) {
      errors.push({
        code: "unbound_return",
        message: `workflow return references unbound name '${workflow.return.source.ref}'`,
        pointer: "/return/source/ref",
      });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function checkArgumentKeysAgainstSchema(
  step: Step,
  schema: Record<string, unknown>,
  errors: ValidationError[],
  stepPtr: string,
): void {
  const required = (schema.required as string[] | undefined) ?? [];
  const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
  const additional = schema.additionalProperties;
  const provided = new Set(Object.keys(step.arguments));

  for (const r of required) {
    if (!provided.has(r)) {
      errors.push({
        code: "missing_required_arg",
        message: `step '${step.label}' is missing required argument '${r}'`,
        stepLabel: step.label,
        pointer: `${stepPtr}/arguments`,
      });
    }
  }

  if (additional === false) {
    for (const k of provided) {
      if (!(k in properties)) {
        errors.push({
          code: "unknown_arg",
          message: `step '${step.label}' has unknown argument '${k}' (additionalProperties:false)`,
          stepLabel: step.label,
          pointer: `${stepPtr}/arguments/${k}`,
        });
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/workflow/validator.test.ts`
Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow/validator.ts packages/core/src/workflow/validator.test.ts
git commit -m "feat(workflow): validator for LEAN IR"
```

---

### Task 5: Executor

**Files:**
- Create: `packages/core/src/workflow/executor.ts`
- Create: `packages/core/src/workflow/executor.test.ts`

The executor holds **no registry reference** — it depends only on a `DispatchTool` callback. This keeps it testable in isolation and is what lets the AgentLoop wire its own `dispatchTool` in (Task 12). Validation is **not** re-run inside `executor.run` here — the spec calls for defense-in-depth, but the registry isn't injected; the AgentLoop validates before invoking. We achieve defense-in-depth by checking SymRef resolution at runtime (which subsumes the most important failure mode).

- [ ] **Step 1: Write the failing tests**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowExecutor } from "./executor.ts";
import { Tracer } from "../tracer.ts";
import type { Workflow } from "./types.ts";
import type { ToolResult } from "../types.ts";

async function makeTracer(): Promise<{ tracer: Tracer; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "exec-"));
  const tracer = await Tracer.open(join(dir, "traces"), "s");
  return { tracer, dir };
}

const TWO_STEP: Workflow = {
  schemaVersion: 1,
  name: "two-step",
  description: "",
  goal: "",
  inputs: [],
  steps: [
    {
      kind: "tool_call",
      label: "first",
      tool: "produce",
      arguments: { x: { kind: "literal", value: 1 } },
      resultBinding: "a",
    },
    {
      kind: "tool_call",
      label: "second",
      tool: "consume",
      arguments: { y: { kind: "symref", ref: "a" } },
      resultBinding: "b",
    },
  ],
  return: { source: { kind: "symref", ref: "b" } },
};

test("executor: happy path; SymRef resolves to prior result", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const calls: Array<{ name: string; args: unknown }> = [];
    const dispatch = async (name: string, args: unknown): Promise<ToolResult> => {
      calls.push({ name, args });
      if (name === "produce") return { ok: true, value: { from: "produce" } };
      if (name === "consume") return { ok: true, value: { echoed: args } };
      return { ok: false, error: { kind: "unknown_tool", message: name } };
    };
    const exec = new WorkflowExecutor({ tracer });
    const out = await exec.run(TWO_STEP, {}, dispatch, 0);
    assert.equal(out.ok, true);
    if (out.ok) assert.deepEqual(out.value, { echoed: { y: { from: "produce" } } });
    assert.deepEqual(calls, [
      { name: "produce", args: { x: 1 } },
      { name: "consume", args: { y: { from: "produce" } } },
    ]);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor: fail-fast on step error", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const dispatch = async (): Promise<ToolResult> => ({
      ok: false,
      error: { kind: "runtime_error", message: "boom" },
    });
    const exec = new WorkflowExecutor({ tracer });
    const out = await exec.run(TWO_STEP, {}, dispatch, 0);
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.error.kind, "runtime_error");
      const details = out.error.details as { workflow: string; failedStep: string };
      assert.equal(details.workflow, "two-step");
      assert.equal(details.failedStep, "first");
    }
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor: null return yields {ok:true, value:null}", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const wf: Workflow = { ...TWO_STEP, return: null };
    const dispatch = async (): Promise<ToolResult> => ({ ok: true, value: 42 });
    const exec = new WorkflowExecutor({ tracer });
    const out = await exec.run(wf, {}, dispatch, 0);
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.value, null);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor: runtime defense for unbound symref", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const wf: Workflow = {
      ...TWO_STEP,
      steps: [
        {
          kind: "tool_call",
          label: "first",
          tool: "consume",
          arguments: { y: { kind: "symref", ref: "ghost" } },
          resultBinding: "b",
        },
      ],
    };
    const dispatch = async (): Promise<ToolResult> => ({ ok: true, value: null });
    const exec = new WorkflowExecutor({ tracer });
    const out = await exec.run(wf, {}, dispatch, 0);
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.error.kind, "schema_violation");
      const details = out.error.details as { code?: string };
      assert.equal(details.code, "unbound_symref_runtime");
    }
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor: rejects non-empty runtime inputs in v1", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const dispatch = async (): Promise<ToolResult> => ({ ok: true, value: null });
    const exec = new WorkflowExecutor({ tracer });
    const out = await exec.run(TWO_STEP, { foo: 1 }, dispatch, 0);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.error.kind, "schema_violation");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/workflow/executor.test.ts`
Expected: FAIL — `executor.ts` does not exist.

- [ ] **Step 3: Implement the executor**

```typescript
import type { Tracer } from "../tracer.ts";
import type { ToolResult } from "../types.ts";
import { ARG_KIND, type Argument, type Workflow } from "./types.ts";

/** Logged when a workflow run begins. */
export const TRACE_KIND_WORKFLOW_START = "workflow-start" as const;
/** Logged before each step's underlying tool dispatch. */
export const TRACE_KIND_WORKFLOW_STEP_START = "workflow-step-start" as const;
/** Logged after each step's underlying tool dispatch. */
export const TRACE_KIND_WORKFLOW_STEP_END = "workflow-step-end" as const;
/** Logged when a workflow run completes (success or failure). */
export const TRACE_KIND_WORKFLOW_END = "workflow-end" as const;

export type DispatchTool = (
  name: string,
  args: unknown,
  depth: number,
) => Promise<ToolResult>;

export type WorkflowExecutorOpts = { tracer: Tracer };

export class WorkflowExecutor {
  constructor(private readonly opts: WorkflowExecutorOpts) {}

  async run(
    workflow: Workflow,
    runtimeInputs: Record<string, unknown>,
    dispatchTool: DispatchTool,
    depth: number,
  ): Promise<ToolResult> {
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

    const env = new Map<string, unknown>();
    const startedAt = Date.now();
    this.opts.tracer.log(TRACE_KIND_WORKFLOW_START, { name: workflow.name, depth });

    for (const step of workflow.steps) {
      const resolved: Record<string, unknown> = {};
      for (const [argName, arg] of Object.entries(step.arguments)) {
        const value = resolveArgument(arg, env);
        if (value.bound === false) {
          const failure: ToolResult = {
            ok: false,
            error: {
              kind: "schema_violation",
              message: `unbound symref '${arg.kind === ARG_KIND.symref ? arg.ref : ""}' at step '${step.label}'`,
              details: { code: "unbound_symref_runtime", workflow: workflow.name, failedStep: step.label },
            },
          };
          this.opts.tracer.log(TRACE_KIND_WORKFLOW_END, {
            name: workflow.name,
            ok: false,
            durationMs: Date.now() - startedAt,
          });
          return failure;
        }
        resolved[argName] = value.value;
      }

      this.opts.tracer.log(TRACE_KIND_WORKFLOW_STEP_START, {
        workflow: workflow.name,
        label: step.label,
        tool: step.tool,
      });
      const stepStarted = Date.now();
      const result = await dispatchTool(step.tool, resolved, depth + 1);
      this.opts.tracer.log(TRACE_KIND_WORKFLOW_STEP_END, {
        workflow: workflow.name,
        label: step.label,
        tool: step.tool,
        ok: result.ok,
        durationMs: Date.now() - stepStarted,
      });

      if (!result.ok) {
        const failure: ToolResult = {
          ok: false,
          error: {
            ...result.error,
            details: { ...(typeof result.error.details === "object" && result.error.details ? result.error.details : {}), workflow: workflow.name, failedStep: step.label },
          },
        };
        this.opts.tracer.log(TRACE_KIND_WORKFLOW_END, {
          name: workflow.name,
          ok: false,
          durationMs: Date.now() - startedAt,
        });
        return failure;
      }

      if (step.resultBinding !== null) env.set(step.resultBinding, result.value);
    }

    this.opts.tracer.log(TRACE_KIND_WORKFLOW_END, {
      name: workflow.name,
      ok: true,
      durationMs: Date.now() - startedAt,
    });

    if (workflow.return === null) return { ok: true, value: null };
    return { ok: true, value: env.get(workflow.return.source.ref) };
  }
}

function resolveArgument(arg: Argument, env: ReadonlyMap<string, unknown>): { bound: true; value: unknown } | { bound: false } {
  if (arg.kind === ARG_KIND.literal) return { bound: true, value: arg.value };
  if (!env.has(arg.ref)) return { bound: false };
  return { bound: true, value: env.get(arg.ref) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/workflow/executor.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow/executor.ts packages/core/src/workflow/executor.test.ts
git commit -m "feat(workflow): in-process executor + trace events"
```

---

### Task 6: Lift-from-trace

**Files:**
- Create: `packages/core/src/workflow/lift.ts`
- Create: `packages/core/src/workflow/lift.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { liftFromTrace } from "./lift.ts";
import type { Tool } from "../types.ts";

const FETCH: Tool = {
  manifest: {
    name: "read-csv",
    description: "",
    rationale: "",
    inputSchema: {},
    outputShape: {},
    permissions: { fsRead: ["/x.csv"], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 1000, maxOldSpaceSizeMb: 64 },
    hash: "sha256:0",
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "atomic",
  },
  code: "",
};
const FILTER: Tool = {
  ...FETCH,
  manifest: { ...FETCH.manifest, name: "filter-rows", permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] } },
};
const COUNT: Tool = {
  ...FETCH,
  manifest: { ...FETCH.manifest, name: "count-rows", permissions: { fsRead: [], fsWrite: [], net: "allowlist", netAllowlist: ["api"], env: [] } },
};

const TOOLS: Record<string, Tool> = {
  "read-csv": FETCH,
  "filter-rows": FILTER,
  "count-rows": COUNT,
};

const SLICE = [
  { name: "read-csv", args: { path: "/x.csv" }, ok: true as const, value: { rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }] } },
  { name: "filter-rows", args: { rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }], predicate: "a > 1" }, ok: true as const, value: { rows: [{ a: 3, b: 4 }] } },
  { name: "count-rows", args: { rows: [{ a: 3, b: 4 }] }, ok: true as const, value: { count: 1 } },
];

test("lift: structural — args matching prior values become symrefs; others stay literal", () => {
  const out = liftFromTrace({
    slice: SLICE,
    name: "filter-and-count",
    description: "",
    goal: "",
    toolsByName: TOOLS,
  });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const wf = out.workflow;
  assert.equal(wf.steps.length, 3);
  assert.deepEqual(wf.steps[0]!.arguments, { path: { kind: "literal", value: "/x.csv" } });
  assert.deepEqual(wf.steps[1]!.arguments, {
    rows: { kind: "symref", ref: wf.steps[0]!.resultBinding },
    predicate: { kind: "literal", value: "a > 1" },
  });
  assert.deepEqual(wf.steps[2]!.arguments, { rows: { kind: "symref", ref: wf.steps[1]!.resultBinding } });
  assert.deepEqual(wf.return, { source: { kind: "symref", ref: wf.steps[2]!.resultBinding! } });
});

test("lift: top-level only — sub-value access falls back to literal", () => {
  const slice = [
    { name: "read-csv", args: { path: "/x.csv" }, ok: true as const, value: { rows: [{ a: 1 }] } },
    { name: "filter-rows", args: { firstRow: { a: 1 } }, ok: true as const, value: { rows: [] } },
  ];
  const out = liftFromTrace({ slice, name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.workflow.steps[1]!.arguments.firstRow!.kind, "literal");
});

test("lift: earliest-wins on duplicate canonical values", () => {
  const slice = [
    { name: "read-csv", args: {}, ok: true as const, value: { same: true } },
    { name: "read-csv", args: {}, ok: true as const, value: { same: true } },
    { name: "filter-rows", args: { rows: { same: true } }, ok: true as const, value: { rows: [] } },
  ];
  const out = liftFromTrace({ slice, name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const sym = out.workflow.steps[2]!.arguments.rows!;
  assert.equal(sym.kind, "symref");
  if (sym.kind === "symref") assert.equal(sym.ref, out.workflow.steps[0]!.resultBinding);
});

test("lift: deterministic — same input twice yields byte-identical IR", () => {
  const a = liftFromTrace({ slice: SLICE, name: "x", description: "", goal: "", toolsByName: TOOLS });
  const b = liftFromTrace({ slice: SLICE, name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(JSON.stringify(a.workflow), JSON.stringify(b.workflow));
});

test("lift: manifest derivation — permissions union and dependencies", () => {
  const out = liftFromTrace({ slice: SLICE, name: "x", description: "d", goal: "g", toolsByName: TOOLS });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.manifest.kind, "workflow");
  assert.deepEqual(out.manifest.dependencies.sort(), ["count-rows", "filter-rows", "read-csv"]);
  assert.equal(out.manifest.permissions.net, "allowlist");
  assert.deepEqual(out.manifest.permissions.fsRead, ["/x.csv"]);
  assert.deepEqual(out.manifest.permissions.netAllowlist, ["api"]);
});

test("lift: filters out non-ok invocations", () => {
  const slice = [
    { name: "read-csv", args: {}, ok: true as const, value: { x: 1 } },
    { name: "read-csv", args: {}, ok: false as const, value: undefined },
    { name: "filter-rows", args: { rows: { x: 1 } }, ok: true as const, value: null },
  ];
  const out = liftFromTrace({ slice, name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.workflow.steps.length, 2);
});

test("lift: rejects empty slice (after filter)", () => {
  const out = liftFromTrace({ slice: [], name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.errors[0]!.code, "empty_slice");
});

test("lift: rejects unknown tool in slice", () => {
  const slice = [{ name: "no-such", args: {}, ok: true as const, value: 1 }];
  const out = liftFromTrace({ slice, name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.errors[0]!.code, "unknown_tool");
});

test("lift: surfaces literal-fallback list for sub-value args", () => {
  const slice = [
    { name: "read-csv", args: { path: "/x.csv" }, ok: true as const, value: { rows: [{ a: 1 }] } },
    { name: "filter-rows", args: { firstRow: { a: 1 } }, ok: true as const, value: null },
  ];
  const out = liftFromTrace({ slice, name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.literalFallbacks.length, 1);
  assert.equal(out.literalFallbacks[0]!.argName, "firstRow");
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/workflow/lift.test.ts`
Expected: FAIL — `lift.ts` does not exist.

- [ ] **Step 3: Implement lift-from-trace**

```typescript
import { canonicalJson } from "../hash.ts";
import { normalizePermissions } from "../permissions-normalize.ts";
import type { Tool, ToolManifest, Permissions } from "../types.ts";
import { IR_SCHEMA_VERSION, STEP_KIND, ARG_KIND, type Argument, type ToolCallStep, type Workflow } from "./types.ts";

export type Invocation = {
  name: string;
  args: unknown;
  ok: boolean;
  /** Present iff ok === true. */
  value: unknown;
};

export type LiftRequest = {
  slice: Invocation[];
  name: string;
  description: string;
  goal: string;
  /** Snapshot of tools by name (caller's registry view). */
  toolsByName: Record<string, Tool>;
};

export type LiftError = { code: string; message: string };

export type LiteralFallback = {
  stepLabel: string;
  argName: string;
  /** canonicalJson of the literal value, for UX surfacing. */
  canonicalValue: string;
};

export type LiftResult =
  | {
      ok: true;
      workflow: Workflow;
      manifest: Omit<ToolManifest, "hash" | "createdAt"> & { hash: string; createdAt: string };
      literalFallbacks: LiteralFallback[];
    }
  | { ok: false; errors: LiftError[] };

const SAFE_NAME = /[^a-z0-9_-]/gi;

function sanitize(name: string): string {
  return name.replace(SAFE_NAME, "_").toLowerCase();
}

export function liftFromTrace(req: LiftRequest): LiftResult {
  const successes = req.slice.filter((s) => s.ok);
  if (successes.length === 0) {
    return { ok: false, errors: [{ code: "empty_slice", message: "no successful invocations to lift" }] };
  }

  for (const inv of successes) {
    if (!(inv.name in req.toolsByName)) {
      return { ok: false, errors: [{ code: "unknown_tool", message: `tool '${inv.name}' is not in the registry snapshot` }] };
    }
  }

  const steps: ToolCallStep[] = [];
  const bindingByValue = new Map<string, string>();
  const literalFallbacks: LiteralFallback[] = [];

  for (let i = 0; i < successes.length; i++) {
    const inv = successes[i]!;
    const safe = sanitize(inv.name);
    const label = `step_${i}_${safe}`;
    const binding = `r_${i}_${safe}`;

    const argEntries = Object.entries((inv.args ?? {}) as Record<string, unknown>);
    const args: Record<string, Argument> = {};
    for (const [k, v] of argEntries) {
      const ck = canonicalJson(v);
      const hit = bindingByValue.get(ck);
      if (hit !== undefined) {
        args[k] = { kind: ARG_KIND.symref, ref: hit };
      } else {
        args[k] = { kind: ARG_KIND.literal, value: v };
        literalFallbacks.push({ stepLabel: label, argName: k, canonicalValue: ck });
      }
    }

    steps.push({
      kind: STEP_KIND.tool_call,
      label,
      tool: inv.name,
      arguments: args,
      resultBinding: binding,
    });

    const ck = canonicalJson(inv.value);
    if (!bindingByValue.has(ck)) bindingByValue.set(ck, binding);
  }

  const lastBinding = steps[steps.length - 1]!.resultBinding;
  const workflow: Workflow = {
    schemaVersion: IR_SCHEMA_VERSION,
    name: req.name,
    description: req.description,
    goal: req.goal,
    inputs: [],
    steps,
    return: lastBinding === null ? null : { source: { kind: ARG_KIND.symref, ref: lastBinding } },
  };

  const dependencies = Array.from(new Set(steps.map((s) => s.tool))).sort();
  const permissions = unionPermissions(dependencies.map((d) => req.toolsByName[d]!.manifest.permissions));

  const manifest: Omit<ToolManifest, "hash"> = {
    name: req.name,
    description: req.description,
    rationale: req.goal,
    inputSchema: {},
    outputShape: {},
    permissions,
    dependencies,
    limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    createdAt: new Date().toISOString(),
    kind: "workflow",
  };

  const hash = "sha256:" + simpleHash(canonicalJson(workflow) + "\n" + canonicalJson(manifest));
  const fullManifest = { ...manifest, hash };

  return { ok: true, workflow, manifest: fullManifest, literalFallbacks };
}

function unionPermissions(list: Permissions[]): Permissions {
  const out = normalizePermissions({});
  for (const p of list) {
    out.fsRead = unionStrings(out.fsRead, p.fsRead);
    out.fsWrite = unionStrings(out.fsWrite, p.fsWrite);
    out.netAllowlist = unionStrings(out.netAllowlist, p.netAllowlist);
    out.env = unionStrings(out.env, p.env);
    if (p.net === "allowlist") out.net = "allowlist";
  }
  return out;
}

function unionStrings(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b])).sort();
}

function simpleHash(s: string): string {
  // Use createHash here too so the hash is stable across processes.
  // (Imported at the top would be cleaner; localized to keep test diffs small.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(s).digest("hex");
}
```

- [ ] **Step 4: Hoist the `createHash` import**

Replace the `simpleHash` function above with a clean import. Edit the top of `lift.ts`:

```typescript
import { createHash } from "node:crypto";
import { canonicalJson } from "../hash.ts";
// ... rest of imports
```

…and replace the `simpleHash` function body with:

```typescript
function simpleHash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/workflow/lift.test.ts`
Expected: all 9 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/workflow/lift.ts packages/core/src/workflow/lift.test.ts
git commit -m "feat(workflow): deterministic structural lift-from-trace"
```

---

### Task 7: Literate renderer

**Files:**
- Create: `packages/core/src/workflow/renderer.ts`
- Create: `packages/core/src/workflow/renderer.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLiterate } from "./renderer.ts";
import type { Workflow } from "./types.ts";

const WF: Workflow = {
  schemaVersion: 1,
  name: "filter-and-count",
  description: "",
  goal: "",
  inputs: [],
  steps: [
    {
      kind: "tool_call",
      label: "step_0",
      tool: "read-csv",
      arguments: { path: { kind: "literal", value: "/x.csv" } },
      resultBinding: "r_0",
    },
    {
      kind: "tool_call",
      label: "step_1",
      tool: "count-rows",
      arguments: { rows: { kind: "symref", ref: "r_0" } },
      resultBinding: "r_1",
    },
  ],
  return: { source: { kind: "symref", ref: "r_1" } },
};

test("renderer: env-less render shows raw @names", () => {
  const out = renderLiterate(WF);
  assert.match(out, /Workflow: filter-and-count/);
  assert.match(out, /@r_0\s*←\s*read-csv\(path="\/x\.csv"\)/);
  assert.match(out, /@r_1\s*←\s*count-rows\(rows=@r_0\)/);
  assert.match(out, /Return: @r_1/);
});

test("renderer: env render substitutes values", () => {
  const env = new Map<string, unknown>([
    ["r_0", { rows: [{ a: 1 }] }],
    ["r_1", { count: 1 }],
  ]);
  const out = renderLiterate(WF, env);
  assert.match(out, /@r_0={"rows":\[{"a":1}\]}/);
  assert.match(out, /@r_1={"count":1}/);
});

test("renderer: deterministic — same workflow + env yields same string", () => {
  const env = new Map<string, unknown>([["r_0", 1], ["r_1", 2]]);
  assert.equal(renderLiterate(WF, env), renderLiterate(WF, env));
});

test("renderer: workflow with null return omits Return line", () => {
  const wf: Workflow = { ...WF, return: null };
  const out = renderLiterate(wf);
  assert.doesNotMatch(out, /Return:/);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/workflow/renderer.test.ts`
Expected: FAIL — `renderer.ts` does not exist.

- [ ] **Step 3: Implement the renderer**

```typescript
import { canonicalJson } from "../hash.ts";
import { ARG_KIND, type Argument, type Workflow } from "./types.ts";

export function renderLiterate(workflow: Workflow, env?: ReadonlyMap<string, unknown>): string {
  const lines: string[] = [`Workflow: ${workflow.name}`];

  for (const step of workflow.steps) {
    const argsRendered = Object.entries(step.arguments)
      .map(([k, v]) => `${k}=${renderArg(v, env)}`)
      .join(", ");
    const lhs = step.resultBinding === null ? "(unbound)" : decorateBinding(step.resultBinding, env);
    lines.push(`  ${lhs} ← ${step.tool}(${argsRendered})`);
  }

  if (workflow.return !== null) {
    lines.push(`Return: ${decorateBinding(workflow.return.source.ref, env)}`);
  }
  return lines.join("\n");
}

function renderArg(arg: Argument, env: ReadonlyMap<string, unknown> | undefined): string {
  if (arg.kind === ARG_KIND.literal) return canonicalJson(arg.value);
  return decorateBinding(arg.ref, env);
}

function decorateBinding(name: string, env: ReadonlyMap<string, unknown> | undefined): string {
  if (!env || !env.has(name)) return `@${name}`;
  return `@${name}=${canonicalJson(env.get(name))}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/workflow/renderer.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow/renderer.ts packages/core/src/workflow/renderer.test.ts
git commit -m "feat(workflow): literate renderer for IR"
```

---

### Task 8: Module barrel

**Files:**
- Create: `packages/core/src/workflow/index.ts`

- [ ] **Step 1: Write the barrel**

```typescript
export {
  IR_SCHEMA_VERSION,
  STEP_KIND,
  ARG_KIND,
} from "./types.ts";
export type {
  IrSchemaVersion,
  StepKind,
  ArgKind,
  Literal,
  SymRef,
  Argument,
  ToolCallStep,
  Step,
  WorkflowReturn,
  Workflow,
} from "./types.ts";

export { WORKFLOW_SCHEMA, ARGUMENT_SCHEMA, TOOL_CALL_STEP_SCHEMA, WORKFLOW_RETURN_SCHEMA } from "./schema.ts";

export { parseWorkflow } from "./parser.ts";
export type { ParseResult, ParseError } from "./parser.ts";

export { validate } from "./validator.ts";
export type { ValidationResult, ValidationError } from "./validator.ts";

export {
  WorkflowExecutor,
  TRACE_KIND_WORKFLOW_START,
  TRACE_KIND_WORKFLOW_STEP_START,
  TRACE_KIND_WORKFLOW_STEP_END,
  TRACE_KIND_WORKFLOW_END,
} from "./executor.ts";
export type { DispatchTool, WorkflowExecutorOpts } from "./executor.ts";

export { liftFromTrace } from "./lift.ts";
export type { Invocation, LiftRequest, LiftResult, LiftError, LiteralFallback } from "./lift.ts";

export { renderLiterate } from "./renderer.ts";
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/workflow/index.ts
git commit -m "feat(workflow): public barrel exports"
```

---

## Phase 2 — Tool kind + registry support

### Task 9: Add `workflow` to `TOOL_KIND` and reserved verify fields

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Update the kind enum**

Replace the existing `TOOL_KIND` block in `packages/core/src/types.ts`:

```typescript
/** Values for {@link ToolManifest.kind} / {@link ToolDraft.kind}. */
export const TOOL_KIND = {
  atomic: "atomic",
  composite: "composite",
  workflow: "workflow",
} as const;
```

- [ ] **Step 2: Add reserved-future fields to `ToolManifest`**

Inside the `ToolManifest` type (replace the whole type), add the optional verify fields at the bottom:

```typescript
export type ToolManifest = {
  name: string;
  description: string;
  rationale: string;
  inputSchema: Record<string, unknown>;
  outputShape: Record<string, unknown>;
  permissions: Permissions;
  dependencies: string[];
  limits: Limits;
  hash: string;
  createdAt: string;
  kind: ToolKind;

  /** Reserved for the VERIFY follow-up spec. Ignored in v1. */
  sourceLabels?: string[];
  /** Reserved for the VERIFY follow-up spec. Ignored in v1. */
  sinkParams?: string[];
  /** Reserved for the VERIFY follow-up spec. Ignored in v1. */
  preconditions?: string[];
  /** Reserved for the VERIFY follow-up spec. Ignored in v1. */
  postconditions?: string[];
  /** Reserved for the VERIFY follow-up spec. Ignored in v1. */
  frameConditions?: string[];
};
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run all core tests** (some existing tests touch `TOOL_KIND`)

Run: `cd packages/core && npm test`
Expected: all pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(types): TOOL_KIND.workflow + reserved verify fields"
```

---

### Task 10: Registry support for `workflow.json`

**Files:**
- Modify: `packages/core/src/registry/interface.ts`
- Modify: `packages/core/src/registry/fs-registry.ts`

- [ ] **Step 1: Add the failing test**

Append to `packages/core/src/registry/fs-registry.test.ts` (create the file if it does not exist; otherwise add the test inside):

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsToolRegistry } from "./fs-registry.ts";
import type { ToolManifest } from "../types.ts";
import type { Workflow } from "../workflow/types.ts";

test("FsToolRegistry: rehydrates a workflow tool from workflow.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reg-wf-"));
  try {
    const toolDir = join(dir, "wf1");
    await mkdir(toolDir, { recursive: true });

    const manifest: ToolManifest = {
      name: "wf1",
      description: "",
      rationale: "",
      inputSchema: {},
      outputShape: {},
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [],
      limits: { timeoutMs: 1000, maxOldSpaceSizeMb: 64 },
      hash: "sha256:0",
      createdAt: "2026-01-01T00:00:00.000Z",
      kind: "workflow",
    };
    const workflow: Workflow = {
      schemaVersion: 1,
      name: "wf1",
      description: "",
      goal: "",
      inputs: [],
      steps: [
        {
          kind: "tool_call",
          label: "only",
          tool: "wf1",
          arguments: {},
          resultBinding: "r",
        },
      ],
      return: { source: { kind: "symref", ref: "r" } },
    };

    await writeFile(join(toolDir, "manifest.json"), JSON.stringify(manifest), "utf8");
    await writeFile(join(toolDir, "workflow.json"), JSON.stringify(workflow), "utf8");

    const reg = await FsToolRegistry.open(dir);
    assert.ok(await reg.has("wf1"));
    const got = await reg.get("wf1");
    assert.equal(got?.manifest.kind, "workflow");
    const wf = await reg.getWorkflow("wf1");
    assert.equal(wf?.name, "wf1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/registry/fs-registry.test.ts`
Expected: FAIL — `getWorkflow` not on interface and rehydrate doesn't load workflow.json.

- [ ] **Step 3: Add `getWorkflow` to the interface**

Modify `packages/core/src/registry/interface.ts`:

```typescript
import type { ApprovalRecord, Tool, ToolSummary } from "../types.ts";
import type { Workflow } from "../workflow/types.ts";

export interface ToolRegistry {
  list(): Promise<ToolSummary[]>;
  listSync(): ToolSummary[];
  get(name: string): Promise<Tool | null>;
  getApproval(name: string): Promise<ApprovalRecord | null>;
  save(tool: Tool, approval: ApprovalRecord): Promise<void>;
  /**
   * Persist a workflow tool. The `Tool.code` is ignored; the workflow is
   * written to `workflow.json`. Manifest must have `kind: "workflow"`.
   */
  saveWorkflow(tool: Tool, workflow: Workflow, approval: ApprovalRecord): Promise<void>;
  delete(name: string, opts?: { cascade?: boolean }): Promise<void>;
  getDependents(name: string): Promise<string[]>;
  has(name: string): Promise<boolean>;
  /** Returns the parsed Workflow IR for a tool of `kind: "workflow"`, or null. */
  getWorkflow(name: string): Promise<Workflow | null>;
  rootDir(): string;
}
```

- [ ] **Step 4: Update `FsToolRegistry`**

Replace `packages/core/src/registry/fs-registry.ts` `rehydrate` plus add the new methods. The full updated file:

```typescript
import { mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalRecord, Tool, ToolManifest, ToolSummary } from "../types.ts";
import type { ToolRegistry } from "./interface.ts";
import { parseWorkflow } from "../workflow/parser.ts";
import type { Workflow } from "../workflow/types.ts";

type CacheEntry = { tool: Tool; approval: ApprovalRecord | null; workflow: Workflow | null };

export class FsToolRegistry implements ToolRegistry {
  private readonly dir: string;
  private cache = new Map<string, CacheEntry>();

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async open(dir: string): Promise<FsToolRegistry> {
    await mkdir(dir, { recursive: true });
    const reg = new FsToolRegistry(dir);
    await reg.rehydrate();
    return reg;
  }

  rootDir(): string {
    return this.dir;
  }

  private async rehydrate(): Promise<void> {
    this.cache.clear();
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const sub = join(this.dir, name);
      const st = await stat(sub).catch(() => null);
      if (!st?.isDirectory()) continue;
      const manifestPath = join(sub, "manifest.json");
      const approvalPath = join(sub, "approval.json");
      try {
        const mRaw = await readFile(manifestPath, "utf8");
        const manifest = JSON.parse(mRaw) as ToolManifest;

        let code = "";
        let workflow: Workflow | null = null;
        if (manifest.kind === "workflow") {
          const wfRaw = await readFile(join(sub, "workflow.json"), "utf8");
          const parsed = parseWorkflow(JSON.parse(wfRaw));
          if (!parsed.ok) continue;
          workflow = parsed.workflow;
        } else {
          code = await readFile(join(sub, "tool.ts"), "utf8");
        }

        let approval: ApprovalRecord | null = null;
        try {
          approval = JSON.parse(await readFile(approvalPath, "utf8")) as ApprovalRecord;
        } catch { /* missing approval.json is OK */ }

        this.cache.set(manifest.name, { tool: { manifest, code }, approval, workflow });
      } catch {
        // Corrupt/partial entry — skip.
      }
    }
  }

  async list(): Promise<ToolSummary[]> {
    return this.summaries();
  }

  listSync(): ToolSummary[] {
    return this.summaries();
  }

  private summaries(): ToolSummary[] {
    return Array.from(this.cache.values()).map(({ tool }) => ({
      name: tool.manifest.name,
      description: tool.manifest.description,
      hash: tool.manifest.hash,
      kind: tool.manifest.kind,
    }));
  }

  async has(name: string): Promise<boolean> {
    return this.cache.has(name);
  }

  async get(name: string): Promise<Tool | null> {
    return this.cache.get(name)?.tool ?? null;
  }

  async getApproval(name: string): Promise<ApprovalRecord | null> {
    return this.cache.get(name)?.approval ?? null;
  }

  async getWorkflow(name: string): Promise<Workflow | null> {
    return this.cache.get(name)?.workflow ?? null;
  }

  async save(tool: Tool, approval: ApprovalRecord): Promise<void> {
    const sub = join(this.dir, tool.manifest.name);
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "tool.ts"), tool.code, "utf8");
    await writeFile(join(sub, "manifest.json"), JSON.stringify(tool.manifest, null, 2), "utf8");
    await writeFile(join(sub, "approval.json"), JSON.stringify(approval, null, 2), "utf8");
    this.cache.set(tool.manifest.name, { tool, approval, workflow: null });
  }

  async saveWorkflow(tool: Tool, workflow: Workflow, approval: ApprovalRecord): Promise<void> {
    if (tool.manifest.kind !== "workflow") {
      throw new Error(`saveWorkflow requires manifest.kind === "workflow"`);
    }
    const sub = join(this.dir, tool.manifest.name);
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "workflow.json"), JSON.stringify(workflow, null, 2), "utf8");
    await writeFile(join(sub, "manifest.json"), JSON.stringify(tool.manifest, null, 2), "utf8");
    await writeFile(join(sub, "approval.json"), JSON.stringify(approval, null, 2), "utf8");
    this.cache.set(tool.manifest.name, { tool: { manifest: tool.manifest, code: "" }, approval, workflow });
  }

  async delete(name: string, opts: { cascade?: boolean } = {}): Promise<void> {
    const dependents = await this.getDependents(name);
    if (dependents.length > 0 && !opts.cascade) {
      throw new Error(`Cannot delete '${name}': dependents exist: ${dependents.join(", ")}`);
    }
    if (opts.cascade) {
      for (const d of dependents) await this.delete(d, { cascade: true });
    }
    await rm(join(this.dir, name), { recursive: true, force: true });
    this.cache.delete(name);
  }

  async getDependents(name: string): Promise<string[]> {
    const out: string[] = [];
    for (const { tool } of this.cache.values()) {
      if (tool.manifest.dependencies.includes(name)) out.push(tool.manifest.name);
    }
    return out.sort();
  }
}
```

- [ ] **Step 5: Run the new test**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/registry/fs-registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full core test suite (regressions)**

Run: `cd packages/core && npm test`
Expected: all tests pass (including pre-existing factory/agent tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/registry/interface.ts packages/core/src/registry/fs-registry.ts packages/core/src/registry/fs-registry.test.ts
git commit -m "feat(registry): persist + rehydrate workflow tools"
```

---

## Phase 3 — AgentLoop integration

### Task 11: Tracer event constants

**Files:**
- Modify: `packages/core/src/tracer.ts`

The four `TRACE_KIND_WORKFLOW_*` constants live in `executor.ts` for tightness. We re-export them from `tracer.ts` for consistency with the existing `TRACE_KIND_*` pattern.

- [ ] **Step 1: Re-export workflow trace kinds from `tracer.ts`**

Append to `packages/core/src/tracer.ts`:

```typescript
export {
  TRACE_KIND_WORKFLOW_START,
  TRACE_KIND_WORKFLOW_STEP_START,
  TRACE_KIND_WORKFLOW_STEP_END,
  TRACE_KIND_WORKFLOW_END,
} from "./workflow/executor.ts";
```

- [ ] **Step 2: Re-export workflow public surface from the package barrel**

Modify `packages/core/src/index.ts`. Replace the existing `Tracer` export block with the augmented one and add a workflow block at the bottom:

```typescript
export {
  Tracer,
  TRACE_KIND_EXECUTION_DENIED,
  TRACE_KIND_FACTORY_REPAIR_LLM,
  TRACE_KIND_LLM_SYNTHESIS,
  TRACE_KIND_LLM_SYNTHESIS_START,
  TRACE_KIND_LLM_TURN,
  TRACE_KIND_LLM_TURN_START,
  TRACE_KIND_TOOL_CALL,
  TRACE_KIND_TOOL_DISPATCH_START,
  TRACE_KIND_TOOL_INVOKED,
  TRACE_KIND_WORKFLOW_START,
  TRACE_KIND_WORKFLOW_STEP_START,
  TRACE_KIND_WORKFLOW_STEP_END,
  TRACE_KIND_WORKFLOW_END,
} from "./tracer.ts";
```

Then append at the end of `index.ts`:

```typescript
export {
  IR_SCHEMA_VERSION,
  STEP_KIND,
  ARG_KIND,
  parseWorkflow,
  validate as validateWorkflow,
  WorkflowExecutor,
  liftFromTrace,
  renderLiterate,
} from "./workflow/index.ts";
export type {
  Workflow,
  Step,
  ToolCallStep,
  Argument,
  Literal,
  SymRef,
  WorkflowReturn,
  StepKind,
  ArgKind,
  IrSchemaVersion,
  ParseResult,
  ParseError,
  ValidationResult,
  ValidationError,
  DispatchTool,
  Invocation,
  LiftRequest,
  LiftResult,
  LiftError,
  LiteralFallback,
} from "./workflow/index.ts";
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/tracer.ts packages/core/src/index.ts
git commit -m "feat(tracer): re-export workflow trace event kinds"
```

---

### Task 12: AgentLoop dispatches workflow tools + extends `ToolInvokedEvent`

**Files:**
- Modify: `packages/core/src/agent/agent-loop.ts`

The agent loop holds a single `WorkflowExecutor` (constructed in the constructor). `dispatchTool` branches on `manifest.kind === "workflow"` to route to the executor; the executor calls back into `dispatchTool` for each step. `ToolInvokedEvent` gains optional `value` and `error` fields so the CLI's compose collector can capture results for lifting (Task 16).

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/agent/agent-loop.test.ts` (the file exists; new test goes alongside the existing ones):

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./agent-loop.ts";
import { FsToolRegistry } from "../registry/fs-registry.ts";
import { NodePermissionSandbox } from "../sandbox/node-permission-sandbox.ts";
import { TieredApprovalPolicy } from "../approval/tiered-policy.ts";
import { APPROVAL_DECISION } from "../approval/interface.ts";
import { HybridToolIndex } from "../index-store/hybrid-index.ts";
import { ToolFactory } from "../factory/factory.ts";
import { MockLLMProvider } from "../llm/mock-provider.ts";
import { Tracer } from "../tracer.ts";
import type { Tool, ToolManifest } from "../types.ts";
import type { Workflow } from "../workflow/types.ts";
import type { ToolInvokedEvent } from "./agent-loop.ts";

test("AgentLoop: invoking a workflow tool routes to the executor and emits step events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-wf-"));
  try {
    const toolsDir = join(dir, "tools");
    await mkdir(toolsDir, { recursive: true });

    // An atomic tool the workflow will call.
    const atomicDir = join(toolsDir, "echo-1");
    await mkdir(atomicDir, { recursive: true });
    const atomicManifest: ToolManifest = {
      name: "echo-1",
      description: "echoes 1",
      rationale: "",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      outputShape: {},
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [],
      limits: { timeoutMs: 5000, maxOldSpaceSizeMb: 128 },
      hash: "sha256:0",
      createdAt: "2026-01-01T00:00:00.000Z",
      kind: "atomic",
    };
    await writeFile(join(atomicDir, "manifest.json"), JSON.stringify(atomicManifest), "utf8");
    await writeFile(join(atomicDir, "tool.ts"), "export async function run(){return 1;}", "utf8");
    await writeFile(join(atomicDir, "approval.json"), JSON.stringify({
      hash: atomicManifest.hash,
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedBy: "test",
      alwaysApprove: true,
    }), "utf8");

    // The workflow tool that calls echo-1.
    const wfDir = join(toolsDir, "wf-echo");
    await mkdir(wfDir, { recursive: true });
    const wfManifest: ToolManifest = {
      ...atomicManifest,
      name: "wf-echo",
      kind: "workflow",
      dependencies: ["echo-1"],
    };
    const workflow: Workflow = {
      schemaVersion: 1,
      name: "wf-echo",
      description: "",
      goal: "",
      inputs: [],
      steps: [{ kind: "tool_call", label: "only", tool: "echo-1", arguments: {}, resultBinding: "r" }],
      return: { source: { kind: "symref", ref: "r" } },
    };
    await writeFile(join(wfDir, "manifest.json"), JSON.stringify(wfManifest), "utf8");
    await writeFile(join(wfDir, "workflow.json"), JSON.stringify(workflow), "utf8");
    await writeFile(join(wfDir, "approval.json"), JSON.stringify({
      hash: wfManifest.hash,
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedBy: "test",
      alwaysApprove: true,
    }), "utf8");

    const registry = await FsToolRegistry.open(toolsDir);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider();
    const prompter = {
      promptGate1: async () => ({ decision: APPROVAL_DECISION.approve, alwaysApprove: true }),
      promptGate23: async () => ({ decision: APPROVAL_DECISION.approve, alwaysApprove: true }),
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });
    const index = new HybridToolIndex(registry);

    const events: ToolInvokedEvent[] = [];
    const loop = new AgentLoop({
      llm,
      registry,
      index,
      sandbox,
      approval,
      factory,
      tracer,
      onToolInvoked: (e) => events.push(e),
    });

    // Direct dispatch via the public test seam (or via a one-shot synthetic LLM message).
    const result = await loop.dispatchPublic("wf-echo", {});
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, 1);
    assert.ok(events.some((e) => e.name === "wf-echo"));
    assert.ok(events.some((e) => e.name === "echo-1"));
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

(This test uses a `dispatchPublic` shim; we add it to `AgentLoop` as a thin wrapper around `dispatchTool` so the test exercises the production code path without going through the LLM. It's a public-but-test-shaped method, named clearly so future maintainers know it's a seam.)

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/agent/agent-loop.test.ts`
Expected: FAIL — `dispatchPublic` doesn't exist; workflow dispatch not wired.

- [ ] **Step 3: Modify `agent-loop.ts`**

Make these changes to `packages/core/src/agent/agent-loop.ts`:

**3a. Imports (add):**

```typescript
import { TOOL_KIND } from "../types.ts";
import { WorkflowExecutor } from "../workflow/executor.ts";
import { validate as validateWorkflow } from "../workflow/validator.ts";
```

**3b. Extend `ToolInvokedEvent`:**

```typescript
export type ToolInvokedEvent = {
  name: string;
  args: unknown;
  ok: boolean;
  durationMs: number;
  /** Present iff ok === true. */
  value?: unknown;
  /** Present iff ok === false. */
  error?: unknown;
};
```

**3c. Hold a `WorkflowExecutor`:**

In `AgentLoop`'s class body, add the field and construct it in the constructor:

```typescript
private readonly executor: WorkflowExecutor;

constructor(opts: AgentLoopOpts) {
  this.opts = opts;
  this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  this.executor = new WorkflowExecutor({ tracer: opts.tracer });
}
```

**3d. Branch in `dispatchTool` for workflow kind**

Replace the body of `dispatchTool` with:

```typescript
private async dispatchTool(name: string, args: unknown, task: Task, depth: number): Promise<ToolResult> {
  const tool = await this.opts.registry.get(name);
  if (!tool) return toolError("unknown_tool", `no tool named '${name}'`);

  if (tool.manifest.kind === TOOL_KIND.workflow) {
    return this.dispatchWorkflowTool(tool, args, task, depth);
  }

  const schema = tool.manifest.inputSchema as Record<string, unknown>;
  const input = coerceStringifiedJsonInput(args, rootJsonSchemaKind(schema));

  const valid = this.ajv.validate(tool.manifest.inputSchema, input);
  if (!valid) return toolError("schema_violation", `input does not match schema: ${this.ajv.errorsText()}`);

  const approval = await this.opts.registry.getApproval(name);
  const decision = await this.opts.approval.checkExecution(tool, input, approval);
  if (decision.decision === APPROVAL_DECISION.reject) {
    this.opts.tracer.log(TRACE_KIND_EXECUTION_DENIED, { name, reason: decision.reason });
    return toolError("rejected_by_user", decision.reason);
  }

  const started = Date.now();
  const result = await this.opts.sandbox.execute(tool, input, decision.token, {
    depth,
    onInvokeTool: (subName, subArgs) => this.dispatchTool(subName, subArgs, task, depth + 1),
  });
  const durationMs = Date.now() - started;
  this.opts.tracer.log(TRACE_KIND_TOOL_INVOKED, { name, duration: durationMs, ok: result.ok });
  this.emitToolInvoked({ name, args: input, ok: result.ok, durationMs, result });
  if (result.ok) task.invokedThisSession.add(name);
  return result;
}

private async dispatchWorkflowTool(tool: Tool, args: unknown, task: Task, depth: number): Promise<ToolResult> {
  const workflow = await this.opts.registry.getWorkflow(tool.manifest.name);
  if (!workflow) return toolError("unknown_tool", `no workflow IR for '${tool.manifest.name}'`);

  const validation = await validateWorkflow(workflow, this.opts.registry);
  if (!validation.ok) {
    return toolError(
      "schema_violation",
      `workflow '${tool.manifest.name}' failed validation: ${validation.errors.map((e) => e.code).join(", ")}`,
    );
  }

  const approval = await this.opts.registry.getApproval(tool.manifest.name);
  const decision = await this.opts.approval.checkExecution(tool, args, approval);
  if (decision.decision === APPROVAL_DECISION.reject) {
    this.opts.tracer.log(TRACE_KIND_EXECUTION_DENIED, { name: tool.manifest.name, reason: decision.reason });
    return toolError("rejected_by_user", decision.reason);
  }

  const started = Date.now();
  const inputs = (args && typeof args === "object" ? (args as Record<string, unknown>) : {});
  const result = await this.executor.run(
    workflow,
    inputs,
    (subName, subArgs, d) => this.dispatchTool(subName, subArgs, task, d),
    depth,
  );
  const durationMs = Date.now() - started;
  this.emitToolInvoked({ name: tool.manifest.name, args: inputs, ok: result.ok, durationMs, result });
  if (result.ok) task.invokedThisSession.add(tool.manifest.name);
  return result;
}

private emitToolInvoked(ev: { name: string; args: unknown; ok: boolean; durationMs: number; result: ToolResult }): void {
  if (!this.opts.onToolInvoked) return;
  const event: ToolInvokedEvent = {
    name: ev.name,
    args: ev.args,
    ok: ev.ok,
    durationMs: ev.durationMs,
    ...(ev.result.ok ? { value: ev.result.value } : { error: ev.result.error }),
  };
  this.opts.onToolInvoked(event);
}
```

**3e. Add the test seam:**

```typescript
/**
 * Test-only seam exposing one-shot dispatch without the LLM. Production
 * call sites should use {@link run}.
 */
async dispatchPublic(name: string, args: unknown): Promise<ToolResult> {
  const task: Task = { findToolCalled: false, invokedThisSession: new Set() };
  return this.dispatchTool(name, args, task, 0);
}
```

- [ ] **Step 4: Run the new test**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/agent/agent-loop.test.ts`
Expected: all tests in this file pass.

- [ ] **Step 5: Run all core tests (regressions)**

Run: `cd packages/core && npm test`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agent/agent-loop.ts packages/core/src/agent/agent-loop.test.ts
git commit -m "feat(agent): dispatch workflow tools via WorkflowExecutor; emit value/error in ToolInvokedEvent"
```

---

## Phase 4 — Factory + remove `createReactive`

### Task 13: `factory.createWorkflow`

**Files:**
- Modify: `packages/core/src/factory/factory.ts`
- Modify: `packages/core/src/factory/factory.test.ts` (add a positive test)

`createWorkflow` does not call the LLM. It receives a slice (already collected by the CLI) and the user-chosen name + description, runs `liftFromTrace`, runs `validate`, presents the draft for Gate-1 approval (reusing the existing approval flow shape), and persists via `registry.saveWorkflow`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/factory/factory.test.ts`:

```typescript
import { liftFromTrace } from "../workflow/lift.ts";
import type { Invocation } from "../workflow/lift.ts";

test("factory: createWorkflow lifts a slice and persists IR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fac-wf-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));

    // Pre-seed an atomic tool the workflow will reference.
    const atomicTool = {
      manifest: {
        name: "echo",
        description: "echoes",
        rationale: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        outputShape: {},
        permissions: { fsRead: [], fsWrite: [], net: "none" as const, netAllowlist: [], env: [] },
        dependencies: [],
        limits: { timeoutMs: 1000, maxOldSpaceSizeMb: 64 },
        hash: "sha256:1",
        createdAt: "2026-01-01T00:00:00.000Z",
        kind: "atomic" as const,
      },
      code: "export async function run(){return 1;}",
    };
    await registry.save(atomicTool, {
      hash: "sha256:1",
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedBy: "test",
      alwaysApprove: true,
    });

    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider();
    const prompter = {
      promptGate1: async () => ({ decision: APPROVAL_DECISION.approve, alwaysApprove: true }),
      promptGate23: async () => ({ decision: APPROVAL_DECISION.approve, alwaysApprove: true }),
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const slice: Invocation[] = [
      { name: "echo", args: { x: 1 }, ok: true, value: 1 },
    ];
    const out = await factory.createWorkflow({
      slice,
      name: "wf-from-trace",
      description: "demo",
      intent: "demo",
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.tool.manifest.kind, "workflow");
    assert.ok(await registry.has("wf-from-trace"));
    const wf = await registry.getWorkflow("wf-from-trace");
    assert.ok(wf);
    assert.equal(wf?.steps.length, 1);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/factory/factory.test.ts`
Expected: FAIL — `factory.createWorkflow` does not exist.

- [ ] **Step 3: Add `createWorkflow` to the factory**

In `packages/core/src/factory/factory.ts`, add the new request type at the top with the others:

```typescript
export type CreateWorkflowReq = {
  slice: import("../workflow/lift.ts").Invocation[];
  name: string;
  description: string;
  intent: string;
};
```

Add the implementation method on `ToolFactory`:

```typescript
async createWorkflow(req: CreateWorkflowReq): Promise<FactoryOutcome> {
  const toolsByName: Record<string, import("../types.ts").Tool> = {};
  for (const summary of this.opts.registry.listSync()) {
    const t = await this.opts.registry.get(summary.name);
    if (t) toolsByName[summary.name] = t;
  }

  const lifted = liftFromTrace({
    slice: req.slice,
    name: req.name,
    description: req.description,
    goal: req.intent,
    toolsByName,
  });
  if (!lifted.ok) {
    this.opts.tracer.log("tool-rejected", { name: req.name, reason: `lift: ${lifted.errors.map((e) => e.code).join("; ")}` });
    return { ok: false, reason: `lift failed: ${lifted.errors.map((e) => `${e.code}: ${e.message}`).join("; ")}` };
  }

  const validation = await validateWorkflow(lifted.workflow, this.opts.registry);
  if (!validation.ok) {
    this.opts.tracer.log("tool-rejected", { name: req.name, reason: `validate: ${validation.errors.map((e) => e.code).join("; ")}` });
    return { ok: false, reason: `workflow validation failed: ${validation.errors.map((e) => e.code).join("; ")}` };
  }

  const tool: import("../types.ts").Tool = { manifest: lifted.manifest, code: "" };
  const draftLike: import("../types.ts").ToolDraft = {
    name: lifted.manifest.name,
    description: lifted.manifest.description,
    rationale: lifted.manifest.rationale,
    inputSchema: lifted.manifest.inputSchema,
    outputShape: lifted.manifest.outputShape,
    permissions: lifted.manifest.permissions,
    code: "",
    dependencies: lifted.manifest.dependencies,
    smokeTestInput: {},
    kind: "workflow",
  };
  const decision = await this.opts.approval.reviewDraft(draftLike, { ok: true, value: null });
  if (decision.decision === APPROVAL_DECISION.reject) {
    this.opts.tracer.log("tool-rejected", { name: req.name, reason: decision.reason });
    return { ok: false, reason: decision.reason };
  }

  const approval: import("../types.ts").ApprovalRecord = {
    hash: lifted.manifest.hash,
    approvedAt: new Date().toISOString(),
    approvedBy: this.approvedBy,
    alwaysApprove: decision.alwaysApprove,
    ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
  };
  await this.opts.registry.saveWorkflow(tool, lifted.workflow, approval);
  this.opts.tracer.log("tool-created", { name: tool.manifest.name, hash: tool.manifest.hash, approvedBy: this.approvedBy });
  return { ok: true, tool, approval };
}
```

Add the import line at the top of `factory.ts`:

```typescript
import { liftFromTrace } from "../workflow/lift.ts";
import { validate as validateWorkflow } from "../workflow/validator.ts";
```

- [ ] **Step 4: Run the new test**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/factory/factory.test.ts`
Expected: existing factory tests + the new createWorkflow test all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/factory/factory.ts packages/core/src/factory/factory.test.ts
git commit -m "feat(factory): createWorkflow lifts trace and persists IR"
```

---

### Task 14: Remove `createReactive`

**Files:**
- Modify: `packages/core/src/factory/factory.ts`
- Modify: `packages/core/src/factory/code-gen-prompts.ts`

The CLI's `compose.ts` is the sole caller (Task 16 will replace its use site). Removing the dead path now ensures the IR truly is the single source of truth.

- [ ] **Step 1: Delete `createReactive` from `factory.ts`**

Remove these from `packages/core/src/factory/factory.ts`:

```typescript
export type CreateReactiveReq = { ... };

async createReactive(req: CreateReactiveReq): Promise<FactoryOutcome> { ... }
```

Also remove the `reactivePrompt` import.

- [ ] **Step 2: Delete `reactivePrompt` from `code-gen-prompts.ts`**

In `packages/core/src/factory/code-gen-prompts.ts`, remove the `reactivePrompt` export (function and any helpers it exclusively uses).

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: errors only in CLI compose.ts (still calls `createReactive`). We'll fix that in Task 16.

- [ ] **Step 4: Run core tests**

Run: `cd packages/core && npm test`
Expected: PASS (all `createReactive` tests should already have been removed when the function was removed; if the existing factory tests reference `createReactive`, delete those test cases now and re-run).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/factory/factory.ts packages/core/src/factory/code-gen-prompts.ts packages/core/src/factory/factory.test.ts
git commit -m "feat(factory): remove createReactive (replaced by createWorkflow)"
```

---

## Phase 5 — CLI compose + e2e

### Task 15: CLI `InvocationRecord` carries `value`/`error`

**Files:**
- Modify: `packages/cli/src/compose.ts` (or wherever `InvocationRecord` is built — currently in `compose.ts` at the type level, but the data is filled in `repl.ts`)

- [ ] **Step 1: Update `InvocationRecord` in `compose.ts`**

Replace the type definition at the top of `packages/cli/src/compose.ts`:

```typescript
export type InvocationRecord = {
  name: string;
  args: unknown;
  ok: boolean;
  /** Present iff ok === true. */
  value?: unknown;
  /** Present iff ok === false. */
  error?: unknown;
};
```

- [ ] **Step 2: Pass `value`/`error` through in `repl.ts`**

In `packages/cli/src/repl.ts`, the existing line is at line 58:

```typescript
onToolInvoked: (ev) => invocations.push({ name: ev.name, args: ev.args, ok: ev.ok }),
```

Replace it with:

```typescript
onToolInvoked: (ev) => {
  const rec: InvocationRecord = { name: ev.name, args: ev.args, ok: ev.ok };
  if ("value" in ev) rec.value = ev.value;
  if ("error" in ev) rec.error = ev.error;
  invocations.push(rec);
},
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/compose.ts packages/cli/src/repl.ts
git commit -m "feat(cli): InvocationRecord carries value/error for IR lift"
```

---

### Task 16: CLI `/compose` uses `createWorkflow` and renders confirmation

**Files:**
- Modify: `packages/cli/src/compose.ts`

- [ ] **Step 1: Rewrite `compose.ts`**

Replace `packages/cli/src/compose.ts` with:

```typescript
import type { ToolFactory, ToolRegistry } from "@meta-agent/core";
import { renderLiterate } from "@meta-agent/core";
import type { ReadlinePromisesInterface } from "./approval-tui.ts";

export type InvocationRecord = {
  name: string;
  args: unknown;
  ok: boolean;
  /** Present iff ok === true. */
  value?: unknown;
  /** Present iff ok === false. */
  error?: unknown;
};

export async function runComposeInteraction(
  factory: ToolFactory,
  registry: ToolRegistry,
  invocations: InvocationRecord[],
  rl: ReadlinePromisesInterface,
): Promise<void> {
  if (invocations.length === 0) {
    console.log("(no tool invocations in this session)");
    return;
  }
  console.log("\nTool calls in this session:");
  invocations.forEach((inv, i) => {
    console.log(`  [${i + 1}] ${inv.name}(${JSON.stringify(inv.args)}) → ${inv.ok ? "ok" : "err"}`);
  });
  const range = (await rl.question("Select a contiguous slice as 'a-b' (or blank to cancel): ")).trim();
  if (!range) return;
  const m = /^(\d+)-(\d+)$/.exec(range);
  if (!m) { console.log("invalid range"); return; }
  const a = parseInt(m[1]!, 10), b = parseInt(m[2]!, 10);
  if (a < 1 || b > invocations.length || a > b) { console.log("out of bounds"); return; }
  const slice = invocations.slice(a - 1, b);

  const name = (await rl.question("Name for the new workflow: ")).trim();
  if (!name) { console.log("cancelled"); return; }
  const intent = (await rl.question("Intent (1-2 sentences): ")).trim();

  const out = await factory.createWorkflow({
    slice: slice.map((s) => ({
      name: s.name,
      args: s.args,
      ok: s.ok,
      value: s.ok ? s.value : undefined,
    })),
    name,
    intent,
    description: intent,
  });

  if (!out.ok) {
    console.log(`rejected: ${out.reason}`);
    return;
  }
  console.log(`created workflow '${out.tool.manifest.name}'`);
  const persisted = await registry.getWorkflow(name);
  if (persisted) {
    console.log("\nLifted workflow:");
    console.log(renderLiterate(persisted));
  }
}
```

The new `registry` parameter requires updating the only call site in `repl.ts`:

```typescript
if (line === "/compose") { await runComposeInteraction(factory, registry, invocations, rl); continue; }
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run CLI tests**

Run: `cd packages/cli && npm test`
Expected: pass (no existing tests touch this file directly; if compose tests exist they need to be updated to remove `createReactive` references).

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/compose.ts packages/cli/src/repl.ts
git commit -m "feat(cli): compose uses createWorkflow for IR-native lift"
```

---

### Task 17: End-to-end round-trip test

**Files:**
- Modify: `packages/core/src/e2e.test.ts`

- [ ] **Step 1: Add the round-trip test**

Append to `packages/core/src/e2e.test.ts`:

```typescript
test("e2e: lift a 2-step trace and execute the resulting workflow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wf-e2e-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));

    // Two atomic tools, manually persisted (we are not exercising tool factory
    // creation here — only the lift + execute round-trip).
    const inc: Tool = {
      manifest: {
        name: "inc",
        description: "increments x",
        rationale: "",
        inputSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false },
        outputShape: {},
        permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
        dependencies: [],
        limits: { timeoutMs: 5000, maxOldSpaceSizeMb: 128 },
        hash: "sha256:i",
        createdAt: "2026-01-01T00:00:00.000Z",
        kind: "atomic",
      },
      code: "export async function run(i){return i.x + 1;}",
    };
    const dbl: Tool = {
      ...inc,
      manifest: {
        ...inc.manifest,
        name: "dbl",
        description: "doubles x",
        inputSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false },
        hash: "sha256:d",
      },
      code: "export async function run(i){return i.x * 2;}",
    };
    const approval = {
      hash: "sha256:0",
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedBy: "test",
      alwaysApprove: true,
    };
    await registry.save(inc, { ...approval, hash: inc.manifest.hash });
    await registry.save(dbl, { ...approval, hash: dbl.manifest.hash });

    // Construct a fake trace: inc(1) → 2; dbl({x:2}) → 4.
    const slice = [
      { name: "inc", args: { x: 1 }, ok: true as const, value: 2 },
      { name: "dbl", args: { x: 2 }, ok: true as const, value: 4 },
    ];

    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider();
    const prompter = {
      promptGate1: async () => ({ decision: APPROVAL_DECISION.approve, alwaysApprove: true }),
      promptGate23: async () => ({ decision: APPROVAL_DECISION.approve, alwaysApprove: true }),
    };
    const approvalPolicy = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval: approvalPolicy, tracer, tombstoned: new Set() });

    const created = await factory.createWorkflow({
      slice, name: "wf-inc-dbl", description: "inc then double", intent: "demo",
    });
    assert.equal(created.ok, true);

    // Now execute the persisted workflow via AgentLoop.dispatchPublic.
    const index = new HybridToolIndex(registry);
    const loop = new AgentLoop({ llm, registry, index, sandbox, approval: approvalPolicy, factory, tracer });
    const result = await loop.dispatchPublic("wf-inc-dbl", {});
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, 4);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

(Imports needed at the top of `e2e.test.ts` — verify they're present: `mkdtemp`, `rm` from `node:fs/promises`, `tmpdir` from `node:os`, `join` from `node:path`, `FsToolRegistry`, `NodePermissionSandbox`, `MockLLMProvider`, `TieredApprovalPolicy`, `APPROVAL_DECISION`, `HybridToolIndex`, `ToolFactory`, `AgentLoop`, `Tracer`, `Tool`. Add any missing.)

- [ ] **Step 2: Run e2e**

Run: `cd packages/core && node --test --experimental-transform-types --no-warnings src/e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Run all tests + typecheck**

Run: `npm run typecheck && (cd packages/core && npm test) && (cd packages/cli && npm test)`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/e2e.test.ts
git commit -m "test(e2e): round-trip lift-then-execute for workflow IR"
```

---

## Self-Review Checklist (run before handoff)

After all 17 tasks land:

- [ ] `npm run typecheck` is clean.
- [ ] `cd packages/core && npm test` is green.
- [ ] `cd packages/cli && npm test` is green.
- [ ] `git status` is clean.
- [ ] `grep -rn "createReactive\|reactivePrompt"` returns no hits in `packages/`.
- [ ] A workflow tool created via `/compose` lives at `./tools/<name>/{manifest.json, workflow.json, approval.json}` (no `tool.ts`).
- [ ] Spec coverage:
  - §4.1 IR types → Task 1
  - §4.4 JSON Schema → Tasks 2, 3
  - §5 Validator → Task 4
  - §6 Executor → Task 5
  - §7 Lift-from-trace → Task 6
  - §8 Renderer → Task 7
  - §9.1 Module barrel → Task 8
  - §4.3 + §9.2 `TOOL_KIND.workflow` + reserved fields → Task 9
  - §9.2 Registry support → Task 10
  - §6.5 Trace events → Tasks 5, 11
  - §6.3 AgentLoop wiring → Task 12
  - §9.2 ToolInvokedEvent extension → Task 12
  - §9.2 `factory.createWorkflow` → Task 13
  - §9.2 Remove `createReactive` → Task 14
  - §9.2 CLI compose updates → Tasks 15, 16
  - §10 e2e test → Task 17

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-07-workflow-ir-lean.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
