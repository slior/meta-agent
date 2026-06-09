import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_ROLE } from "./LLMProvider.ts";
import { MockLLMProvider } from "./mock-provider.ts";

test("MockLLMProvider dispatches handlers in order", async () => {
  const m = new MockLLMProvider()
    .onChat(() => ({ message: { role: CHAT_ROLE.assistant, content: "first" } }))
    .onChat(() => ({ message: { role: CHAT_ROLE.assistant, content: "second" } }));

  assert.equal((await m.chat({ messages: [] })).message.content, "first");
  assert.equal((await m.chat({ messages: [] })).message.content, "second");
});

test("MockLLMProvider records requests", async () => {
  const m = new MockLLMProvider().onStructured<{ok: boolean}>(() => ({ ok: true }));
  await m.generateStructured<{ok: boolean}>({ messages: [], schemaName: "T", schema: {} });
  assert.equal(m.calls.structured.length, 1);
});

test("MockLLMProvider throws when out of handlers", async () => {
  const m = new MockLLMProvider();
  await assert.rejects(m.chat({ messages: [] }), /no chat handler/);
});
