import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSystemPrompt } from "./system-prompt.ts";

test("system prompt instructs routing generation through llm_generate", () => {
  const p = renderSystemPrompt({ catalog: [] });
  assert.match(p, /llm_generate/);
  assert.match(p, /pass that tool's return value as `input` unchanged/);
});
