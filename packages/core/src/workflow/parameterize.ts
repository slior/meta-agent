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
