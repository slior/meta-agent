/** Literal values for {@link ChatMessage} `role` (OpenAI-compatible). */
export const CHAT_ROLE = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
} as const;

/** Union of {@link CHAT_ROLE} values. */
export type ChatRole = (typeof CHAT_ROLE)[keyof typeof CHAT_ROLE];

/**
 * OpenAI-compatible `type` for {@link ToolDef}, {@link ToolCall}, and function-scoped `tool_choice`.
 */
export const CHAT_TOOL_TYPE = {
  function: "function",
} as const;

/** String values for top-level {@link ChatRequest.toolChoice} (OpenAI `tool_choice`). */
export const CHAT_TOOL_CHOICE = {
  auto: "auto",
  none: "none",
} as const;

/**
 * A single message in a chat completion conversation (OpenAI-compatible).
 *
 * Discriminated on `role`: system/user carry `content`; assistant may include `tool_calls`;
 * tool messages reference the originating call via `tool_call_id`.
 */
export type ChatMessage =
  | { role: typeof CHAT_ROLE.system; content: string }
  | { role: typeof CHAT_ROLE.user; content: string }
  | { role: typeof CHAT_ROLE.assistant; content: string | null; tool_calls?: ToolCall[] }
  | { role: typeof CHAT_ROLE.tool; tool_call_id: string; content: string };

/**
 * A function tool invocation requested by the model in an assistant message.
 *
 * @property id - Provider-assigned call id; echoed in the subsequent tool-role message.
 * @property type - Always {@link CHAT_TOOL_TYPE.function}.
 * @property function.name - Registered tool name to invoke.
 * @property function.arguments - JSON-encoded arguments string from the model.
 */
export type ToolCall = {
  id: string;
  type: typeof CHAT_TOOL_TYPE.function;
  function: { name: string; arguments: string };
};

/**
 * OpenAI-style tool definition exposed to the model during chat completion.
 *
 * @property type - Always {@link CHAT_TOOL_TYPE.function}.
 * @property function.name - Tool name the model may call.
 * @property function.description - Human-readable capability summary for the model.
 * @property function.parameters - JSON Schema object describing accepted arguments.
 */
export type ToolDef = {
  type: typeof CHAT_TOOL_TYPE.function;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Request payload for a chat completion with optional tool calling.
 *
 * @property messages - Conversation history, including system, user, assistant, and tool turns.
 * @property tools - (Optional) Tool definitions the model may invoke.
 * @property toolChoice - (Optional) How the provider should use tools: {@link CHAT_TOOL_CHOICE} or a forced function call.
 * @property traceTag - (Optional) Attribution tag surfaced into the `llm-call` trace event.
 */
export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?:
    | (typeof CHAT_TOOL_CHOICE)[keyof typeof CHAT_TOOL_CHOICE]
    | { type: typeof CHAT_TOOL_TYPE.function; function: { name: string } };
  traceTag?: string;
};

/**
 * Response from a chat completion.
 *
 * @property message - Assistant turn, optionally containing `tool_calls` for the agent loop to dispatch.
 * @property usage - (Optional) Token counts when the provider reports them.
 */
export type ChatResponse = {
  message: Extract<ChatMessage, { role: typeof CHAT_ROLE.assistant }>;
  usage?: { promptTokens: number; completionTokens: number };
};

/**
 * Request payload for schema-constrained JSON generation (structured output).
 *
 * @property messages - Conversation context sent with the schema prompt.
 * @property schemaName - Provider-facing label for the response schema.
 * @property schema - JSON Schema the parsed result must satisfy.
 * @property traceTag - (Optional) Attribution tag surfaced into the `llm-call` trace event.
 */
export type StructuredRequest = {
  messages: ChatMessage[];
  schemaName: string;
  schema: Record<string, unknown>;
  traceTag?: string;
};

/**
 * Abstraction over an LLM backend for chat and structured generation.
 *
 * Implementations translate these request types to a provider API (e.g. OpenAI) and map responses back.
 */
export interface LLMProvider {
  /**
   * Runs a chat completion, optionally with tool definitions and tool-choice policy.
   *
   * @param req - Messages and optional tool-calling configuration.
   * @returns The assistant message and optional token usage.
   */
  chat(req: ChatRequest): Promise<ChatResponse>;

  /**
   * Generates a value matching a JSON Schema from the given message context.
   *
   * @param req - Messages plus schema name and definition.
   * @returns Parsed object of type `T` (caller supplies the expected shape).
   */
  generateStructured<T>(req: StructuredRequest): Promise<T>;
}
