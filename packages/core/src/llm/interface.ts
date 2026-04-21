export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

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
  message: Extract<ChatMessage, { role: "assistant" }>;
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
