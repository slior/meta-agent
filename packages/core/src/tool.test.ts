import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_KIND } from "./types.ts";
import { isCodeTool, isWorkflowTool, type CodeTool, type WorkflowTool } from "./tool.ts";

const baseManifest = {
  name: "t", description: "d", rationale: "r",
  inputSchema: {}, outputShape: {},
  permissions: { fsRead: [], fsWrite: [], net: "none" as const, netAllowlist: [], env: [] },
  dependencies: [] as string[],
  limits: { timeoutMs: 1000, maxOldSpaceSizeMb: 64 },
  hash: "sha256:" + "a".repeat(64),
  createdAt: "2026-01-01T00:00:00.000Z",
};

test("isCodeTool / isWorkflowTool narrow on manifest.kind", () => {
  const code: CodeTool = { manifest: { ...baseManifest, kind: TOOL_KIND.ATOMIC }, code: "export async function run(){}" };
  const wf: WorkflowTool = {
    manifest: { ...baseManifest, kind: TOOL_KIND.WORKFLOW },
    workflow: { schemaVersion: 1, name: "t", description: "d", goal: "g", inputs: [], steps: [{ kind: "tool_call", label: "s0", tool: "x", arguments: {}, resultBinding: "r0" }], return: null },
  };
  assert.equal(isCodeTool(code), true);
  assert.equal(isWorkflowTool(code), false);
  assert.equal(isWorkflowTool(wf), true);
  assert.equal(isCodeTool(wf), false);
});
