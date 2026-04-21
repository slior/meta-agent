import { test } from "node:test";
import assert from "node:assert/strict";
import { META_TOOL_DEFS, META_TOOL_NAMES } from "./meta-tools.ts";
import { renderSystemPrompt } from "./system-prompt.ts";

test("meta-tool defs are well-formed", () => {
  for (const t of META_TOOL_DEFS) {
    assert.equal(t.type, "function");
    assert.ok(t.function.name);
    assert.ok(t.function.description);
    assert.equal(t.function.parameters.type, "object");
  }
});

test("META_TOOL_NAMES contains all expected names", () => {
  for (const name of [
    "find_tool",
    "list_tools",
    "invoke_tool",
    "propose_new_tool",
    "propose_composite_tool",
    "stop",
  ]) {
    assert.ok(META_TOOL_NAMES.has(name), `missing ${name}`);
  }
});

test("renderSystemPrompt lists catalog entries with composite marker", () => {
  const prompt = renderSystemPrompt({
    catalog: [
      { name: "a", shortDescription: "Does a.", kind: "atomic" },
      { name: "b", shortDescription: "Composes.", kind: "composite" },
    ],
  });
  assert.match(prompt, /- a: Does a\./);
  assert.match(prompt, /- ∘ b: Composes\./);
});

test("renderSystemPrompt elides and hints when over maxCatalogShown", () => {
  const prompt = renderSystemPrompt({
    catalog: Array.from({ length: 50 }, (_, i) => ({
      name: `t${i}`,
      shortDescription: "d",
      kind: "atomic" as const,
    })),
    maxCatalogShown: 10,
  });
  assert.match(prompt, /\(40 more/);
});
