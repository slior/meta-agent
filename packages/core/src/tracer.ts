import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** `TraceEvent.kind` for the main agent LLM chat request each turn. */
export const TRACE_KIND_LLM_TURN = "llm-turn" as const;

/** Logged immediately before the main agent `llm.chat` for a turn (CLI progress). */
export const TRACE_KIND_LLM_TURN_START = "llm-turn-start" as const;

/** `TraceEvent.kind` when the model requested a tool (meta or registry); includes args and structured result. */
export const TRACE_KIND_TOOL_CALL = "tool-call" as const;

/** Logged immediately before handling one model tool call (dispatch / approval / sandbox). */
export const TRACE_KIND_TOOL_DISPATCH_START = "tool-dispatch-start" as const;

/** `TraceEvent.kind` for the optional post-stop LLM pass that turns tool JSON into a user-facing reply. */
export const TRACE_KIND_LLM_SYNTHESIS = "llm-synthesis" as const;

/** Logged immediately before the final-answer synthesis `llm.chat` (CLI progress). */
export const TRACE_KIND_LLM_SYNTHESIS_START = "llm-synthesis-start" as const;

/** `TraceEvent.kind` when a registry tool invocation completed in the sandbox (success or failure). */
export const TRACE_KIND_TOOL_INVOKED = "tool-invoked" as const;

/** `TraceEvent.kind` when approval rejected executing a tool before sandbox run. */
export const TRACE_KIND_EXECUTION_DENIED = "execution-denied" as const;

/** Logged before structured-output repair in ToolFactory (CLI progress). */
export const TRACE_KIND_FACTORY_REPAIR_LLM = "factory-repair-llm" as const;

export type TraceEvent = {
  ts: string;
  sessionId: string;
  kind: string;
  data: Record<string, unknown>;
};

export type TracerObserver = (event: TraceEvent) => void;

export type TracerOptions = {
  observers?: ReadonlyArray<TracerObserver>;
};

export class Tracer {
  readonly filename: string;
  readonly sessionId: string;
  private stream: WriteStream;
  private readonly observers: ReadonlyArray<TracerObserver>;

  private constructor(filename: string, sessionId: string, stream: WriteStream, observers: ReadonlyArray<TracerObserver>) {
    this.filename = filename;
    this.sessionId = sessionId;
    this.stream = stream;
    this.observers = observers;
  }

  static async open(dir: string, sessionId: string, options?: TracerOptions): Promise<Tracer> {
    await mkdir(dir, { recursive: true });
    const iso = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${iso}-${sessionId}.jsonl`;
    const stream = createWriteStream(join(dir, filename), { flags: "a" });
    return new Tracer(filename, sessionId, stream, options?.observers ?? []);
  }

  log(kind: string, data: Record<string, unknown>): void {
    const event: TraceEvent = {
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      kind,
      data,
    };
    // Observers are notified before disk write so CLI feedback is immediate.
    // Each observer is wrapped so a CLI bug cannot crash the agent.
    for (const observer of this.observers) {
      try { observer(event); } catch { /* ignore observer errors */ }
    }
    this.stream.write(JSON.stringify(event) + "\n");
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
