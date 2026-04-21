import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type TraceEvent = {
  ts: string;
  sessionId: string;
  kind: string;
  data: Record<string, unknown>;
};

export class Tracer {
  filename: string;
  sessionId: string;
  #stream: WriteStream;

  constructor(filename: string, sessionId: string, stream: WriteStream) {
    this.filename = filename;
    this.sessionId = sessionId;
    this.#stream = stream;
  }

  static async open(dir: string, sessionId: string): Promise<Tracer> {
    await mkdir(dir, { recursive: true });
    const iso = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${iso}-${sessionId}.jsonl`;
    const stream = createWriteStream(join(dir, filename), { flags: "a" });
    return new Tracer(filename, sessionId, stream);
  }

  log(kind: string, data: Record<string, unknown>): void {
    const event: TraceEvent = {
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      kind,
      data,
    };
    this.#stream.write(JSON.stringify(event) + "\n");
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
