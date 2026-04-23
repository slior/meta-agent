import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider, StructuredRequest, ToolCall } from "./interface.ts";

export type OpenAIProviderOpts = {
  apiKey: string;
  baseURL?: string;
  model: string;
  requestTimeoutMs?: number;
};

export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts: OpenAIProviderOpts) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.requestTimeoutMs,
    });
    this.model = opts.model;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: req.messages as unknown as ChatCompletionCreateParamsNonStreaming["messages"],
      tool_choice: req.toolChoice ?? "auto",
      ...(req.tools ? { tools: req.tools } : {}),
    };
    const resp = await this.client.chat.completions.create(params);
    const choice = resp.choices[0];
    if (!choice) throw new Error("OpenAI response had no choices");
    const msg = choice.message;
    const toolCalls: ToolCall[] | undefined = msg.tool_calls?.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
    const assistantMsg: ChatMessage & { role: "assistant" } = {
      role: "assistant",
      content: msg.content ?? null,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    };
    return {
      message: assistantMsg,
      ...(resp.usage
        ? { usage: { promptTokens: resp.usage.prompt_tokens, completionTokens: resp.usage.completion_tokens } }
        : {}),
    };
  }

  async generateStructured<T>(req: StructuredRequest): Promise<T> {
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: req.messages as unknown as ChatCompletionCreateParamsNonStreaming["messages"],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: req.schemaName,
          schema: req.schema,
          // strict: true rejects schemas with nested open objects (e.g. inputSchema / outputShape in
          // ToolDraft); correctness is enforced by staticValidateDraft + smoke tests instead.
          strict: false,
        },
      },
    };
    const resp = await this.client.chat.completions.create(params);
    const content = resp.choices[0]?.message.content;
    if (!content) throw new Error("OpenAI structured response had no content");
    return JSON.parse(content) as T;
  }
}
