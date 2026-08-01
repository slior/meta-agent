import Ajv from "ajv";
import { APPROVAL_DECISION, type ApprovalPolicy } from "../approval/interface.ts";
import {
  CHAT_ROLE,
  CHAT_TOOL_CHOICE,
  CHAT_TOOL_TYPE,
  type ChatMessage,
  type LLMProvider,
  type ToolCall,
  type ToolDef,
} from "../llm/LLMProvider.ts";
import type { LlmCapabilityRequest } from "../sandbox/sandbox.ts";
import { PolicyEnforcedSandbox } from "../sandbox/policy-enforced-sandbox.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";
import type { ToolIndex } from "../index-store/interface.ts";
import { TOOL_CAPABILITY, TOOL_ERROR_KIND, TOOL_KIND, type ToolResult } from "../types.ts";
import type { Tool } from "../tool.ts";
import {
  TRACE_KIND_EXECUTION_DENIED,
  TRACE_KIND_LLM_SYNTHESIS,
  TRACE_KIND_LLM_SYNTHESIS_START,
  TRACE_KIND_LLM_TURN,
  TRACE_KIND_LLM_TURN_START,
  LLM_TRACE_PHASE,
  TRACE_KIND_TOOL_CALL,
  TRACE_KIND_TOOL_DISPATCH_START,
  TRACE_KIND_TOOL_INVOKED,
  type Tracer,
} from "../tracer.ts";
import { ResultStore, describeForModel, resolveRefs, sanitizeBinding } from "./result-store.ts";
import { validateToolOutput } from "./validate-tool-output.ts";
import { coerceStringifiedJsonInput, rootJsonSchemaKind } from "./coerce-tool-input.ts";
import { renderSystemPrompt } from "./system-prompt.ts";
import { FIND_TOOL_TOP_K, META_FN, META_TOOL_DEFS, META_TOOL_NAMES } from "./meta-tools.ts";
import { ToolFactory } from "../factory/factory.ts";
import { toolError } from "../errors.ts";
import { WorkflowExecutor } from "../workflow/executor.ts";

/** Default maximum LLM turns when {@link AgentLoopOpts.maxTurns} is omitted. */
const DEFAULT_MAX_TURNS = 20;

/** Max characters for one-line tool descriptions in the system prompt catalog. */
const CATALOG_DESCRIPTION_PREVIEW_MAX = 80;

/** Default stop reason string when the model omits or sends blank `reason`. */
const DEFAULT_SOLO_STOP_REASON = "stopped";

/** System prompt for the mediated llm_generate capability: the model is a pure data transformer. */
const LLM_GENERATE_SYSTEM =
  "You transform the given INPUT according to the INSTRUCTIONS and return only the result. " +
  "Do not ask questions, do not call tools, do not add commentary.";

/** Renders the user message for an llm capability request. */
function renderLlmInstruction(instructions: string, input: unknown): string {
  const rendered = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  return `${instructions}\n\n--- INPUT ---\n${rendered}`;
}

const FINAL_SYNTHESIS_SYSTEM = `You are the final answer step for a meta-agent. The conversation above includes the user's request and tool results (JSON in assistant/tool messages).
Write a concise reply for the user in plain language. Use concrete numbers, paths, and facts from tool results when present. Do not call tools or invent data not supported by the transcript.`;

/** Injected as a synthetic user line after a batch where invoke_tool failed; exported for tests. */
export const INVOKE_FAILURE_RECOVERY_USER =
  `${META_FN.invokeTool}_recovery_hint: A previous ${META_FN.invokeTool} call in this turn failed or was rejected. ` +
  `Your next step must use meta-tools: try ${META_FN.findTool} with a better query, ${META_FN.listTools}, or ${META_FN.proposeNewTool} / ${META_FN.proposeCompositeTool} if no tool fits. ` +
  "Do not end with only an apology unless you have genuinely exhausted these options.";

/** Injected after a batch where find_tool succeeded with no matches; exported for tests. */
export const EMPTY_FIND_RECOVERY_USER =
  `${META_FN.findTool}_empty_recovery_hint: A ${META_FN.findTool} call in this batch returned ok: true with an empty value (no ranked hits). ` +
  `That means no registry tool matched — it is not an error. Next use ${META_FN.proposeNewTool} or ${META_FN.proposeCompositeTool}, or ${META_FN.listTools} if you need the full catalog; you may try ${META_FN.findTool} again with a sharper query. ` +
  "Do not answer with only prose unless you have genuinely exhausted these options.";

