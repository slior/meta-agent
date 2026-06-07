import { META_TOOL_NAMES } from "../agent/meta-tools.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";
import { KNOWN_TOOL_CAPABILITIES } from "../types.ts";
import { IR_SCHEMA_VERSION, STEP_KIND, ARG_KIND, type Argument, type Step, type Workflow } from "./types.ts";

export type ValidationError = {
  code: string;
  message: string;
  stepLabel?: string;
  pointer?: string;
};

export type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] };

const BINDING_NAME = /^[a-z_][a-z0-9_]*$/i;

function pushValidationError(
  errors: ValidationError[],
  code: string,
  message: string,
  extra?: Pick<ValidationError, "stepLabel" | "pointer">,
): void {
  errors.push({ code, message, ...extra });
}

function pushStepValidationError(
  errors: ValidationError[],
  step: Step,
  pointer: string,
  code: string,
  message: string,
): void {
  pushValidationError(errors, code, message, { stepLabel: step.label, pointer });
}

/**
 * Validates a Workflow object against a set of structural, semantic, and registry-driven constraints.
 *
 * This function checks:
 *   - Workflow schema version compatibility.
 *   - Input declarations: valid names, uniqueness, no collision with step result bindings,
 *       optional inputs have a default, schemas are objects.
 *   - Step structure, including:
 *       - Only supported step kinds are allowed (`tool_call` in v1).
 *       - Step labels are unique.
 *       - Result binding names are valid and unique.
 *       - No use of reserved meta-tools as steps.
 *       - Each tool used is present in the registry.
 *       - Symref arguments only reference valid, previously bound names.
 *       - SymRef.path is not used (reserved for future tiers).
 *       - Arguments match inputSchema requirements for each tool.
 *   - The workflow return (if present) references a bound result name.
 *
 * Errors found are collected and returned; if none, returns `{ ok: true }`.
 *
 * @param workflow - The Workflow object to validate.
 * @param registry - The ToolRegistry to resolve tool existence and manifest info.
 * @returns {Promise<ValidationResult>} Promise resolving to validation result: `{ ok: true }` or `{ ok: false, errors }`.
 */
export async function validate(workflow: Workflow, registry: ToolRegistry): Promise<ValidationResult> {
  const errors: ValidationError[] = [];

  if (workflow.schemaVersion !== IR_SCHEMA_VERSION) {
    pushValidationError(errors, "unsupported_schema_version", `expected schemaVersion ${IR_SCHEMA_VERSION}, got ${workflow.schemaVersion}`, {
      pointer: "/schemaVersion",
    });
  }

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
    // Inputs are in scope from step 0 (only seed valid names to avoid polluting scope).
    // Exclude names that collide with a resultBinding — those already generate `input_binding_collision`
    // and must not enter `bindings`, which would produce a spurious `duplicate_binding` from the step loop.
    if (BINDING_NAME.test(inp.name) && !resultBindings.has(inp.name)) bindings.add(inp.name);
  }

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i]!;
    const stepPtr = `/steps/${i}`;

    if (step.kind !== STEP_KIND.tool_call) {
      pushStepValidationError(
        errors, step,
        stepPtr, "step_kind_not_supported_in_v1",
        `step kind '${(step as Step).kind}' is reserved for a future tier`,
      );
      continue;
    }

    if (seenLabels.has(step.label)) {
      pushStepValidationError(errors, step, `${stepPtr}/label`, "duplicate_step_label", `step label '${step.label}' is not unique`);
    }
    seenLabels.add(step.label);

    if (step.resultBinding !== null) {
      if (!BINDING_NAME.test(step.resultBinding)) {
        pushStepValidationError(
          errors, 
          step, `${stepPtr}/resultBinding`,
          "invalid_binding_name", `binding '${step.resultBinding}' must match /^[a-z_][a-z0-9_]*$/i`,
        );
      }
      if (bindings.has(step.resultBinding)) {
        pushStepValidationError(
          errors,
          step, `${stepPtr}/resultBinding`,
          "duplicate_binding", `binding '${step.resultBinding}' is not unique`,
        );
      }
    }

    if (META_TOOL_NAMES.has(step.tool)) {
      pushStepValidationError(
        errors,
        step, `${stepPtr}/tool`,
        "meta_tool_not_callable_from_workflow", `meta-tool '${step.tool}' may not be called from a workflow`,
      );
    }

    const callee = await registry.get(step.tool);
    if (!callee && !META_TOOL_NAMES.has(step.tool)) {
      pushStepValidationError(errors, step, `${stepPtr}/tool`, "unknown_tool", `tool '${step.tool}' is not in the registry`);
    }

    if (callee?.manifest.capabilities) {
      for (const cap of callee.manifest.capabilities) {
        if (!KNOWN_TOOL_CAPABILITIES.has(cap)) {
          pushStepValidationError(
            errors, step, `${stepPtr}/tool`,
            "unknown_capability", `tool '${step.tool}' declares unknown capability '${cap}'`,
          );
        }
      }
    }

    for (const [argName, arg] of Object.entries(step.arguments)) {
      if (arg.kind === ARG_KIND.symref) {
        validateSymRefArgument(errors, step, argName, arg, `${stepPtr}/arguments/${argName}`, bindings);
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
      pushValidationError(
        errors,
        "unbound_return",
        `workflow return references unbound name '${workflow.return.source.ref}'`,
        { pointer: "/return/source/ref" },
      );
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

type SymRefArgument = Extract<Argument, { kind: typeof ARG_KIND.symref }>;

/**
 * Validates a symref step argument: ref must name a prior step binding;
 * `path` is rejected in v1 (reserved for tier B).
 */
function validateSymRefArgument(
  errors: ValidationError[],
  step: Step, argName: string,
  arg: SymRefArgument, argPtr: string,
  bindings: ReadonlySet<string>, ): void {
  if (!bindings.has(arg.ref)) {
    pushStepValidationError(
      errors,
      step, argPtr,
      "unbound_symref", `argument '${argName}' references unbound name '${arg.ref}'`,
    );
  }
  if ((arg as Argument & { path?: unknown }).path !== undefined) {
    pushStepValidationError(errors, step, argPtr, "symref_path_not_supported_in_v1", "SymRef.path is reserved for tier B");
  }
}

/**
 * Checks a step's provided argument keys against the argument schema.
 *
 * - Reports a validation error for each argument required by the schema but not provided in the step.
 * - If the schema does not allow additional properties (additionalProperties: false), reports a validation
 *   error for each provided argument that is not listed in the schema's properties.
 *
 * @param step The step whose arguments are being validated.
 * @param schema A JSON schema fragment (object) representing expected argument properties and requirements.
 * @param errors The array to which validation errors will be pushed.
 * @param stepPtr The JSON pointer string referencing the current step location in the workflow.
 */
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
      pushStepValidationError(
        errors,
        step,
        `${stepPtr}/arguments`,
        "missing_required_arg",
        `step '${step.label}' is missing required argument '${r}'`,
      );
    }
  }

  if (additional === false) {
    for (const k of provided) {
      if (!(k in properties)) {
        pushStepValidationError(
          errors,
          step,
          `${stepPtr}/arguments/${k}`,
          "unknown_arg",
          `step '${step.label}' has unknown argument '${k}' (additionalProperties:false)`,
        );
      }
    }
  }
}
