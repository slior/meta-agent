import { test } from "node:test";
import assert from "node:assert/strict";
import { hashCodeTool, hashToolBody, hashWorkflowTool, serializeWorkflowBody } from "./hash.ts";
import { KNOWN_TOOL_CAPABILITIES, TOOL_CAPABILITY, TOOL_KIND } from "./types.ts";
import type { Workflow } from "./workflow/types.ts";

const BASE = {
  name: "t", description: "d", rationale: "r",
  inputSchema: {}, outputShape: {},
  permissions: { fsRead: [], fsWrite: [], net: "none" as const, netAllowlist: [], env: [] },
  dependencies: [] as string[],
  limits: { timeoutMs: 1, maxOldSpaceSizeMb: 64 },
  createdAt: "2026-01-01T00:00:00Z",
  kind: TOOL_KIND.ATOMIC,
};

test("known capabilities include llm", () => {
  assert.equal(TOOL_CAPABILITY.LLM, "llm");
  assert.ok(KNOWN_TOOL_CAPABILITIES.has("llm"));
});

test("hashCodeTool equals hashToolBody on same code", () => {
  assert.equal(hashCodeTool("code", BASE), hashToolBody("code", BASE));
});

test("hashWorkflowTool hashes serializeWorkflowBody bytes", () => {
  const workflow: Workflow = {
    schemaVersion: 1, name: "w", description: "d", goal: "g", inputs: [],
    steps: [{ kind: "tool_call", label: "s0", tool: "t", arguments: {}, resultBinding: "r0" }],
    return: null,
  };
  const raw = serializeWorkflowBody(workflow);
  assert.equal(raw, JSON.stringify(workflow, null, 2));
  const manifest = { ...BASE, kind: TOOL_KIND.WORKFLOW };
  assert.equal(hashWorkflowTool(workflow, manifest), hashToolBody(raw, manifest));
});

test("capabilities change the hash", () => {
  const a = hashCodeTool("code", { ...BASE });
  const b = hashCodeTool("code", { ...BASE, capabilities: ["llm"] });
  assert.notEqual(a, b);
});
