import type { ChatRequest, ChatResponse, LLMProvider, StructuredRequest } from "./LLMProvider.ts";
import { LLM_TRACE_PHASE, TRACE_KIND_LLM_CALL, type Tracer } from "../tracer.ts";

/**
 * Decorates an {@link LLMProvider}, logging the full request and response of every
 * call as a {@link TRACE_KIND_LLM_CALL} trace event. This is the single seam through
 * which all host LLM calls pass, so wrapping once captures orchestration, synthesis,
 * the mediated llm_generate capability, and factory calls. The `phase` is taken from
 * the request's `traceTag` (defaulting to "unknown").
 */
export class TracingLLMProvider implements LLMProvider {
  constructor(private readonly inner: LLMProvider, private readonly tracer: Tracer) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const resp = await this.inner.chat(req);
    this.tracer.log(TRACE_KIND_LLM_CALL, {
      phase: req.traceTag ?? LLM_TRACE_PHASE.unknown,
      method: "chat",
      request: { messages: req.messages, tools: req.tools ?? null, toolChoice: req.toolChoice ?? null },
      response: { content: resp.message.content ?? null, tool_calls: resp.message.tool_calls ?? null },
      usage: resp.usage ?? null,
    });
    return resp;
  }

  async generateStructured<T>(req: StructuredRequest): Promise<T> {
    const value = await this.inner.generateStructured<T>(req);
    this.tracer.log(TRACE_KIND_LLM_CALL, {
      phase: req.traceTag ?? LLM_TRACE_PHASE.unknown,
      method: "generateStructured",
      request: { messages: req.messages, schemaName: req.schemaName },
      response: { structured: value },
      usage: null,
    });
    return value;
  }
}
