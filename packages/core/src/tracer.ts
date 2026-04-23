import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

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
