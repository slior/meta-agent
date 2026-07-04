import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_DECISION, GATE1_KIND, RISK_TIER, type Gate1ReviewPayload, type WorkflowGate1Payload } from "./interface.ts";
import { TieredApprovalPolicy, riskTier } from "./tiered-policy.ts";
import type { ApprovalRecord, Permissions, Tool } from "../types.ts";

function mkTool(perms: Partial<Permissions> = {}, hash = "sha256:" + "a".repeat(64)): Tool {
  return {
    code: "",
    manifest: {
      name: "t", description: "d", rationale: "r",
      inputSchema: { type: "object" }, outputShape: { type: "object" },
      permissions: {
        fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [],
        ...perms,
      },
      dependencies: [], limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
      hash, createdAt: "2026-04-21T00:00:00Z", kind: "atomic",
    },
  };
}

test("riskTier: empty permissions => low", () => {
  assert.equal(riskTier(mkTool().manifest.permissions, "/wkspc"), RISK_TIER.LOW);
});

test("riskTier: fs-write inside workspace => medium", () => {
  assert.equal(riskTier(mkTool({ fsWrite: ["/wkspc/data"] }).manifest.permissions, "/wkspc"), RISK_TIER.MEDIUM);
});

test("riskTier: fs-write outside workspace => elevated", () => {
  assert.equal(riskTier(mkTool({ fsWrite: ["/etc"] }).manifest.permissions, "/wkspc"), RISK_TIER.ELEVATED);
});

test("riskTier: any net allowlist => elevated", () => {
  assert.equal(
    riskTier(mkTool({ net: "allowlist", netAllowlist: ["api.example.com"] }).manifest.permissions, "/wkspc"),
    RISK_TIER.ELEVATED,
  );
});

test("riskTier: env var matching SECRET pattern => elevated", () => {
  assert.equal(riskTier(mkTool({ env: ["OPENAI_API_KEY"] }).manifest.permissions, "/wkspc"), RISK_TIER.ELEVATED);
});

test("checkExecution prompts (no auto-approve) when approval is null, even for low tier", async () => {
  const tool = mkTool();
  let prompts = 0;
  const prompter = {
    promptGate1: async () => { throw new Error("no"); },
    promptGate23: async () => {
      prompts++;
      return { decision: APPROVAL_DECISION.APPROVE, cacheForSession: false };
    },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc" });
  const r = await policy.checkExecution(tool, {}, null);
  assert.equal(r.decision, APPROVAL_DECISION.APPROVE);
  assert.equal(prompts, 1);
});

test("checkExecution can reject a needs-review (null-approval) tool", async () => {
  const tool = mkTool();
  const prompter = {
    promptGate1: async () => { throw new Error("no"); },
    promptGate23: async () => ({ decision: APPROVAL_DECISION.REJECT, reason: "user declined" }),
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc" });
  const r = await policy.checkExecution(tool, {}, null);
  assert.equal(r.decision, APPROVAL_DECISION.REJECT);
  assert.equal(r.reason, "user declined");
});

test("checkExecution auto-approves low with no prompt", async () => {
  const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no prompt expected"); } };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc" });
  const tool = mkTool();
  const approval: ApprovalRecord = { hash: tool.manifest.hash, approvedAt: "x", approvedBy: "u", alwaysApprove: false };
  const r = await policy.checkExecution(tool, {}, approval);
  assert.equal(r.decision, APPROVAL_DECISION.APPROVE);
});

