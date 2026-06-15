import { test } from "node:test";
import assert from "node:assert/strict";
import { TracingLLMProvider } from "./tracing-provider.ts";
import { LLM_TRACE_PHASE, TRACE_KIND_LLM_CALL, type TraceEvent } from "../tracer.ts";
import type { LLMProvider } from "./LLMProvider.ts";
import { CHAT_ROLE } from "./LLMProvider.ts";

function fakeTracer(sink: TraceEvent[]) {
  // Minimal Tracer-compatible shim: only `log` is used by the decorator.
  return { log: (kind: string, data: Record<string, unknown>) => sink.push({ ts: "", sessionId: "", kind, data }) };
}

const inner: LLMProvider = {
  async chat() {
    return { message: { role: CHAT_ROLE.assistant, content: "hi" }, usage: { promptTokens: 3, completionTokens: 1 } };
  },
  async generateStructured() {
    return { a: 1 } as never;
  },
};

test("TracingLLMProvider logs chat request+response with phase", async () => {
  const sink: TraceEvent[] = [];
  const p = new TracingLLMProvider(inner, fakeTracer(sink) as never);
  const resp = await p.chat({ messages: [{ role: CHAT_ROLE.user, content: "yo" }], traceTag: LLM_TRACE_PHASE.orchestration });
  assert.equal(resp.message.content, "hi");
  assert.equal(sink.length, 1);
  assert.equal(sink[0]!.kind, TRACE_KIND_LLM_CALL);
  assert.equal(sink[0]!.data.phase, "orchestration");
  assert.equal(sink[0]!.data.method, "chat");
  assert.deepEqual((sink[0]!.data.request as { messages: unknown }).messages, [{ role: "user", content: "yo" }]);
  assert.equal((sink[0]!.data.response as { content: string }).content, "hi");
});

test("TracingLLMProvider logs generateStructured with structured response and unknown phase default", async () => {
  const sink: TraceEvent[] = [];
  const p = new TracingLLMProvider(inner, fakeTracer(sink) as never);
  const out = await p.generateStructured<{ a: number }>({ messages: [], schemaName: "S", schema: {} });
  assert.deepEqual(out, { a: 1 });
  assert.equal(sink[0]!.data.phase, "unknown");
  assert.equal(sink[0]!.data.method, "generateStructured");
  assert.deepEqual((sink[0]!.data.response as { structured: unknown }).structured, { a: 1 });
});
