/** Emitted after a non-streaming chat completion (tools or plain chat). */
export const DEBUG_KIND_OPENAI_CHAT_COMPLETION = "openai.chat.completion" as const;

/** Emitted after a json_schema structured chat completion. */
export const DEBUG_KIND_OPENAI_STRUCTURED_COMPLETION = "openai.structured.completion" as const;

/** One low-level debug record (any subsystem may define `kind` strings). */
export type DebugEvent = {
  kind: string;
  data: unknown;
};

/** Receives debug events when project debug mode is enabled. */
export type DebugSink = (event: DebugEvent) => void;
