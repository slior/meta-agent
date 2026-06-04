import type { Tracer } from "../tracer.ts";
import type { ToolResult } from "../types.ts";
import { ARG_KIND, type Argument, type ToolCallStep, type Workflow } from "./types.ts";

/** Logged when a workflow run begins. */
export const TRACE_KIND_WORKFLOW_START = "workflow-start" as const;
/** Logged before each step's underlying tool dispatch. */
export const TRACE_KIND_WORKFLOW_STEP_START = "workflow-step-start" as const;
/** Logged after each step's underlying tool dispatch. */
export const TRACE_KIND_WORKFLOW_STEP_END = "workflow-step-end" as const;
/** Logged when a workflow run completes (success or failure). */
export const TRACE_KIND_WORKFLOW_END = "workflow-end" as const;

/**
 * A function that dispatches a tool call during workflow execution.
 *
 * @param name - The name of the tool to invoke.
 * @param args - The input arguments to pass to the tool.
 * @param depth - The recursion depth of the tool call within the workflow.
 * @returns A Promise that resolves to a ToolResult.
 */
export type DispatchTool = (
  name: string,
  args: unknown,
  depth: number,
) => Promise<ToolResult>;

export type WorkflowExecutorOpts = { tracer: Tracer };

/**
 * Executes a workflow definition by sequentially invoking its steps as tool calls.
 *
 * The WorkflowExecutor manages input resolution, tracks execution status via a tracer,
 * binds intermediate values in an environment, and returns either a success result with
 * the workflow's output or a failure if any step fails or is misconfigured.
 *
 * Usage:
 *   - Instantiate with workflow execution options (e.g., tracer).
 *   - Call the `run` method with:
 *       - the workflow definition,
 *       - runtime inputs (values for declared workflow inputs),
 *       - a function to dispatch tool calls,
 *       - the current recursion depth.
 *
 * Tracing:
 *   - Emits start, step, and end trace events via the provided tracer for observability.
 *
 * Error Handling:
 *   - Fails fast if a required input is missing from runtimeInputs.
 *   - Returns failure if arguments to steps are unbound or any underlying tool fails.
 *
 * Environment/Caching:
 *   - Tracks values of step results for reference by subsequent workflow steps.
 */
export class WorkflowExecutor {
  /**
   * @param opts - Workflow execution options (must include a tracer).
   */
  constructor(private readonly opts: WorkflowExecutorOpts) {}

  /**
   * Runs a workflow to completion by executing each step in sequence.
   *
   * @param workflow - The workflow definition to execute.
   * @param runtimeInputs - Input values for declared workflow parameters.
   * @param dispatchTool - Function to invoke each tool required by workflow steps.
   * @param depth - The current tool-call nesting or recursion depth.
   *
   * @returns A Promise that resolves to the workflow's final ToolResult.
   */
  async run(workflow: Workflow, runtimeInputs: Record<string, unknown>, dispatchTool: DispatchTool, depth: number): Promise<ToolResult> {
    const env = new Map<string, unknown>();
    for (const input of workflow.inputs) {
      if (Object.prototype.hasOwnProperty.call(runtimeInputs, input.name)) {
        env.set(input.name, runtimeInputs[input.name]);
      } else if (input.required === false) {
        env.set(input.name, input.default);
      } else {
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
    const startedAt = Date.now();
    this.opts.tracer.log(TRACE_KIND_WORKFLOW_START, { name: workflow.name, depth });

    for (const step of workflow.steps) {
      const failure = await this.executeToolCallStep(step, env, workflow, startedAt, dispatchTool, depth);
      if (failure !== null) return failure;
    }

    this.opts.tracer.log(TRACE_KIND_WORKFLOW_END, {
      name: workflow.name,
      ok: true,
      durationMs: Date.now() - startedAt,
    });

    if (workflow.return === null) return { ok: true, value: null };
    return { ok: true, value: env.get(workflow.return.source.ref) };
  }

  /**
   * Runs a single `tool_call` step: resolves arguments, dispatches the underlying tool,
   * and binds the result into the workflow environment on success.
   *
   * Emits step start/end trace events. On failure (unbound symref or tool error), logs
   * workflow-end and returns a terminal failure result for the whole workflow run.
   *
   * @param step - The tool-call step to execute.
   * @param env - Mutable environment of bound step results for SymRef resolution.
   * @param workflow - The enclosing workflow (used for error context and tracing).
   * @param startedAt - Timestamp when the workflow run began (for end-trace duration).
   * @param dispatchTool - Callback to invoke the step's underlying tool.
   * @param depth - Current tool-call nesting depth (incremented for the dispatch).
   *
   * @returns `null` if the step succeeded and `env` was updated; otherwise a failed
   *   `ToolResult` that terminates the workflow run.
   */
  private async executeToolCallStep( step: ToolCallStep, env: Map<string, unknown>, workflow: Workflow,
                                     startedAt: number, dispatchTool: DispatchTool, depth: number, ): Promise<ToolResult | null> 
  {
    const resolved: Record<string, unknown> = {};
    for (const [argName, arg] of Object.entries(step.arguments)) {
      const value = resolveArgument(arg, env);
      if (!value.bound) {
        return this.endWithFailure(workflow, startedAt, {
          ok: false,
          error: {
            kind: "schema_violation",
            message: `unbound symref '${arg.kind === ARG_KIND.symref ? arg.ref : ""}' at step '${step.label}'`,
            details: { code: "unbound_symref_runtime", workflow: workflow.name, failedStep: step.label },
          },
        });
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
      return this.endWithFailure(workflow, startedAt, {
        ok: false,
        error: {
          ...result.error,
          details: { ...(typeof result.error.details === "object" && result.error.details ? result.error.details : {}), workflow: workflow.name, failedStep: step.label },
        },
      });
    }

    if (step.resultBinding !== null) env.set(step.resultBinding, result.value);
    return null;
  }

  private endWithFailure(workflow: Workflow, startedAt: number, failure: Extract<ToolResult, { ok: false }>): ToolResult {
    this.opts.tracer.log(TRACE_KIND_WORKFLOW_END, {
      name: workflow.name,
      ok: false,
      durationMs: Date.now() - startedAt,
    });
    return failure;
  }
}

function resolveArgument(arg: Argument, env: ReadonlyMap<string, unknown>): { bound: true; value: unknown } | { bound: false } {
  if (arg.kind === ARG_KIND.literal) return { bound: true, value: arg.value };
  if (!env.has(arg.ref)) return { bound: false };
  return { bound: true, value: env.get(arg.ref) };
}
