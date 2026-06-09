import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSystemPrompt } from "./system-prompt.ts";

test("system prompt explains the $ref reference contract", () => {
  const p = renderSystemPrompt({ catalog: [] });
  assert.match(p, /\$ref/);
  assert.match(p, /previous tool/i);
});

test("system prompt instructs routing generation through llm_generate", () => {
  const p = renderSystemPrompt({ catalog: [] });
  assert.match(p, /llm_generate/);
});
