import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTool } from "./hash.ts";
import { KNOWN_TOOL_CAPABILITIES, TOOL_CAPABILITY } from "./types.ts";

const BASE = {
  name: "t", description: "d", rationale: "r",
  inputSchema: { type: "object" }, outputShape: {},
  permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  dependencies: [], limits: { timeoutMs: 1000, maxOldSpaceSizeMb: 256 },
  createdAt: "1970-01-01T00:00:00.000Z", kind: "atomic",
} as const;

test("known capabilities include llm", () => {
  assert.equal(TOOL_CAPABILITY.llm, "llm");
  assert.ok(KNOWN_TOOL_CAPABILITIES.has("llm"));
});

test("capabilities participate in the tool hash", () => {
  const a = hashTool("code", { ...BASE });
  const b = hashTool("code", { ...BASE, capabilities: ["llm"] });
  assert.notEqual(a, b);
});
