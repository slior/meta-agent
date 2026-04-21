import Ajv from "ajv";
import type { ApprovalPolicy } from "../approval/interface.ts";
import type { LLMProvider, ChatMessage, ToolDef } from "../llm/interface.ts";
import type { Sandbox } from "../sandbox/interface.ts";
import type { ToolRegistry } from "../registry/interface.ts";
import type { ToolIndex } from "../index-store/interface.ts";
import type { ToolResult } from "../types.ts";
import type { Tracer } from "../tracer.ts";
import { renderSystemPrompt } from "./system-prompt.ts";
import { META_TOOL_DEFS, META_TOOL_NAMES } from "./meta-tools.ts";
import { ToolFactory } from "../factory/factory.ts";
import { toolError } from "../errors.ts";

export type ToolInvokedEvent = { name: string; args: unknown; ok: boolean; durationMs: number };

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

type Task = {
  findToolCalled: boolean;
  invokedThisSession: Set<string>;
};

export class AgentLoop {
  private readonly opts: AgentLoopOpts;
  private readonly maxTurns: number;
  private readonly ajv = new Ajv({ strict: false });

  constructor(opts: AgentLoopOpts) {
    this.opts = opts;
    this.maxTurns = opts.maxTurns ?? 20;
  }

  async run(userMessage: string): Promise<string> {
    const task: Task = { findToolCalled: false, invokedThisSession: new Set() };
    const messages: ChatMessage[] = [{ role: "user", content: userMessage }];

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const system = renderSystemPrompt({ catalog: this.makeCatalog() });
      const tools = await this.registeredToolsForTurn(task);
      const resp = await this.opts.llm.chat({
        messages: [{ role: "system", content: system }, ...messages],
        tools,
      });
      this.opts.tracer.log("llm-turn", { turn, usage: resp.usage ?? null });
      messages.push(resp.message);

      if (!resp.message.tool_calls || resp.message.tool_calls.length === 0) {
        if (resp.message.content) return resp.message.content;
        return "(agent returned no content)";
      }

      for (const call of resp.message.tool_calls) {
        const parsedArgs = safeParse(call.function.arguments);
        const result = await this.dispatch(call.function.name, parsedArgs, task, 0);
        this.opts.tracer.log("tool-call", { name: call.function.name, args: parsedArgs, ok: result.ok });
        if (call.function.name === "stop") {
          return (parsedArgs as { reason?: string })?.reason ?? "stopped";
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }
    return `(max turns ${this.maxTurns} reached)`;
  }

  private makeCatalog() {
    return this.opts.registry.listSync().map((s) => ({
      name: s.name,
      shortDescription: firstSentence(s.description, 80),
      kind: s.kind,
    }));
  }

  private async registeredToolsForTurn(task: Task): Promise<ToolDef[]> {
    const defs: ToolDef[] = [...META_TOOL_DEFS];
    for (const name of task.invokedThisSession) {
      const t = await this.opts.registry.get(name);
      if (!t) continue;
      defs.push({
        type: "function",
        function: {
          name: t.manifest.name,
          description: t.manifest.description,
          parameters: t.manifest.inputSchema as Record<string, unknown>,
        },
      });
    }
    return defs;
  }

  private async dispatch(name: string, args: unknown, task: Task, depth: number): Promise<ToolResult> {
    if (META_TOOL_NAMES.has(name)) return this.dispatchMeta(name, args, task, depth);
    return this.dispatchTool(name, args, task, depth);
  }

  private async dispatchMeta(name: string, rawArgs: unknown, task: Task, depth: number): Promise<ToolResult> {
    const args = rawArgs as Record<string, unknown>;
    switch (name) {
      case "find_tool": {
        task.findToolCalled = true;
        const results = await this.opts.index.find(String(args.query ?? ""), { k: Number(args.k ?? 5) });
        return { ok: true, value: results };
      }
      case "list_tools": {
        return { ok: true, value: this.makeCatalog() };
      }
      case "invoke_tool": {
        return this.dispatchTool(String(args.name), args.args, task, depth);
      }
      case "propose_new_tool": {
        if (!task.findToolCalled) return toolError("rejected_by_user", "call find_tool at least once before proposing a new tool");
        const out = await this.opts.factory.createAtomic({
          intent: String(args.intent ?? ""),
          rationale: String(args.rationale ?? ""),
          existingToolsConsidered: (args.existingToolsConsidered as string[] | undefined) ?? [],
        });
        if (!out.ok) return toolError("rejected_by_user", out.reason);
        return { ok: true, value: { name: out.tool.manifest.name, description: out.tool.manifest.description } };
      }
      case "propose_composite_tool": {
        const out = await this.opts.factory.createComposite({
          name: String(args.name ?? ""),
          intent: String(args.intent ?? ""),
          plannedSteps: (args.plannedSteps as Array<{ tool: string; argsTemplate: string }> | undefined) ?? [],
        });
        if (!out.ok) return toolError("rejected_by_user", out.reason);
        return { ok: true, value: { name: out.tool.manifest.name, description: out.tool.manifest.description } };
      }
      case "stop":
        return { ok: true, value: null };
      default:
        return toolError("unknown_tool", `unknown meta-tool '${name}'`);
    }
  }

  private async dispatchTool(name: string, args: unknown, task: Task, depth: number): Promise<ToolResult> {
    const tool = await this.opts.registry.get(name);
    if (!tool) return toolError("unknown_tool", `no tool named '${name}'`);

    const valid = this.ajv.validate(tool.manifest.inputSchema, args);
    if (!valid) return toolError("schema_violation", `input does not match schema: ${this.ajv.errorsText()}`);

    const approval = await this.opts.registry.getApproval(name);
    const decision = await this.opts.approval.checkExecution(tool, args, approval);
    if (decision.decision === "reject") {
      this.opts.tracer.log("execution-denied", { name, reason: decision.reason });
      return toolError("rejected_by_user", decision.reason);
    }

    const started = Date.now();
    const result = await this.opts.sandbox.execute(tool, args, decision.token, {
      depth,
      onInvokeTool: (subName, subArgs) => this.dispatchTool(subName, subArgs, task, depth + 1),
    });
    const durationMs = Date.now() - started;
    this.opts.tracer.log("tool-invoked", { name, duration: durationMs, ok: result.ok });
    this.opts.onToolInvoked?.({ name, args, ok: result.ok, durationMs });
    if (result.ok) task.invokedThisSession.add(name);
    return result;
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}

function firstSentence(desc: string, max: number): string {
  const s = desc.trim().split(/(?<=[.!?])\s/)[0] ?? desc.trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
