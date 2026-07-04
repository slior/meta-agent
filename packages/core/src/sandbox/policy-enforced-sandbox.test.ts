import { test } from "node:test";
import assert from "node:assert/strict";
import type { Sandbox, ExecuteOpts } from "./sandbox.ts";
import type { ApprovalPolicy } from "../approval/interface.ts";
import { APPROVAL_DECISION } from "../approval/interface.ts";
import { PolicyEnforcedSandbox } from "./policy-enforced-sandbox.ts";
import { TOOL_ERROR_KIND, type ApprovalRecord, type Tool, type ToolResult } from "../types.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";

function makeTool(name = "test-tool"): Tool {
  return {
    manifest: {
      name,
      description: "test",
      rationale: "test",
      inputSchema: {},
      outputShape: {},
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [],
      limits: { timeoutMs: 5000, maxOldSpaceSizeMb: 64 },
      hash: "sha256:abc",
      createdAt: new Date().toISOString(),
      kind: "atomic",
    },
    code: "export async function run() { return {}; }",
  };
}

function makeApprovalRecord(toolHash: string): ApprovalRecord {
  return {
    hash: toolHash,
    approvedAt: new Date().toISOString(),
    approvedBy: "test",
    alwaysApprove: false,
  };
}

function makeInnerSandbox(result: ToolResult): { sandbox: Sandbox; callCount: () => number } {
  let count = 0;
  const sandbox: Sandbox = {
    async execute(_tool, _args, _opts?: ExecuteOpts): Promise<ToolResult> {
      count++;
      return result;
    },
  };
  return { sandbox, callCount: () => count };
}

function makeApprovalPolicy(decision: "approve" | "reject"): { policy: ApprovalPolicy; callCount: () => number } {
  let count = 0;
  const policy: ApprovalPolicy = {
    yolo: false,
    async reviewDraft() { throw new Error("not used"); },
    async checkExecution(_tool, _args, _approval) {
      count++;
      if (decision === "approve") return { decision: APPROVAL_DECISION.APPROVE, cacheForSession: false };
      return { decision: APPROVAL_DECISION.REJECT, reason: "denied by test policy" };
    },
  };
  return { policy, callCount: () => count };
}

function makeRegistry(approvalRecord: ApprovalRecord | null): ToolRegistry {
  return {
    async getApproval(_name: string) { return approvalRecord; },
    async list() { return []; },
    listSync() { return []; },
    async get(_name: string) { return null; },
    async save() {},
    async delete() {},
    async getDependents(_name: string) { return []; },
    async has(_name: string) { return false; },
    rootDir() { return ""; },
    async getWorkflow(_name: string) { return null; },
  };
}

test("PolicyEnforcedSandbox: calls checkExecution before delegating to inner sandbox", async () => {
  const tool = makeTool();
  const record = makeApprovalRecord(tool.manifest.hash);
  const { sandbox: inner, callCount: innerCalls } = makeInnerSandbox({ ok: true, value: "result" });
  const { policy, callCount: policyCalls } = makeApprovalPolicy("approve");
  const registry = makeRegistry(record);

  const sandbox = new PolicyEnforcedSandbox(inner, policy, registry);
  const result = await sandbox.execute(tool, { x: 1 });

  assert.equal(policyCalls(), 1, "checkExecution should be called once");
  assert.equal(innerCalls(), 1, "inner sandbox should be called once");
  assert.deepEqual(result, { ok: true, value: "result" });
});

test("PolicyEnforcedSandbox: returns rejected_by_user error without calling inner sandbox when policy rejects", async () => {
  const tool = makeTool();
  const record = makeApprovalRecord(tool.manifest.hash);
  const { sandbox: inner, callCount: innerCalls } = makeInnerSandbox({ ok: true, value: "should not reach" });
  const { policy } = makeApprovalPolicy("reject");
  const registry = makeRegistry(record);

  const sandbox = new PolicyEnforcedSandbox(inner, policy, registry);
  const result = await sandbox.execute(tool, {});

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === TOOL_ERROR_KIND.REJECTED_BY_USER);
  assert.ok(!result.ok && result.error.message.includes("denied by test policy"));
  assert.equal(innerCalls(), 0, "inner sandbox must NOT be called after rejection");
});

test("PolicyEnforcedSandbox: passes opts through to inner sandbox on approval", async () => {
  const tool = makeTool();
  const record = makeApprovalRecord(tool.manifest.hash);
  let capturedOpts: ExecuteOpts | undefined;
  const inner: Sandbox = {
    async execute(_tool, _args, opts?: ExecuteOpts) {
      capturedOpts = opts;
      return { ok: true, value: null };
    },
  };
  const { policy } = makeApprovalPolicy("approve");
  const registry = makeRegistry(record);

  const onInvokeTool = async () => ({ ok: true as const, value: "sub" });
  const sandbox = new PolicyEnforcedSandbox(inner, policy, registry);
  await sandbox.execute(tool, {}, { onInvokeTool, depth: 1 });

  assert.equal(capturedOpts?.depth, 1);
  assert.equal(capturedOpts?.onInvokeTool, onInvokeTool);
});

test("PolicyEnforcedSandbox: passes null approvalRecord to checkExecution when registry has no record", async () => {
  const tool = makeTool();
  let capturedRecord: ApprovalRecord | null = makeApprovalRecord("sentinel");
  const inner: Sandbox = { async execute() { return { ok: true, value: null }; } };
  const policy: ApprovalPolicy = {
    yolo: false,
    async reviewDraft() { throw new Error("not used"); },
    async checkExecution(_t, _a, approval) {
      capturedRecord = approval;
      return { decision: APPROVAL_DECISION.APPROVE, cacheForSession: false };
    },
  };
  const registry = makeRegistry(null);

  const sandbox = new PolicyEnforcedSandbox(inner, policy, registry);
  await sandbox.execute(tool, {});

  assert.equal(capturedRecord, null, "null record should be forwarded to checkExecution");
});

test("PolicyEnforcedSandbox: throws when inner sandbox is null", () => {
  const { policy } = makeApprovalPolicy("approve");
  const registry = makeRegistry(null);
  assert.throws(
    () => new PolicyEnforcedSandbox(null as unknown as Sandbox, policy, registry),
    /inner sandbox is required/,
  );
});

test("PolicyEnforcedSandbox: throws when approval policy is null", () => {
  const { sandbox: inner } = makeInnerSandbox({ ok: true, value: null });
  const registry = makeRegistry(null);
  assert.throws(
    () => new PolicyEnforcedSandbox(inner, null as unknown as ApprovalPolicy, registry),
    /approval policy is required/,
  );
});

test("PolicyEnforcedSandbox: throws when tool registry is null", () => {
  const { sandbox: inner } = makeInnerSandbox({ ok: true, value: null });
  const { policy } = makeApprovalPolicy("approve");
  assert.throws(
    () => new PolicyEnforcedSandbox(inner, policy, null as unknown as ToolRegistry),
    /tool registry is required/,
  );
});
