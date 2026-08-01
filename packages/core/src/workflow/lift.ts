import { createHash } from "node:crypto";
import { isRefSentinel } from "../agent/result-store.ts";
import { canonicalJson } from "../hash.ts";
import { normalizePermissions, unionPermissions } from "../permissions-normalize.ts";
import { TOOL_KIND, type ToolManifest } from "../types.ts";
import type { Tool } from "../tool.ts";
import { IR_SCHEMA_VERSION, STEP_KIND, ARG_KIND, type Argument, type ToolCallStep, type Workflow, type WorkflowInput } from "./types.ts";

/**
 * Represents a single tool invocation within a trace slice, as used by the workflow lifting process.
 *
 * @property name - The name of the tool that was invoked.
 * @property args - The arguments provided to the tool invocation (arbitrary, tool-defined shape).
 * @property ok - Whether the tool call succeeded (true) or failed (false).
 * @property value - The tool's returned value, present only if {@link ok} === true.
 */
export type Invocation = {
  name: string;
  args: unknown;
  ok: boolean;
  /** Present iff ok === true. */
  value: unknown;
  /** Runtime result-binding id assigned when the invocation ran (used to translate `$ref`s). */
  binding?: string;
};

/**
 * Represents a request to lift a workflow definition from a sequence of tool invocations.
 *
 * @property slice - An ordered array of tool invocation records representing a linear trace (only successful invocations should be present).
 * @property name - Proposed name for the resulting workflow/tool (used in generated manifest metadata).
 * @property description - A user-facing description of what the composed tool/workflow does.
 * @property goal - A high-level statement of the intended outcome or purpose of the workflow, for documentation or validation.
 * @property toolsByName - A mapping of tool names to tool definitions, representing the tool registry as seen by the caller at lift time.
 */
export type LiftRequest = {
  slice: Invocation[];
  name: string;
  description: string;
  goal: string;
  /** Snapshot of tools by name (caller's registry view). */
  toolsByName: Record<string, Tool>;
};

/** Structured failure from {@link liftFromTrace} (empty slice, unknown tool, etc.). */
export type LiftError = { code: string; message: string };

/**
 * An argument that could not be bound to a prior step output and was inlined as a literal.
 */
export type LiteralFallback = {
  stepLabel: string;
  argName: string;
  /** canonicalJson of the literal value, for UX surfacing. */
  canonicalValue: string;
};

/** Result of converting trace invocations into workflow steps. */
type LiftedStepsResult = {
  steps: ToolCallStep[];
  literalFallbacks: LiteralFallback[];
  errors: LiftError[];
};

/**
 * The result type returned by the workflow lifting process.
 *
 * - If lifting succeeds (`ok: true`):
 *   - `workflow`: The composed Workflow object representing the lifted sequence.
 *   - `manifest`: The generated ToolManifest (with hash and creation time included).
 *   - `literalFallbacks`: An array of LiteralFallbacks, each indicating an argument in the trace that could not be traced to a previous step and was inserted as a literal value.
 * - If lifting fails (`ok: false`):
 *   - `errors`: An array of LiftError objects describing one or more problems encountered during lifting (e.g., empty trace, unknown tool).
 */
export type LiftResult =
  | {
      ok: true;
      workflow: Workflow;
      manifest: Omit<ToolManifest, "hash" | "createdAt"> & { hash: string; createdAt: string };
      literalFallbacks: LiteralFallback[];
    }
  | { ok: false; errors: LiftError[] };

/** Tool names may be kebab-case; bindings must match validator `BINDING_NAME` (no hyphens). */
const SAFE_NAME = /[^a-z0-9_]/gi;

/**
 * Derives the workflow's `outputShape` from the last step's tool manifest.
 * Returns `{}` when there are no steps, when the last step discards its result
 * (`resultBinding === null`), or when the last step's tool is not found in `toolsByName`.
 *
 * @param steps - The computed `ToolCallStep[]` for the workflow being lifted.
 * @param toolsByName - Registry snapshot keyed by tool name.
 * @returns An object-form JSON Schema for the workflow's output contract.
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

function sanitize(name: string): string {
  return name.replace(SAFE_NAME, "_").toLowerCase();
}

/**
 * Lifts a linear trace of successful tool invocations into a composable workflow definition,
 * producing both the workflow IR and a manifest describing the resulting workflow/tool.
 *
 * The function examines a given ordered slice of tool invocation records and reconstructs
 * a Workflow that captures the sequence, argument bindings, and dependencies. Arguments that
 * can be linked to previous step outputs are represented as symbolic references; otherwise,
 * they are inlined as literal values, with such cases reported in the returned `literalFallbacks`
 * array for potential UX surfacing or prompting.
 *
 * Validation is performed on input: the trace must not be empty and all referenced tools must
 * exist in the provided registry snapshot. If these checks fail, the function returns a failure
 * result containing error codes and messages.
 *
 * The output includes:
 *   - The composed Workflow object.
 *   - The generated manifest, including hash and creation time.
 *   - An array of literal fallback explanations for any arguments that could not be traced to
 *     a previous output.
 *   - Or, if lifting fails, a list of error objects explaining the reason(s) for failure.
 *
 * @param req - The lifting request, containing a trace of tool invocations, metadata, and the tool registry snapshot.
 * @returns A result object: on success, the lifted Workflow, manifest, and any literal fallbacks;
 *          on failure, errors explaining why lifting could not proceed.
 */
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

  const { steps, literalFallbacks, errors } = liftStepsFromInvocations(successes);
  if (errors.length > 0) return { ok: false, errors };

  const lastBinding = steps[steps.length - 1]!.resultBinding;
  const workflow: Workflow = {
    schemaVersion: IR_SCHEMA_VERSION, name: req.name,
    description: req.description, goal: req.goal,
    inputs: [], steps,
    return: lastBinding === null ? null : { source: { kind: ARG_KIND.symref, ref: lastBinding } },
  };

  const dependencies = Array.from(new Set(steps.map((s) => s.tool))).sort();
  const permissions = unionPermissions(dependencies.map((d) => req.toolsByName[d]!.manifest.permissions));

  const manifest: Omit<ToolManifest, "hash"> = {
    name: req.name, description: req.description,
    rationale: req.goal, inputSchema: {},
    outputShape: deriveWorkflowOutputShape(steps, req.toolsByName), permissions,
    dependencies, limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    createdAt: new Date().toISOString(), kind: TOOL_KIND.WORKFLOW,
  };

  const hash = "sha256:" + simpleHash(canonicalJson(workflow) + "\n" + canonicalJson(manifest));
  const fullManifest = { ...manifest, hash };

  return { ok: true, workflow, manifest: fullManifest, literalFallbacks };
}

