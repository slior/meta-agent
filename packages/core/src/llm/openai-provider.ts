import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import {
  CHAT_ROLE,
  CHAT_TOOL_CHOICE,
  CHAT_TOOL_TYPE,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type LLMProvider,
  type StructuredRequest,
  type ToolCall,
} from "./interface.ts";

/** `response_format.type` for JSON-schema structured completions. */
const RESPONSE_FORMAT_JSON_SCHEMA = "json_schema" as const;

/**
 * `json_schema.strict` for structured output. `true` rejects schemas with open nested objects
 * (e.g. ToolDraft `inputSchema` / `outputShape`); validation relies on staticValidateDraft + smoke tests.
 */
const STRUCTURED_SCHEMA_STRICT = false;

function mapOpenAiToolCalls(
  raw:
    | Array<{ id: string; function: { name: string; arguments: string } }>
    | null
    | undefined,
): ToolCall[] | undefined {
  if (!raw?.length) return undefined;
  return raw.map((tc) => ({
    id: tc.id,
    type: CHAT_TOOL_TYPE.function,
    function: { name: tc.function.name, arguments: tc.function.arguments },
  }));
}

function usageFromCompletion(resp: { usage?: { prompt_tokens: number; completion_tokens: number } | null }): ChatResponse["usage"] | undefined {
  const u = resp.usage;
  if (!u) return undefined;
  return { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens };
}

export type OpenAIProviderOpts = {
  apiKey: string;
  baseURL?: string;
  model: string;
  requestTimeoutMs?: number;
};

/**
 * OpenAIProvider is an implementation of the LLMProvider interface that integrates with the OpenAI API.
 *
 * Responsibilities:
 *   - Wraps OpenAI's chat completion API to provide chatbot-like interactions and function/tool calling support.
 *   - Supports OpenAI's structured ("json_schema") response mode for precise, schema-constrained completions.
 *   - Delivers token usage accounting when available, mapping OpenAI usage to internal types.
 *
 * Design:
 *   - Requires an API key, base URL (optional, e.g. for Azure/OpenAI-compatible endpoints), and model name on construction.
 *   - Accepts generic ChatRequest objects and generates ChatResponses, managing translation to OpenAI's parameter structures.
 *   - Provides a strong, type-safe interface for both chat and structured output use-cases.
 *
 * Example usage:
 *   ```ts
 *   const provider = new OpenAIProvider({ apiKey, model: "gpt-4" });
 *   const response = await provider.chat({ messages: [...] });
 *   ```
 */
export class OpenAIProvider implements LLMProvider {
  /** The OpenAI API client used for making completion requests. */
  private readonly client: OpenAI;

  /** The model name to use for all requests (e.g., "gpt-3.5-turbo", "gpt-4"). */
  private readonly model: string;

  /**
   * Constructs an OpenAIProvider.
   * @param opts - Configuration options for provider instance (API key, endpoint, model, timeout, etc).
   */
  constructor(opts: OpenAIProviderOpts) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.requestTimeoutMs,
    });
    this.model = opts.model;
  }

  /**
   * Prepares base parameters for a non-streaming chat completion request.
   * @param messages - Array of chat messages, using the compatible message type.
   * @returns Object containing model and converted messages.
   * @internal
   */
  private baseCompletionParams(
    messages: ChatMessage[],
  ): Pick<ChatCompletionCreateParamsNonStreaming, "model" | "messages"> {
    return {
      model: this.model,
      messages: messages as unknown as ChatCompletionCreateParamsNonStreaming["messages"],
    };
  }

  /**
   * Sends a ChatRequest to OpenAI and returns the resulting ChatResponse.
   * Handles tool calling (function calling) support if tools/toolChoice are present in the request.
   * Maps OpenAI's response to internal representation, including usage statistics when available.
   *
   * @param req - ChatRequest object with messages, optional tool/toolChoice, etc.
   * @returns ChatResponse containing assistant message and (optionally) usage data.
   * @throws Error if OpenAI gives no choice response.
   */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const params: ChatCompletionCreateParamsNonStreaming = {
      ...this.baseCompletionParams(req.messages),
      tool_choice: req.toolChoice ?? CHAT_TOOL_CHOICE.auto,
      ...(req.tools ? { tools: req.tools } : {}),
    };
    const resp = await this.client.chat.completions.create(params);
    const choice = resp.choices[0];
    if (!choice) throw new Error("OpenAI response had no choices");
    const msg = choice.message;
    const toolCalls = mapOpenAiToolCalls(msg.tool_calls);
    const assistantMsg: Extract<ChatMessage, { role: typeof CHAT_ROLE.assistant }> = {
      role: CHAT_ROLE.assistant,
      content: msg.content ?? null,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    };
    const usage = usageFromCompletion(resp);
    return {
      message: assistantMsg,
      ...(usage ? { usage } : {}),
    };
  }

  /**
   * Requests a response from OpenAI's API that conforms to a provided JSON schema,
   * enforcing structure and type constraints on the output. Useful for developer tools,
   * data labeling, or extraction use-cases.
   *
   * @param req - StructuredRequest specifying schemaName, schema definition, and chat context.
   * @returns Parsed output casted to the expected type T.
   * @throws Error if no content is returned in the resulting choice.
   */
  async generateStructured<T>(req: StructuredRequest): Promise<T> {
    const params: ChatCompletionCreateParamsNonStreaming = {
      ...this.baseCompletionParams(req.messages),
      response_format: {
        type: RESPONSE_FORMAT_JSON_SCHEMA,
        json_schema: {
          name: req.schemaName,
          schema: req.schema,
          strict: STRUCTURED_SCHEMA_STRICT,
        },
      },
    };
    const resp = await this.client.chat.completions.create(params);
    const content = resp.choices[0]?.message.content;
    if (!content) throw new Error("OpenAI structured response had no content");
    return JSON.parse(content) as T;
  }
}
