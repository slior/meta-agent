import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop, EMPTY_FIND_RECOVERY_USER, INVOKE_FAILURE_RECOVERY_USER } from "./agent-loop.ts";
import { MockLLMProvider } from "../llm/mock-provider.ts";
import { FsToolRegistry } from "../registry/fs-registry.ts";
import { HybridToolIndex } from "../index-store/hybrid-index.ts";
import { NodePermissionSandbox } from "../sandbox/node-permission-sandbox.ts";
import { TieredApprovalPolicy } from "../approval/tiered-policy.ts";
import { Tracer } from "../tracer.ts";
import { ToolFactory } from "../factory/factory.ts";
import type { ChatResponse } from "../llm/interface.ts";
import type { ApprovalRecord, Tool } from "../types.ts";

const SAMPLE_HASH = "sha256:" + "a".repeat(64);

function sampleTool(name: string): Tool {
  return {
    code: "export async function run(i){return i;}",
    manifest: {
      name,
      description: `desc of ${name}`,
      rationale: "r",
      inputSchema: { type: "object" },
      outputShape: { type: "object" },
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [],
      limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
      hash: SAMPLE_HASH,
      createdAt: "2026-04-21T00:00:00Z",
      kind: "atomic",
    },
  };
}

const sampleApproval: ApprovalRecord = {
  hash: SAMPLE_HASH,
  approvedAt: "2026-04-21T00:00:00Z",
  approvedBy: "test",
  alwaysApprove: false,
};

function asst(content: string | null, toolCalls?: Array<{ id: string; name: string; args: unknown }>): ChatResponse {
  return {
    message: {
      role: "assistant",
      content,
      ...(toolCalls
        ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
        : {}),
    },
  };
}

test("agent: plain chat turn returns content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider().onChat(() => asst("hello!"));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("hi");
    assert.equal(out, "hello!");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: find_tool then stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "1", name: "find_tool", args: { query: "doesn't matter" } }]))
      .onChat(() => asst(null, [{ id: "2", name: "stop", args: { reason: "done" } }]))
      .onChat(() => asst("synthesized for user"));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("search something");
    assert.equal(out, "synthesized for user");
    const secondReq = llm.calls.chat[1];
    assert.ok(secondReq);
    assert.ok(
      !JSON.stringify(secondReq.messages).includes("invoke_tool_recovery_hint"),
      "no recovery user line when invoke_tool did not fail",
    );
    const emptyFindMsg = secondReq.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("find_tool_empty_recovery_hint"),
    );
    assert.equal(emptyFindMsg?.content, EMPTY_FIND_RECOVERY_USER);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: find_tool with hits does not inject empty-find recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    await registry.save(sampleTool("alpha"), sampleApproval);
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "1", name: "find_tool", args: { query: "alpha" } }]))
      .onChat(() => asst(null, [{ id: "2", name: "stop", args: { reason: "done" } }]))
      .onChat(() => asst("ok"));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("task");
    assert.equal(out, "ok");
    const secondReq = llm.calls.chat[1];
    assert.ok(secondReq);
    assert.ok(
      !JSON.stringify(secondReq.messages).includes("find_tool_empty_recovery_hint"),
      "no empty-find nudge when find_tool returned matches",
    );
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: stop batched with other tools is deferred — next turn answer used", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      // Turn 0: both find_tool and stop in the same assistant message.
      // stop.reason is "ignored" because the model hasn't seen tool results yet.
      .onChat(() => asst(null, [
        { id: "t1", name: "find_tool", args: { query: "anything" } },
        { id: "t2", name: "stop", args: { reason: "ignored early reason" } },
      ]))
      // Turn 1: after all tool messages are appended, the LLM produces a grounded answer.
      .onChat(() => asst("grounded answer after tools"));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("do something");
    // Must NOT return "ignored early reason"; must use the follow-up content.
    assert.equal(out, "grounded answer after tools");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: synthesis falls back to stop.reason when content empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "1", name: "find_tool", args: { query: "x" } }]))
      .onChat(() => asst(null, [{ id: "2", name: "stop", args: { reason: "fallback reason" } }]))
      .onChat(() => asst(null));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("q");
    assert.equal(out, "fallback reason");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: stop alone (not batched) still returns stop reason immediately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "s1", name: "stop", args: { reason: "direct stop" } }]));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("stop now");
    assert.equal(out, "direct stop");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: failed invoke_tool injects recovery user before next chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() =>
        asst(null, [{ id: "inv1", name: "invoke_tool", args: { name: "missing-tool", args: {} } }]),
      )
      .onChat(() => asst("recovered"));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("run missing tool");
    assert.equal(out, "recovered");
    const secondReq = llm.calls.chat[1];
    assert.ok(secondReq);
    const hasRecovery = secondReq.messages.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("invoke_tool_recovery_hint"),
    );
    assert.ok(hasRecovery, "second llm.chat should include synthetic recovery user message");
    const recoveryMsg = secondReq.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("invoke_tool_recovery_hint"),
    );
    assert.equal(recoveryMsg?.content, INVOKE_FAILURE_RECOVERY_USER);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: empty find_tool injects recovery user before next chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "f1", name: "find_tool", args: { query: "anything" } }]))
      .onChat(() => asst("done"));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("search");
    assert.equal(out, "done");
    const secondReq = llm.calls.chat[1];
    assert.ok(secondReq);
    const recoveryMsg = secondReq.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("find_tool_empty_recovery_hint"),
    );
    assert.equal(recoveryMsg?.content, EMPTY_FIND_RECOVERY_USER);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: propose_new_tool requires find_tool first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "1", name: "propose_new_tool", args: { intent: "i", rationale: "r" } }]))
      .onChat(() => asst("I was told to find first."));
    const prompter = { promptGate1: async () => { throw new Error("no prompt expected"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("do it");
    assert.match(out, /find first/);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
