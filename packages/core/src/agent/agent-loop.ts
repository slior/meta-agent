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
} from "../llm/interface.ts";
import type { Sandbox } from "../sandbox/interface.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";
import type { ToolIndex } from "../index-store/interface.ts";
import { TOOL_KIND, type ToolResult } from "../types.ts";
import {
  TRACE_KIND_EXECUTION_DENIED,
  TRACE_KIND_LLM_SYNTHESIS,
  TRACE_KIND_LLM_SYNTHESIS_START,
  TRACE_KIND_LLM_TURN,
  TRACE_KIND_LLM_TURN_START,
  TRACE_KIND_TOOL_CALL,
  TRACE_KIND_TOOL_DISPATCH_START,
  TRACE_KIND_TOOL_INVOKED,
  type Tracer,
} from "../tracer.ts";
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

export type ToolInvokedEvent = { name: string; args: unknown; ok: boolean; durationMs: number; value?: unknown };

/**
 * Options for constructing an {@link AgentLoop}.
 *
 * @property {LLMProvider} llm - The language model provider used for message generation.
 * @property {ToolRegistry} registry - Registry for tool lookup and metadata.
 * @property {ToolIndex} index - Tool search/indexing system, used for find_tool operations.
 * @property {Sandbox} sandbox - Secure environment for tool execution.
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
  sandbox: Sandbox;
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
      content: JSON.stringify(result),
    });
    return { done: false, invokeFailed, emptyFind };
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
      const t = await this.opts.registry.get(name);
      if (!t) continue;
      defs.push({
        type: CHAT_TOOL_TYPE.function,
        function: {
          name: t.manifest.name,
          description: t.manifest.description,
          parameters: t.manifest.inputSchema as Record<string, unknown>,
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
          return toolError("rejected_by_user", `call ${META_FN.findTool} at least once before proposing a new tool`);
        const out = await this.opts.factory.createAtomic({
          intent: String(args.intent ?? ""),
          rationale: String(args.rationale ?? ""),
          existingToolsConsidered: (args.existingToolsConsidered as string[] | undefined) ?? [],
        });
        if (!out.ok) return toolError("rejected_by_user", out.reason);
        return { ok: true, value: { name: out.tool.manifest.name, description: out.tool.manifest.description } };
      }
      case META_FN.proposeCompositeTool: {
        const out = await this.opts.factory.createComposite({
          name: String(args.name ?? ""),
          intent: String(args.intent ?? ""),
          plannedSteps: (args.plannedSteps as Array<{ tool: string; argsTemplate: string }> | undefined) ?? [],
        });
        if (!out.ok) return toolError("rejected_by_user", out.reason);
        return { ok: true, value: { name: out.tool.manifest.name, description: out.tool.manifest.description } };
      }
      case META_FN.stop:
        return { ok: true, value: null };
      default:
        return toolError("unknown_tool", `unknown meta-tool '${name}'`);
    }
  }

  /**
   * Handles invocation of a non-meta-tool ("user", composite, or workflow tools).
   * Validates input, requests approval, invokes the tool in sandbox (or executor for workflows), and records invocation/trace.
   * Updates state for allowed tool invocations.
   * @param name The name of the tool to invoke.
   * @param args Tool input arguments (parsed).
   * @param task Current session context (for invoked tool tracking).
   * @param depth Recursion depth (in composite or self-invoking tools).
   * @returns ToolResult for this invocation.
   */
  private async dispatchTool(name: string, args: unknown, task: Task, depth: number): Promise<ToolResult> {
    const tool = await this.opts.registry.get(name);
    if (!tool) return toolError("unknown_tool", `no tool named '${name}'`);

    // Workflow tools run in-process via WorkflowExecutor
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
    this.opts.onToolInvoked?.({ name, args: input, ok: result.ok, durationMs, value: result.ok ? result.value : undefined });
    if (result.ok) task.invokedThisSession.add(name);
    return result;
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
