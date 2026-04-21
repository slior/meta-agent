import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer } from "./tracer.ts";

async function tmp() {
  return mkdtemp(join(tmpdir(), "meta-agent-trace-"));
}

test("Tracer writes JSONL events in order", async () => {
  const dir = await tmp();
  try {
    const tracer = await Tracer.open(dir, "session-1");
    tracer.log("llm-turn", { modelId: "x", latency: 10 });
    tracer.log("tool-invoked", { name: "t", duration: 5 });
    await tracer.close();

    const files = (await readFile(join(dir, tracer.filename), "utf8")).trim().split("\n");
    assert.equal(files.length, 2);
    const e1 = JSON.parse(files[0]!);
    const e2 = JSON.parse(files[1]!);
    assert.equal(e1.kind, "llm-turn");
    assert.equal(e1.sessionId, "session-1");
    assert.ok(e1.ts);
    assert.equal(e2.kind, "tool-invoked");
    assert.equal(e2.data.name, "t");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Tracer.log is synchronous from caller's perspective but flushes on close", async () => {
  const dir = await tmp();
  try {
    const tracer = await Tracer.open(dir, "s");
    for (let i = 0; i < 100; i++) tracer.log("x", { i });
    await tracer.close();
    const lines = (await readFile(join(dir, tracer.filename), "utf8")).trim().split("\n");
    assert.equal(lines.length, 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