test("checkExecution prompts on elevated; cached after alwaysApprove", async () => {
  const tool = mkTool({ net: "allowlist", netAllowlist: ["api.example.com"] });
  const approval: ApprovalRecord = { hash: tool.manifest.hash, approvedAt: "x", approvedBy: "u", alwaysApprove: true };
  let prompts = 0;
  const prompter = {
    promptGate1: async () => { throw new Error("no"); },
    promptGate23: async () => {
      prompts++;
      return { decision: APPROVAL_DECISION.APPROVE, cacheForSession: true };
    },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc" });
  const r = await policy.checkExecution(tool, {}, approval);
  assert.equal(r.decision, APPROVAL_DECISION.APPROVE);
  assert.equal(prompts, 0);
});

test("checkExecution rejects when approval hash mismatches", async () => {
  const tool = mkTool();
  const approval: ApprovalRecord = { hash: "sha256:" + "b".repeat(64), approvedAt: "x", approvedBy: "u", alwaysApprove: true };
  let reject = 0;
  const prompter = {
    promptGate1: async () => { throw new Error("no"); },
    promptGate23: async () => {
      reject++;
      return { decision: APPROVAL_DECISION.REJECT, reason: "user" };
    },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc" });
  const r = await policy.checkExecution(tool, {}, approval);
  assert.equal(r.decision, APPROVAL_DECISION.REJECT);
  assert.equal(reject, 1);
});

test("yolo mode auto-approves everything without prompting", async () => {
  const tool = mkTool({ net: "allowlist", netAllowlist: ["api.example.com"] });
  const prompter = {
    promptGate1: async () => { throw new Error("should not prompt"); },
    promptGate23: async () => { throw new Error("should not prompt"); },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc", yolo: true });
  const r = await policy.checkExecution(tool, {}, null);
  assert.equal(r.decision, APPROVAL_DECISION.APPROVE);
});

function mkCodePayload(): Gate1ReviewPayload {
  return {
    kind: GATE1_KIND.CODE,
    draft: {
      name: "t", description: "d", rationale: "r",
      inputSchema: { type: "object" }, outputShape: { type: "object" },
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      code: "export async function run(i){return i;}",
      dependencies: [], smokeTestInput: {}, kind: "atomic",
    },
    smoke: { ok: true, value: {} },
  };
}

function mkWorkflowPayload(): WorkflowGate1Payload {
  return {
    kind: GATE1_KIND.WORKFLOW,
    workflow: { schemaVersion: 1, name: "wf", description: "d", goal: "g", inputs: [], steps: [], return: null },
    manifest: {
      name: "wf", description: "d", rationale: "",
      inputSchema: { type: "object" }, outputShape: { type: "object" },
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [], limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
      hash: "sha256:" + "a".repeat(64), createdAt: "2026-01-01T00:00:00Z", kind: "workflow",
    },
    effectivePermissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    literateRendering: "Workflow wf:\n  (no steps)",
  };
}

test("reviewDraft non-yolo code: delegates to prompter with code payload", async () => {
  let received: Gate1ReviewPayload | undefined;
  const prompter = {
    promptGate1: async (p: Gate1ReviewPayload) => {
      received = p;
      return { kind: GATE1_KIND.CODE, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false };
    },
    promptGate23: async () => { throw new Error("no"); },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/w" });
  const result = await policy.reviewDraft(mkCodePayload());
  assert.equal(received?.kind, GATE1_KIND.CODE);
  assert.equal(result.kind, GATE1_KIND.CODE);
  assert.equal(result.decision, APPROVAL_DECISION.APPROVE);
});

test("reviewDraft non-yolo workflow: delegates to prompter with workflow payload", async () => {
  let received: Gate1ReviewPayload | undefined;
  const prompter = {
    promptGate1: async (p: Gate1ReviewPayload) => {
      received = p;
      return { kind: GATE1_KIND.WORKFLOW, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false };
    },
    promptGate23: async () => { throw new Error("no"); },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/w" });
  const result = await policy.reviewDraft(mkWorkflowPayload());
  assert.equal(received?.kind, GATE1_KIND.WORKFLOW);
  assert.equal(result.kind, GATE1_KIND.WORKFLOW);
  assert.equal(result.decision, APPROVAL_DECISION.APPROVE);
});

test("reviewDraft yolo code: delegates to prompter (yolo does not skip Gate 1)", async () => {
  let received: Gate1ReviewPayload | undefined;
  const prompter = {
    promptGate1: async (p: Gate1ReviewPayload) => {
      received = p;
      return { kind: GATE1_KIND.CODE, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false };
    },
    promptGate23: async () => { throw new Error("no"); },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/w", yolo: true });
  const result = await policy.reviewDraft(mkCodePayload());
  assert.equal(received?.kind, GATE1_KIND.CODE);
  assert.equal(result.kind, GATE1_KIND.CODE);
  assert.equal(result.decision, APPROVAL_DECISION.APPROVE);
});

test("reviewDraft yolo workflow: delegates to prompter (yolo does not skip Gate 1)", async () => {
  let received: Gate1ReviewPayload | undefined;
  const prompter = {
    promptGate1: async (p: Gate1ReviewPayload) => {
      received = p;
      return { kind: GATE1_KIND.WORKFLOW, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false };
    },
    promptGate23: async () => { throw new Error("no"); },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/w", yolo: true });
  const result = await policy.reviewDraft(mkWorkflowPayload());
  assert.equal(received?.kind, GATE1_KIND.WORKFLOW);
  assert.equal(result.kind, GATE1_KIND.WORKFLOW);
  assert.equal(result.decision, APPROVAL_DECISION.APPROVE);
});
