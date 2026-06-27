import { test } from "node:test";
import assert from "node:assert/strict";
import type { Interface as RlInterface } from "node:readline/promises";
import { CliApprovalPrompter } from "./approval-tui.ts";
import type { WorkflowGate1Payload } from "@meta-agent/core";
import { APPROVAL_DECISION, GATE1_KIND } from "@meta-agent/core";

/** Minimal fake readline that returns canned answers in order. */
function makeRl(...answers: string[]): RlInterface {
  let i = 0;
  return { question: async (_prompt: string) => answers[i++] ?? "" } as unknown as RlInterface;
}

const WF_PAYLOAD: WorkflowGate1Payload = {
  kind: GATE1_KIND.WORKFLOW,
  workflow: {
    schemaVersion: 1,
    name: "fetch-wf",
    description: "fetches stuff",
    goal: "fetch",
    inputs: [],
    steps: [],
    return: null,
  },
  manifest: {
    name: "fetch-wf",
    description: "fetches stuff",
    rationale: "",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    outputShape: { type: "object" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    hash: "sha256:" + "a".repeat(64),
    createdAt: "2026-01-01T00:00:00Z",
    kind: "workflow",
  },
  effectivePermissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  literateRendering: "Workflow: fetch-wf\n  (no steps)",
};

test("CliApprovalPrompter.promptGate1 workflow [a]: approve, alwaysApprove false, no edits", async () => {
  const p = new CliApprovalPrompter(makeRl("a"));
  const result = await p.promptGate1(WF_PAYLOAD);
  assert.equal(result.kind, GATE1_KIND.WORKFLOW);
  assert.equal(result.decision, "approve");
  if (result.kind === GATE1_KIND.WORKFLOW && result.decision === "approve") {
    assert.equal(result.alwaysApprove, false);
    assert.equal(result.editedName, undefined);
    assert.equal(result.editedDescription, undefined);
  }
});

test("CliApprovalPrompter.promptGate1 workflow [A]: approve, alwaysApprove true", async () => {
  const p = new CliApprovalPrompter(makeRl("A"));
  const result = await p.promptGate1(WF_PAYLOAD);
  assert.equal(result.kind, GATE1_KIND.WORKFLOW);
  if (result.kind === GATE1_KIND.WORKFLOW && result.decision === "approve") {
    assert.equal(result.alwaysApprove, true);
  }
});

test("CliApprovalPrompter.promptGate1 workflow [r]: reject with supplied reason", async () => {
  const p = new CliApprovalPrompter(makeRl("r", "bad workflow"));
  const result = await p.promptGate1(WF_PAYLOAD);
  assert.equal(result.kind, GATE1_KIND.WORKFLOW);
  assert.equal(result.decision, "reject");
  if (result.kind === GATE1_KIND.WORKFLOW && result.decision === "reject") {
    assert.equal(result.reason, "bad workflow");
  }
});

test("CliApprovalPrompter.promptGate1 workflow [e]: approve with editedName, no editedDescription", async () => {
  const p = new CliApprovalPrompter(makeRl("e", "renamed-wf", ""));
  const result = await p.promptGate1(WF_PAYLOAD);
  assert.equal(result.kind, GATE1_KIND.WORKFLOW);
  assert.equal(result.decision, "approve");
  if (result.kind === GATE1_KIND.WORKFLOW && result.decision === "approve") {
    assert.equal(result.editedName, "renamed-wf");
    assert.equal(result.editedDescription, undefined);
    assert.equal(result.alwaysApprove, false);
  }
});

test("CliApprovalPrompter.promptGate1 workflow [e]: approve with editedDescription only", async () => {
  const p = new CliApprovalPrompter(makeRl("e", "", "new description"));
  const result = await p.promptGate1(WF_PAYLOAD);
  assert.equal(result.kind, GATE1_KIND.WORKFLOW);
  assert.equal(result.decision, "approve");
  if (result.kind === GATE1_KIND.WORKFLOW && result.decision === "approve") {
    assert.equal(result.editedName, undefined);
    assert.equal(result.editedDescription, "new description");
  }
});
