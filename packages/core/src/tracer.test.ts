import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { META_FN } from "./agent/meta-tools.ts";
import {
  TRACE_KIND_LLM_TURN,
  TRACE_KIND_TOOL_CALL,
  TRACE_KIND_TOOL_INVOKED,
  Tracer,
} from "./tracer.ts";

async function tmp() {
  return mkdtemp(join(tmpdir(), "meta-agent-trace-"));
}

test("Tracer writes JSONL events in order", async () => {
  const dir = await tmp();
  try {
    const tracer = await Tracer.open(dir, "session-1");
    tracer.log(TRACE_KIND_LLM_TURN, { modelId: "x", latency: 10 });
    tracer.log(TRACE_KIND_TOOL_INVOKED, { name: "t", duration: 5 });
    await tracer.close();

    const files = (await readFile(join(dir, tracer.filename), "utf8")).trim().split("\n");
    assert.equal(files.length, 2);
    const e1 = JSON.parse(files[0]!);
    const e2 = JSON.parse(files[1]!);
    assert.equal(e1.kind, TRACE_KIND_LLM_TURN);
    assert.equal(e1.sessionId, "session-1");
    assert.ok(e1.ts);
    assert.equal(e2.kind, TRACE_KIND_TOOL_INVOKED);
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

test("Tracer observers receive each event with correct shape", async () => {
  const dir = await tmp();
  try {
    const received: import("./tracer.ts").TraceEvent[] = [];
    const tracer = await Tracer.open(dir, "obs-session", {
      observers: [(e) => received.push(e)],
    });
    tracer.log(TRACE_KIND_LLM_TURN, { turn: 0 });
    tracer.log(TRACE_KIND_TOOL_CALL, { name: META_FN.findTool });
    await tracer.close();

    assert.equal(received.length, 2);
    assert.equal(received[0]!.kind, TRACE_KIND_LLM_TURN);
    assert.equal(received[0]!.sessionId, "obs-session");
    assert.ok(received[0]!.ts);
    assert.deepEqual(received[0]!.data, { turn: 0 });
    assert.equal(received[1]!.kind, TRACE_KIND_TOOL_CALL);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Tracer observer is called before disk write (same event shape as file)", async () => {
  const dir = await tmp();
  try {
    const observed: import("./tracer.ts").TraceEvent[] = [];
    const tracer = await Tracer.open(dir, "s2", {
      observers: [(e) => observed.push(structuredClone(e))],
    });
    tracer.log(TRACE_KIND_TOOL_INVOKED, { name: "my-tool", duration: 42 });
    await tracer.close();

    const written = JSON.parse((await readFile(join(dir, tracer.filename), "utf8")).trim());
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.kind, written.kind);
    assert.equal(observed[0]!.sessionId, written.sessionId);
    assert.deepEqual(observed[0]!.data, written.data);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Tracer open without options is backward-compatible", async () => {
  const dir = await tmp();
  try {
    const tracer = await Tracer.open(dir, "compat");
    tracer.log("x", {});
    await tracer.close();
    const lines = (await readFile(join(dir, tracer.filename), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Tracer observer error does not crash the agent", async () => {
  const dir = await tmp();
  try {
    const tracer = await Tracer.open(dir, "err-obs", {
      observers: [() => { throw new Error("observer boom"); }],
    });
    assert.doesNotThrow(() => tracer.log("x", {}));
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