/**
 * Represents a record of a tool invocation, including its arguments, outcome, and metadata.
 *
 * @property name - The name of the tool that was invoked.
 * @property args - The input arguments provided to the tool.
 * @property ok - Whether the invocation was successful (true) or resulted in an error (false).
 * @property durationMs - The time taken in milliseconds to complete the tool invocation.
 * @property value - (Optional) The returned value from the tool if the invocation was successful.
 * @property binding - (Optional) A variable binding name associated with the result for reference by the agent.
 */
export type ToolInvokedEvent = {
  name: string;
  args: unknown;
  ok: boolean;
  durationMs: number;
  value?: unknown;
  binding?: string;
};

/**
 * Options for constructing an {@link AgentLoop}.
 *
 * @property {LLMProvider} llm - The language model provider used for message generation.
 * @property {ToolRegistry} registry - Registry for tool lookup and metadata.
 * @property {ToolIndex} index - Tool search/indexing system, used for find_tool operations.
 * @property {PolicyEnforcedSandbox} sandbox - Policy-enforced sandbox for tool execution (Gate 2/3 checked before spawn).
 * @property {ApprovalPolicy} approval - Approval policy for gating tool executions.
 * @property {ToolFactory} factory - Factory used for proposing and constructing new tools.
 * @property {Tracer} tracer - Tracer for logging agent loop events and debugging.
 * @property {number} [maxTurns] - Optional maximum number of LLM turns before agent termination (default: {@link DEFAULT_MAX_TURNS}).
 * @property {(ev: ToolInvokedEvent) => void} [onToolInvoked] - Optional callback triggered after each tool invocation, receives invocation details.
 */
export type AgentLoopOpts = {
  llm: LLMProvider;
  registry: ToolRegistry;
  index: ToolIndex;
  /** Must be a {@link PolicyEnforcedSandbox}; ensures approval policy is in the execution path. */
  sandbox: PolicyEnforcedSandbox;
  approval: ApprovalPolicy;
  factory: ToolFactory;
  tracer: Tracer;
  maxTurns?: number;
  onToolInvoked?: (ev: ToolInvokedEvent) => void;
};

/**
 * Tracks per-run state of an AgentLoop.
 *
 * @property {boolean} findToolCalled - Indicates whether `find_tool` has been called during this run.
 * @property {Set<string>} invokedThisSession - Set of tool names that have been invoked in the current session.
 */
type Task = {
  findToolCalled: boolean;
  invokedThisSession: Set<string>;
};

/**
 * AgentLoop manages a single interactive agent session, orchestrating LLM turns, tool selection, invocation,
 * and dynamic toolset updates based on agent actions. It mediates between the user, the language model, and
 * the tool registry, supporting multi-turn task execution with adaptive tool proposals and recovery guidance.
 *
 * ## Responsibilities:
 * - Presents a dynamic set of available tools to the language model each turn.
 * - Handles model tool requests, including standard and meta-tools (e.g., find_tool, propose_new_tool).
 * - Invokes tools securely in a sandboxed environment, performing input validation and approval checks.
 * - Logs all tool invocations, rejections, and batch-level context for tracing/debugging/observability.
 * - Manages recovery flows after failed tool invocation or empty tool search results, injecting hints.
 * - Optionally synthesizes a final natural language response after executing tools or upon reaching a stop condition.
 *
 * @example
 *   const loop = new AgentLoop(opts);
 *   const result = await loop.run(userInput);
 */
export class AgentLoop {
  /** Aggregated options for LLM provider, tools, sandbox, approvals, tracing, etc. */
  private readonly opts: AgentLoopOpts;
  /** Maximum number of LLM turns permitted before forced termination. */
  private readonly maxTurns: number;
  /** Relaxed-constraint Ajv instance for validating tool input schemas. */
  private readonly ajv = new Ajv({ strict: false });
  /** In-process executor for workflow-kind tools. */
  private readonly executor: WorkflowExecutor;
  private readonly resultStore = new ResultStore();
  private invocationSeq = 0;
  private lastDepth0Binding: string | null = null;

