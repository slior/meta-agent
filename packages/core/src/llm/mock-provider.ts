import type { ChatRequest, ChatResponse, LLMProvider, StructuredRequest } from "./LLMProvider.ts";

export type ChatHandler = (req: ChatRequest, turn: number) => ChatResponse | Promise<ChatResponse>;
export type StructuredHandler<T = unknown> = (req: StructuredRequest, turn: number) => T | Promise<T>;

export class MockLLMProvider implements LLMProvider {
  private chatHandlers: ChatHandler[] = [];
  private structHandlers: StructuredHandler[] = [];
  private chatTurn = 0;
  private structTurn = 0;
  public calls: { chat: ChatRequest[]; structured: StructuredRequest[] } = { chat: [], structured: [] };

  onChat(handler: ChatHandler): this { this.chatHandlers.push(handler); return this; }
  onStructured<T>(handler: StructuredHandler<T>): this { this.structHandlers.push(handler as StructuredHandler); return this; }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.chat.push(req);
    const h = this.chatHandlers[this.chatTurn++];
    if (!h) throw new Error(`MockLLMProvider: no chat handler for turn ${this.chatTurn - 1}`);
    return await h(req, this.chatTurn - 1);
  }

  async generateStructured<T>(req: StructuredRequest): Promise<T> {
    this.calls.structured.push(req);
    const h = this.structHandlers[this.structTurn++];
    if (!h) throw new Error(`MockLLMProvider: no structured handler for turn ${this.structTurn - 1}`);
    return (await h(req, this.structTurn - 1)) as T;
  }
}
