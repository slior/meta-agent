import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(riskTier(mkTool().manifest.permissions, "/wkspc"), "low");
});

test("riskTier: fs-write inside workspace => medium", () => {
  assert.equal(riskTier(mkTool({ fsWrite: ["/wkspc/data"] }).manifest.permissions, "/wkspc"), "medium");
});

test("riskTier: fs-write outside workspace => elevated", () => {
  assert.equal(riskTier(mkTool({ fsWrite: ["/etc"] }).manifest.permissions, "/wkspc"), "elevated");
});

test("riskTier: any net allowlist => elevated", () => {
  assert.equal(riskTier(mkTool({ net: "allowlist", netAllowlist: ["api.example.com"] }).manifest.permissions, "/wkspc"), "elevated");
});

test("riskTier: env var matching SECRET pattern => elevated", () => {
  assert.equal(riskTier(mkTool({ env: ["OPENAI_API_KEY"] }).manifest.permissions, "/wkspc"), "elevated");
});

test("checkExecution auto-approves low with no prompt", async () => {
  const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no prompt expected"); } };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc" });
  const tool = mkTool();
  const approval: ApprovalRecord = { hash: tool.manifest.hash, approvedAt: "x", approvedBy: "u", alwaysApprove: false };
  const r = await policy.checkExecution(tool, {}, approval);
  assert.equal(r.decision, "approve");
});

test("checkExecution prompts on elevated; cached after alwaysApprove", async () => {
  const tool = mkTool({ net: "allowlist", netAllowlist: ["api.example.com"] });
  const approval: ApprovalRecord = { hash: tool.manifest.hash, approvedAt: "x", approvedBy: "u", alwaysApprove: true };
  let prompts = 0;
  const prompter = {
    promptGate1: async () => { throw new Error("no"); },
    promptGate23: async () => { prompts++; return { decision: "approve" as const, token: "tok", cacheForSession: true }; },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc" });
  const r = await policy.checkExecution(tool, {}, approval);
  assert.equal(r.decision, "approve");
  assert.equal(prompts, 0);
});

test("checkExecution rejects when approval hash mismatches", async () => {
  const tool = mkTool();
  const approval: ApprovalRecord = { hash: "sha256:" + "b".repeat(64), approvedAt: "x", approvedBy: "u", alwaysApprove: true };
  let reject = 0;
  const prompter = {
    promptGate1: async () => { throw new Error("no"); },
    promptGate23: async () => { reject++; return { decision: "reject" as const, reason: "user" }; },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc" });
  const r = await policy.checkExecution(tool, {}, approval);
  assert.equal(r.decision, "reject");
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
  assert.equal(r.decision, "approve");
});
