/**
 * Workflow IR (LEAN tier).
 *
 * Mirrors the symbolic-indirection model from Meijer's "From Function
 * Frustrations to Framework Flexibility" (Queue 2025) and "Guardians of
 * the Agents" (CACM 2026). 
 * v1 implements tier A: linear ordered tool_call steps with whole-value SymRefs.
 * branch (tier B) and loop (tier C) are typed-but-rejected.
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
