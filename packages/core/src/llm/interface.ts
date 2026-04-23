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

export type ChatMessage =
  | { role: typeof CHAT_ROLE.system; content: string }
  | { role: typeof CHAT_ROLE.user; content: string }
  | { role: typeof CHAT_ROLE.assistant; content: string | null; tool_calls?: ToolCall[] }
  | { role: typeof CHAT_ROLE.tool; tool_call_id: string; content: string };

export type ToolCall = {
  id: string;
  type: typeof CHAT_TOOL_TYPE.function;
  function: { name: string; arguments: string };
};

export type ToolDef = {
  type: typeof CHAT_TOOL_TYPE.function;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?:
    | (typeof CHAT_TOOL_CHOICE)[keyof typeof CHAT_TOOL_CHOICE]
    | { type: typeof CHAT_TOOL_TYPE.function; function: { name: string } };
};

export type ChatResponse = {
  message: Extract<ChatMessage, { role: typeof CHAT_ROLE.assistant }>;
  usage?: { promptTokens: number; completionTokens: number };
};

export type StructuredRequest = {
  messages: ChatMessage[];
  schemaName: string;
  schema: Record<string, unknown>;
};

export interface LLMProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  generateStructured<T>(req: StructuredRequest): Promise<T>;
}
