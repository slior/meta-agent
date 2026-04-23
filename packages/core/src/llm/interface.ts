/** Literal values for {@link ChatMessage} `role` (OpenAI-compatible). */
export const CHAT_ROLE = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
} as const;

/** Union of {@link CHAT_ROLE} values. */
export type ChatRole = (typeof CHAT_ROLE)[keyof typeof CHAT_ROLE];

export type ChatMessage =
  | { role: typeof CHAT_ROLE.system; content: string }
  | { role: typeof CHAT_ROLE.user; content: string }
  | { role: typeof CHAT_ROLE.assistant; content: string | null; tool_calls?: ToolCall[] }
  | { role: typeof CHAT_ROLE.tool; tool_call_id: string; content: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
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
