/**
 * Workflow IR (LEAN tier).
 *
 * Mirrors the symbolic-indirection model from Meijer's "From Function
 * Frustrations to Framework Flexibility" (Queue 2025) and "Guardians of
 * the Agents" (CACM 2026).
 * v1 implements tier A: linear ordered tool_call steps with whole-value SymRefs.
 * branch (tier B) and loop (tier C) are typed-but-rejected.
 */

/** Current workflow IR schema version written by the lifter and expected by the validator. */
export const IR_SCHEMA_VERSION = 1 as const;

/** Literal type of {@link IR_SCHEMA_VERSION}. */
export type IrSchemaVersion = typeof IR_SCHEMA_VERSION;

/**
 * Step-kind catalog.
 *
 * `branch` and `loop` are reserved for future tiers and rejected by the v1 parser.
 */
export const STEP_KIND = {
  tool_call: "tool_call",
  // Reserved for tier B (parser rejects in v1):
  branch: "branch",
  // Reserved for tier C (parser rejects in v1):
  loop: "loop",
} as const;

/** Union of {@link STEP_KIND} values. */
export type StepKind = (typeof STEP_KIND)[keyof typeof STEP_KIND];

/** Argument-kind catalog for step tool arguments. */
export const ARG_KIND = {
  literal: "literal",
  symref: "symref",
} as const;

/** Union of {@link ARG_KIND} values. */
export type ArgKind = (typeof ARG_KIND)[keyof typeof ARG_KIND];

/**
 * A constant argument value embedded directly in the workflow IR.
 *
 * @property kind - Always {@link ARG_KIND.literal}.
 * @property value - JSON-compatible value passed to the tool at execution time.
 */
export type Literal = {
  kind: typeof ARG_KIND.literal;
  value: unknown;
};

/**
 * A symbolic reference to a prior binding (workflow input or step result).
 *
 * @property kind - Always {@link ARG_KIND.symref}.
 * @property ref - Binding name in scope at this step (input `name` or prior `resultBinding`).
 * @property path - (Optional) Single top-level key to project from the referenced value.
 */
export type SymRef = {
  kind: typeof ARG_KIND.symref;
  ref: string;
  path?: string;
};

/** A tool argument: either an inline {@link Literal} or a {@link SymRef} to in-scope data. */
export type Argument = Literal | SymRef;

/**
 * A single ordered tool invocation step (tier A).
 *
 * @property kind - Always {@link STEP_KIND.tool_call}.
 * @property label - Unique step identifier used in promotions, errors, and rendering.
 * @property tool - Registered tool name to invoke.
 * @property arguments - Named arguments, each a {@link Literal} or {@link SymRef}.
 * @property resultBinding - Binding name for this step's output, or `null` when the result is discarded.
 */
export type ToolCallStep = {
  kind: typeof STEP_KIND.tool_call;
  label: string;
  tool: string;
  arguments: Record<string, Argument>;
  resultBinding: string | null;
};

/**
 * A workflow step. v1: only {@link ToolCallStep}.
 *
 * Tier B will widen to `ToolCallStep | BranchStep`.
 */
export type Step = ToolCallStep;

/**
 * A declared workflow parameter.
 *
 * In scope as a binding from step 0, so a {@link SymRef} may target its `name`.
 * Created by promoting a lifted literal during workflow composition.
 *
 * @property name - Identifier-safe parameter name; unique; must not collide with a step `resultBinding`.
 * @property schema - Inferred JSON Schema fragment (e.g. `{ type: "string" }`).
 * @property required - Whether the caller must supply this input at invocation time.
 * @property default - (Optional) Default value when `required` is `false` (the original lifted literal).
 * @property description - (Optional) Human-readable parameter description.
 */
export type WorkflowInput = {
  name: string;
  schema: Record<string, unknown>;
  required: boolean;
  default?: unknown;
  description?: string;
};

/**
 * How the workflow selects its final return value.
 *
 * `null` when the last step's result is implicitly returned; otherwise a {@link SymRef}
 * pointing at the bound value to expose to the caller.
 */
export type WorkflowReturn = { source: SymRef } | null;

/**
 * Persisted workflow intermediate representation.
 *
 * @property schemaVersion - IR version; must match {@link IR_SCHEMA_VERSION} for v1 tooling.
 * @property name - Workflow tool name (matches the promoted tool manifest).
 * @property description - Human-readable summary of what the workflow does.
 * @property goal - Short intent statement (1–2 sentences) from the composer.
 * @property inputs - Declared parameters; `[]` for a closed (non-parameterized) workflow.
 * @property steps - Ordered {@link Step} list executed sequentially.
 * @property return - Explicit return selector, or `null` to use the last step's output.
 */
export type Workflow = {
  schemaVersion: IrSchemaVersion;
  name: string;
  description: string;
  goal: string;
  inputs: WorkflowInput[];
  steps: Step[];
  return: WorkflowReturn;
};