/**
 * Converts an ordered list of successful invocations into workflow `tool_call` steps.
 *
 * Walks the trace in order, lifting each step's arguments via {@link liftStepArguments}
 * (SymRefs where an arg matches a prior step's whole output, literals otherwise).
 * Each step's return value is registered internally so later steps can reference it.
 *
 * @param successes - Successful invocations from the trace slice, in execution order.
 *
 * @returns {@link LiftedStepsResult} with lifted steps and any literal fallback records.
 */
function liftStepsFromInvocations(successes: Invocation[]): LiftedStepsResult {
  const steps: ToolCallStep[] = [];
  const bindingByValue = new Map<string, string>();
  const runtimeToLocal = new Map<string, string>();
  const literalFallbacks: LiteralFallback[] = [];
  const errors: LiftError[] = [];

  for (let i = 0; i < successes.length; i++) {
    const inv = successes[i]!;
    const safe = sanitize(inv.name);
    const label = `step_${i}_${safe}`;
    const binding = `r_${i}_${safe}`;
    // Map the runtime binding (what the agent referenced) to this slice-local binding.
    runtimeToLocal.set(inv.binding ?? binding, binding);

    const args = liftStepArguments(inv.args, bindingByValue, runtimeToLocal, label, literalFallbacks, errors);

    steps.push({ kind: STEP_KIND.tool_call, label, tool: inv.name, arguments: args, resultBinding: binding, });

    const ck = canonicalJson(inv.value);
    if (!bindingByValue.has(ck)) bindingByValue.set(ck, binding);
  }

  return { steps, literalFallbacks, errors };
}

/**
 * Lifts a step's runtime arguments into workflow IR arguments.
 *
 * Each argument value is compared (via {@link canonicalJson}) against prior step outputs
 * registered in `bindingByValue`. A match becomes a SymRef to that step's result binding;
 * otherwise the value is kept as a literal and recorded in `literalFallbacks` for UX surfacing.
 *
 * @param rawArgs - The invocation's argument object from the trace slice.
 * @param bindingByValue - Map from canonical JSON of prior step outputs to their result bindings.
 * @param stepLabel - Label of the step being lifted (used in literal fallback records).
 * @param literalFallbacks - Mutable accumulator for arguments that could not be linked to a prior output.
 *
 * @returns Workflow IR arguments keyed by argument name.
 */
function liftStepArguments(
  rawArgs: unknown,
  bindingByValue: ReadonlyMap<string, string>,
  runtimeToLocal: ReadonlyMap<string, string>,
  stepLabel: string,
  literalFallbacks: LiteralFallback[],
  errors: LiftError[],
): Record<string, Argument> {
  const args: Record<string, Argument> = {};
  for (const [k, v] of Object.entries((rawArgs ?? {}) as Record<string, unknown>)) {
    if (isRefSentinel(v)) {
      const local = runtimeToLocal.get(v.$ref);
      if (local === undefined) {
        errors.push({ code: "ref_out_of_slice", message: `step '${stepLabel}' argument '${k}' references '${v.$ref}', which is before the selected slice; widen the slice` });
        // Emit a placeholder symref so step shape is well-formed; the error aborts the lift anyway.
        args[k] = { kind: ARG_KIND.symref, ref: v.$ref, ...(v.path !== undefined ? { path: v.path } : {}) };
        continue;
      }
      args[k] = { kind: ARG_KIND.symref, ref: local, ...(v.path !== undefined ? { path: v.path } : {}) };
      continue;
    }
    const ck = canonicalJson(v);
    const hit = bindingByValue.get(ck);
    if (hit !== undefined) {
      args[k] = { kind: ARG_KIND.symref, ref: hit };
    } else {
      args[k] = { kind: ARG_KIND.literal, value: v };
      literalFallbacks.push({ stepLabel, argName: k, canonicalValue: ck });
    }
  }
  return args;
}

function simpleHash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Projects declared workflow inputs into a JSON Schema for the manifest's
 * `inputSchema`. Empty inputs project to `{}` (a closed workflow). Defaults and
 * descriptions are advertised for the LLM; defaults are applied by the executor.
 *
 * @param inputs - Declared workflow inputs from the lifted IR.
 * @returns Object-form JSON Schema suitable for `ToolManifest.inputSchema`.
 */
export function inputSchemaFromInputs(inputs: WorkflowInput[]): Record<string, unknown> {
  if (inputs.length === 0) return {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const inp of inputs) {
    properties[inp.name] = {
      ...inp.schema,
      ...("description" in inp ? { description: inp.description } : {}),
      ...("default" in inp ? { default: inp.default } : {}),
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
