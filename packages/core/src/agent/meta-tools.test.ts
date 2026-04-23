import { test } from "node:test";
import assert from "node:assert/strict";
import { FIND_TOOL_TOP_K, META_FN, META_TOOL_DEFS, META_TOOL_NAMES } from "./meta-tools.ts";
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
  for (const name of Object.values(META_FN)) {
    assert.ok(META_TOOL_NAMES.has(name), `missing ${name}`);
  }
});

test("find_tool k schema matches FIND_TOOL_TOP_K", () => {
  const findDef = META_TOOL_DEFS.find((t) => t.function.name === META_FN.findTool);
  assert.ok(findDef);
  const kSchema = (findDef!.function.parameters.properties as Record<string, unknown>).k as Record<string, unknown>;
  assert.equal(kSchema.minimum, FIND_TOOL_TOP_K.min);
  assert.equal(kSchema.maximum, FIND_TOOL_TOP_K.max);
  assert.equal(kSchema.default, FIND_TOOL_TOP_K.default);
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