  /**
   * Constructs an AgentLoop, binding its dependencies and policies.
   * @param opts AgentLoopOpts Required collaborators for execution and policies.
   */
  constructor(opts: AgentLoopOpts) {
    this.opts = opts;
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.executor = new WorkflowExecutor({ tracer: opts.tracer });
  }

  /**
   * Begins and runs a multi-turn agent session with the initial user message, returning an agent answer.
   * Orchestrates LLM turns, tool calls, error recovery, and halting conditions.
   * @param userMessage The input from the user to start the session.
   * @returns Final agent output (natural language string).
   */
  async run(userMessage: string): Promise<string> {
    const task: Task = { findToolCalled: false, invokedThisSession: new Set() };
    const messages: ChatMessage[] = [{ role: CHAT_ROLE.user, content: userMessage }];

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const finished = await this.runOneAgentTurn(turn, messages, task);
      if (finished !== null) return finished;
    }
    return `(max turns ${this.maxTurns} reached)`;
  }

  /**
   * One LLM turn: chat, optionally run tool batch (with deferred solo-stop behavior), inject recovery lines.
   * @returns Final user reply when the session should end; `null` to continue with another turn.
   */
  private async runOneAgentTurn(
    turn: number,
    messages: ChatMessage[],
    task: Task,
  ): Promise<string | null> {
    const system = renderSystemPrompt({ catalog: this.makeCatalog() });
    const tools = await this.registeredToolsForTurn(task);
    this.opts.tracer.log(TRACE_KIND_LLM_TURN_START, { turn });
    const resp = await this.opts.llm.chat({
      messages: [{ role: CHAT_ROLE.system, content: system }, ...messages],
      tools,
      traceTag: LLM_TRACE_PHASE.orchestration,
    });
    this.opts.tracer.log(TRACE_KIND_LLM_TURN, { turn, usage: resp.usage ?? null });
    messages.push(resp.message);

    if (!resp.message.tool_calls || resp.message.tool_calls.length === 0) {
      if (resp.message.content) return resp.message.content;
      return "(agent returned no content)";
    }

    // If stop appears alongside other tools in one batch the model has not yet
    // seen tool results when it wrote stop.reason. Defer stop so we can run
    // another LLM turn after all tool messages are appended.
    const hasStop = resp.message.tool_calls.some((c) => c.function.name === META_FN.stop);
    const hasOther = resp.message.tool_calls.some((c) => c.function.name !== META_FN.stop);
    const deferStop = hasStop && hasOther;

    let invokeFailedThisBatch = false;
    let emptyFindThisBatch = false;
    for (const call of resp.message.tool_calls) {
      const step = await this.processOneToolCall(call, messages, task, deferStop);
      if (step.done) return step.answer;
      invokeFailedThisBatch ||= step.invokeFailed;
      emptyFindThisBatch ||= step.emptyFind;
    }
    if (invokeFailedThisBatch) {
      messages.push({ role: CHAT_ROLE.user, content: INVOKE_FAILURE_RECOVERY_USER });
    }
    if (emptyFindThisBatch) {
      messages.push({ role: CHAT_ROLE.user, content: EMPTY_FIND_RECOVERY_USER });
    }
    return null;
  }

  /**
   * Parses args, dispatches one model tool call, logs `tool-call`, then either completes a solo `stop`
   * or appends the tool role message and reports batch recovery hints.
   */
  private async processOneToolCall(
    call: ToolCall,
    messages: ChatMessage[],
    task: Task,
    deferStop: boolean,
  ): Promise<{ done: true; answer: string } | { done: false; invokeFailed: boolean; emptyFind: boolean }> {
    const parsedArgs = safeParse(call.function.arguments);
    this.opts.tracer.log(TRACE_KIND_TOOL_DISPATCH_START, { name: call.function.name });
    const result = await this.dispatch(call.function.name, parsedArgs, task, 0);
    const invokeFailed = call.function.name === META_FN.invokeTool && !result.ok;
    const emptyFind = call.function.name === META_FN.findTool && findToolReturnedNoMatches(result);
    this.opts.tracer.log(TRACE_KIND_TOOL_CALL, {
      name: call.function.name,
      args: parsedArgs,
      ok: result.ok,
      result: toolResultForTrace(result),
    });
    if (call.function.name === META_FN.stop && !deferStop) {
      const answer = await this.finalizeSoloStopCall(messages, call.id, parsedArgs, result);
      return { done: true, answer };
    }
    messages.push({
      role: CHAT_ROLE.tool,
      tool_call_id: call.id,
      content: (() => {
        const isInvoke = call.function.name === META_FN.invokeTool;
        const elided =
          isInvoke && result.ok && this.lastDepth0Binding !== null
            ? JSON.stringify(describeForModel(result.ok ? result.value : null, this.lastDepth0Binding))
            : JSON.stringify(result);
        this.lastDepth0Binding = null;
        return elided;
      })(),
    });
    return { done: false, invokeFailed, emptyFind };
  }

  /** Stores a successful depth-0 tool result under a fresh binding and remembers it for elision. */
  private storeDepth0Result(name: string, result: ToolResult): string | null {
    if (!result.ok) { this.lastDepth0Binding = null; return null; }
    const binding = `r_${this.invocationSeq++}_${sanitizeBinding(name)}`;
    this.resultStore.put(binding, result.value);
    this.lastDepth0Binding = binding;
    return binding;
  }

  /**
   * Handles a non-deferred `stop` tool call: records whether tool results existed before this stop,
   * appends this stop's tool message, then runs synthesis or returns the stop reason.
   */
  private async finalizeSoloStopCall(
    messages: ChatMessage[],
    toolCallId: string,
    parsedArgs: unknown,
    result: ToolResult,
  ): Promise<string> {
    const reason = (parsedArgs as { reason?: string })?.reason ?? DEFAULT_SOLO_STOP_REASON;
    const hadPriorToolResults = messagesIncludeToolResults(messages);
    messages.push({
      role: CHAT_ROLE.tool,
      tool_call_id: toolCallId,
      content: JSON.stringify(result),
    });
    return await this.finalizeAfterStop(messages, reason, hadPriorToolResults);
  }

  /**
   * If a turn ended with a solo stop, optionally do an LLM pass to answer using tool results,
   * so user receives context, not just a stop reason. If no tool results, returns stop reason.
   * @param messages The chat history at this point, including tool results
   * @param stopReason The stop reason provided by the model
   * @param hadPriorToolResults Whether any tool results are included in the history
   * @returns Synthesized answer string or the stop reason
   */
  private async finalizeAfterStop(
    messages: ChatMessage[],
    stopReason: string,
    hadPriorToolResults: boolean,
  ): Promise<string> {
    const trimmedReason = stopReason.trim() || DEFAULT_SOLO_STOP_REASON;
    if (!hadPriorToolResults) return trimmedReason;

    this.opts.tracer.log(TRACE_KIND_LLM_SYNTHESIS_START, {});
    const syn = await this.opts.llm.chat({
      messages: [{ role: CHAT_ROLE.system, content: FINAL_SYNTHESIS_SYSTEM }, ...messages],
      toolChoice: CHAT_TOOL_CHOICE.none,
      traceTag: LLM_TRACE_PHASE.synthesis,
    });
    this.opts.tracer.log(TRACE_KIND_LLM_SYNTHESIS, { usage: syn.usage ?? null });

    if (syn.message.tool_calls?.length) return trimmedReason;

    const text = (syn.message.content ?? "").trim();
    return text || trimmedReason;
  }

  /**
   * Creates the current tool catalog for the system prompt, including all registered tools.
   * @returns Array of available tools ({ name, shortDescription, kind })
   */
  private makeCatalog() {
    return this.opts.registry.listSync().map((s) => ({
      name: s.name,
      shortDescription: firstSentence(s.description, CATALOG_DESCRIPTION_PREVIEW_MAX),
      kind: s.kind,
    }));
  }

  /**
   * Computes and returns the set of tool definitions (meta- and user-discovered) available for this turn.
   * @param task Current task/session context.
   * @returns ToolDef[] List of tool function definitions to present to the LLM.
   */
  private async registeredToolsForTurn(task: Task): Promise<ToolDef[]> {
    const defs: ToolDef[] = [...META_TOOL_DEFS];
    for (const name of task.invokedThisSession) {
      const manifest = await this.opts.registry.getManifest(name);
      if (!manifest) continue;
      defs.push({
        type: CHAT_TOOL_TYPE.function,
        function: {
          name: manifest.name,
          description: manifest.description,
          parameters: manifest.inputSchema as Record<string, unknown>,
        },
      });
    }
    return defs;
  }

  /**
   * Dispatches a tool (or meta-tool) invocation. Delegates to meta/tool-specific handlers.
   * @param name Name of the tool or meta-tool to invoke.
   * @param args Parsed arguments for the tool
   * @param task Current task/session context.
   * @param depth Recursion depth (for composite tools).
   * @returns A ToolResult object indicating the outcome of the invocation.
   */
  private async dispatch(name: string, args: unknown, task: Task, depth: number): Promise<ToolResult> {
    if (META_TOOL_NAMES.has(name)) return this.dispatchMeta(name, args, task, depth);
    return this.dispatchTool(name, args, task, depth);
  }

  /**
   * Handles all meta-tool invocations (find_tool, list_tools, invoke_tool, propose_new_tool, etc).
   * @param name Name of the meta-tool.
   * @param rawArgs Raw arguments object.
   * @param task Current task/session context.
   * @param depth Recursion depth (for invoke_tool).
   * @returns ToolResult for the meta-tool invocation.
   */
  private async dispatchMeta(name: string, rawArgs: unknown, task: Task, depth: number): Promise<ToolResult> {
    const args = rawArgs as Record<string, unknown>;
    switch (name) {
      case META_FN.findTool: {
        task.findToolCalled = true;
        const results = await this.opts.index.find(String(args.query ?? ""), {
          k: Number(args.k ?? FIND_TOOL_TOP_K.default),
        });
        return { ok: true, value: results };
      }
      case META_FN.listTools: {
        return { ok: true, value: this.makeCatalog() };
      }
      case META_FN.invokeTool: {
        return this.dispatchTool(String(args.name), args.args, task, depth);
      }
      case META_FN.proposeNewTool: {
        if (!task.findToolCalled)
          return toolError(TOOL_ERROR_KIND.REJECTED_BY_USER, `call ${META_FN.findTool} at least once before proposing a new tool`);
        const out = await this.opts.factory.createAtomic({
          intent: String(args.intent ?? ""),
          rationale: String(args.rationale ?? ""),
          existingToolsConsidered: (args.existingToolsConsidered as string[] | undefined) ?? [],
        });
        if (!out.ok) return toolError(TOOL_ERROR_KIND.REJECTED_BY_USER, out.reason);
        return { ok: true, value: { name: out.tool.manifest.name, description: out.tool.manifest.description } };
      }
      case META_FN.proposeCompositeTool: {
        const out = await this.opts.factory.createComposite({
          name: String(args.name ?? ""),
          intent: String(args.intent ?? ""),
          plannedSteps: (args.plannedSteps as Array<{ tool: string; argsTemplate: string }> | undefined) ?? [],
        });
        if (!out.ok) return toolError(TOOL_ERROR_KIND.REJECTED_BY_USER, out.reason);
        return { ok: true, value: { name: out.tool.manifest.name, description: out.tool.manifest.description } };
      }
      case META_FN.stop:
        return { ok: true, value: null };
      default:
        return toolError("unknown_tool", `unknown meta-tool '${name}'`);
    }
  }

 
  /**
   * Handles a mediated LLM (large language model) capability request from a tool executing in the sandbox.
   *
   * This function is used as a host-provided capability, allowing sandboxed tools—such as the built-in
   * `llm_generate`—to securely interact with the LLM provider using structured requests (instructions,
   * input data, and optional output schema). It constructs a prompt with a strict system message and
   * a formatted user input, and routes the call to the configured LLM provider. Depending on whether
   * an output schema is specified, it will request either a structured response or an unstructured string.
   * Any provider or runtime errors are caught and returned as tool errors.
   *
   * @param req - The LLM capability request, specifying instructions, input data, and optional schema.
   * @returns A ToolResult containing the LLM's output or an error if the operation fails.
   */
  private async runLlmCapability(req: LlmCapabilityRequest): Promise<ToolResult> {
    const messages: ChatMessage[] = [
      { role: CHAT_ROLE.system, content: LLM_GENERATE_SYSTEM },
      { role: CHAT_ROLE.user, content: renderLlmInstruction(req.instructions, req.input) },
    ];
    try {
      if (req.schema) {
        const value = await this.opts.llm.generateStructured({ messages, schemaName: "llm_generate", schema: req.schema, traceTag: LLM_TRACE_PHASE.capability });
        return { ok: true, value };
      } else {
        const resp = await this.opts.llm.chat({ messages, traceTag: LLM_TRACE_PHASE.capability });
        return { ok: true, value: resp.message.content ?? "" };
      }
    } catch (e) {
      return toolError("runtime_error", `llm capability failed: ${(e as Error).message}`);
    }
  }

  /**
   * Handles invocation of a non-meta-tool (atomic, composite, or workflow).
   *
   * Dispatches on the registered kind and then fetches the body exactly once through the
   * kind-explicit registry getter, so approval and execution always see the same snapshot.
   * Workflow tools run in-process via {@link WorkflowExecutor}; atomic and composite
   * tools run in a sandboxed subprocess via {@link Sandbox}.
   *
   * @param name The name of the tool to invoke.
   * @param args Tool input arguments (parsed, may contain `$ref` sentinels at depth 0).
   * @param task Current session context (for invoked tool tracking and dedup guards).
   * @param depth Recursion depth (incremented for each nested composite or workflow step call).
   * @returns ToolResult for this invocation.
   */
  private async dispatchTool(name: string, args: unknown, task: Task, depth: number): Promise<ToolResult> {
    const kind = await this.opts.registry.getKind(name);
    if (kind === null) return toolError("unknown_tool", `no tool named '${name}'`);
    return kind === TOOL_KIND.WORKFLOW
      ? this.dispatchWorkflowTool(name, args, task, depth)
      : this.dispatchCodeTool(name, args, task, depth);
  }

  /**
   * Runs a workflow tool from a single `getWorkflow` snapshot: the same {@link WorkflowTool}
   * drives input validation, the Gate 2/3 approval check, and `executor.run`. Re-fetching
   * between approval and execution could approve one IR and run another.
   */
  private async dispatchWorkflowTool(name: string, args: unknown, task: Task, depth: number): Promise<ToolResult> {
    const tool = await this.opts.registry.getWorkflow(name);
    if (!tool) return toolError("unknown_tool", `no workflow tool named '${name}'`);

    const prepared = this.prepareInput(tool.manifest.inputSchema as Record<string, unknown>, args, depth);
    if (!prepared.ok) return prepared.failure;

    return this.runWithApproval(tool, prepared.input, args, task, depth,
      () => this.executor.run(
        tool.workflow,
        prepared.input as Record<string, unknown>,
        (toolName, toolArgs, d) => this.dispatchTool(toolName, toolArgs, task, d),
        depth,
      ),
    );
  }

  /**
   * Runs an atomic or composite tool from a single `getCode` snapshot. Gate 2/3 is enforced
   * inside {@link PolicyEnforcedSandbox}, which also re-verifies Link A before spawning.
   */
  private async dispatchCodeTool(name: string, args: unknown, task: Task, depth: number): Promise<ToolResult> {
    const tool = await this.opts.registry.getCode(name);
    if (!tool) return toolError("unknown_tool", `no code tool named '${name}'`);

    const prepared = this.prepareInput(tool.manifest.inputSchema as Record<string, unknown>, args, depth);
    if (!prepared.ok) return prepared.failure;

    const wantsLlm = tool.manifest.capabilities?.includes(TOOL_CAPABILITY.LLM) ?? false;
    return this.runWithTracing(tool, prepared.input, args, task, depth,
      () => this.opts.sandbox.execute(tool, prepared.input, {
        depth,
        onInvokeTool: (subName, subArgs) => this.dispatchTool(subName, subArgs, task, depth + 1),
        ...(wantsLlm ? { onLLM: (req) => this.runLlmCapability(req) } : {}),
      }),
    );
  }

  /**
   * Resolves depth-0 `$ref` sentinels, coerces stringified JSON, and validates against the
   * tool's `inputSchema`.
   *
   * At the agent boundary (depth 0) arguments may carry `{ $ref }` sentinels pointing at prior
   * results the agent never saw in full; callers keep the unresolved form for lift.
   *
   * @param schema The callee's declared input schema.
   * @param args Raw arguments as supplied by the model or a parent step.
   * @param depth Recursion depth; `$ref` resolution only applies at depth 0.
   */
  private prepareInput(
    schema: Record<string, unknown>,
    args: unknown,
    depth: number,
  ): { ok: true; input: unknown } | { ok: false; failure: ToolResult } {
    let effectiveArgs = args;
    if (depth === 0) {
      const resolved = resolveRefs(args, this.resultStore);
      if (!resolved.ok) return { ok: false, failure: toolError("schema_violation", resolved.error) };
      effectiveArgs = resolved.value;
    }

    const input = coerceStringifiedJsonInput(effectiveArgs, rootJsonSchemaKind(schema));
    if (!this.ajv.validate(schema, input)) {
      return {
        ok: false,
        failure: toolError("schema_violation", `input does not match schema: ${this.ajv.errorsText()}`),
      };
    }
    return { ok: true, input };
  }

  /**
   * Approval gate for **workflow** tools, then tracing via {@link runWithTracing}.
   *
   * Sandbox tools use {@link runWithTracing} directly — their policy check is handled by
   * {@link PolicyEnforcedSandbox}.
   *
   * @param tool Registered tool whose manifest drives the approval check.
   * @param input Validated, coerced invocation arguments.
   * @param recordArgs Unresolved arguments at depth 0, passed to `onToolInvoked` for lift.
   * @param task Current session context updated on successful invocation.
   * @param depth Recursion depth; controls `storeDepth0Result` and `onToolInvoked` shape.
   * @param executeFn Workflow executor function.
   * @returns ToolResult from the executor, or a rejection error if the policy denies.
   */
  private async runWithApproval(
    tool: Tool,
    input: unknown,
    recordArgs: unknown,
    task: Task,
    depth: number,
    executeFn: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const name = tool.manifest.name;
    const approval = await this.opts.registry.getApproval(name);
    const decision = await this.opts.approval.checkExecution(tool, input, approval);
    if (decision.decision === APPROVAL_DECISION.REJECT) {
      this.opts.tracer.log(TRACE_KIND_EXECUTION_DENIED, { name, reason: decision.reason });
      return toolError(TOOL_ERROR_KIND.REJECTED_BY_USER, decision.reason);
    }
    return this.runWithTracing(tool, input, recordArgs, task, depth, executeFn);
  }

  /**
   * Executes a tool via `executeFn`, measures elapsed time, and logs the appropriate trace event.
   * If the result is a `rejected_by_user` error (policy rejection surfaced by
   * {@link PolicyEnforcedSandbox}), logs `TRACE_KIND_EXECUTION_DENIED` without calling
   * `onToolInvoked`. All other results log `TRACE_KIND_TOOL_INVOKED` and call `onToolInvoked`.
   *
   * @param tool Tool whose manifest name is used for tracing.
   * @param input Validated invocation arguments.
   * @param recordArgs Unresolved args at depth 0 (forwarded to `onToolInvoked`).
   * @param task Current session context.
   * @param depth Recursion depth.
   * @param executeFn Zero-argument thunk that runs the tool.
   */
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

    // Enforce the output contract before tracing or storing; a violation here downgrades
    // effectiveResult so the trace and stored binding reflect the true outcome, not a false success.
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
}

/**
 * Checks if a tool result indicates that find_tool returned no matches.
 * @param result The ToolResult to check.
 * @returns True if the result is ok and the value is an empty array, false otherwise.
 */
function findToolReturnedNoMatches(result: ToolResult): boolean {
  return result.ok && Array.isArray(result.value) && result.value.length === 0;
}

/** Maximum length of a tool result string to include in trace files. */
const TRACE_RESULT_MAX_STRING = 16_384;

/** JSON-serializable copy of a tool result for trace files (truncates huge strings). */
function toolResultForTrace(result: ToolResult): unknown {
  try {
    return JSON.parse(
      JSON.stringify(result, (_key, v) => {
        if (typeof v === "string" && v.length > TRACE_RESULT_MAX_STRING) {
          return `${v.slice(0, TRACE_RESULT_MAX_STRING)}…(truncated, ${v.length} chars total)`;
        }
        return v;
      }),
    );
  } catch {
    return { ok: result.ok, traceNote: "result could not be serialized for trace" };
  }
}

/**
 * Checks if the chat history includes any tool messages.
 * @param messages The chat history to check.
 * @returns True if any message in the history has {@link CHAT_ROLE.tool}, false otherwise.
 */
function messagesIncludeToolResults(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === CHAT_ROLE.tool);
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}

function firstSentence(desc: string, max: number): string {
  const s = desc.trim().split(/(?<=[.!?])\s/)[0] ?? desc.trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
