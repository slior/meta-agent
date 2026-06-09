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
import { CHAT_ROLE, CHAT_TOOL_TYPE, type ChatResponse } from "../llm/LLMProvider.ts";
import { META_FN } from "./meta-tools.ts";
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
      role: CHAT_ROLE.assistant,
      content,
      ...(toolCalls
        ? {
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: CHAT_TOOL_TYPE.function,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
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
      .onChat(() => asst(null, [{ id: "1", name: META_FN.findTool, args: { query: "doesn't matter" } }]))
      .onChat(() => asst(null, [{ id: "2", name: META_FN.stop, args: { reason: "done" } }]))
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
      !JSON.stringify(secondReq.messages).includes(`${META_FN.invokeTool}_recovery_hint`),
      "no recovery user line when invoke_tool did not fail",
    );
    const emptyFindMsg = secondReq.messages.find(
      (m) =>
        m.role === CHAT_ROLE.user &&
        typeof m.content === "string" &&
        m.content.includes(`${META_FN.findTool}_empty_recovery_hint`),
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
      .onChat(() => asst(null, [{ id: "1", name: META_FN.findTool, args: { query: "alpha" } }]))
      .onChat(() => asst(null, [{ id: "2", name: META_FN.stop, args: { reason: "done" } }]))
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
      !JSON.stringify(secondReq.messages).includes(`${META_FN.findTool}_empty_recovery_hint`),
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
        { id: "t1", name: META_FN.findTool, args: { query: "anything" } },
        { id: "t2", name: META_FN.stop, args: { reason: "ignored early reason" } },
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
      .onChat(() => asst(null, [{ id: "1", name: META_FN.findTool, args: { query: "x" } }]))
      .onChat(() => asst(null, [{ id: "2", name: META_FN.stop, args: { reason: "fallback reason" } }]))
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
      .onChat(() => asst(null, [{ id: "s1", name: META_FN.stop, args: { reason: "direct stop" } }]));
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
        asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "missing-tool", args: {} } }]),
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
      (m) =>
        m.role === CHAT_ROLE.user &&
        typeof m.content === "string" &&
        m.content.includes(`${META_FN.invokeTool}_recovery_hint`),
    );
    assert.ok(hasRecovery, "second llm.chat should include synthetic recovery user message");
    const recoveryMsg = secondReq.messages.find(
      (m) =>
        m.role === CHAT_ROLE.user &&
        typeof m.content === "string" &&
        m.content.includes(`${META_FN.invokeTool}_recovery_hint`),
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
      .onChat(() => asst(null, [{ id: "f1", name: META_FN.findTool, args: { query: "anything" } }]))
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
      (m) =>
        m.role === CHAT_ROLE.user &&
        typeof m.content === "string" &&
        m.content.includes(`${META_FN.findTool}_empty_recovery_hint`),
    );
    assert.equal(recoveryMsg?.content, EMPTY_FIND_RECOVERY_USER);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── workflow inputSchema validation tests ────────────────────────────────────

const DOUBLE_HASH = "sha256:" + "d".repeat(64);
const WF_HASH = "sha256:" + "w".repeat(64);

const DOUBLE_TOOL_FOR_WF: Tool = {
  manifest: {
    name: "double",
    description: "Doubles a number",
    rationale: "Basic math",
    inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    outputShape: { type: "number" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 5000, maxOldSpaceSizeMb: 64 },
    hash: DOUBLE_HASH,
    createdAt: "2026-01-01T00:00:00Z",
    kind: "atomic",
  },
  code: `export async function run(input) { return input.n * 2; }`,
};

const DOUBLE_APPROVAL_FOR_WF: ApprovalRecord = {
  hash: DOUBLE_HASH,
  approvedAt: "2026-01-01T00:00:00Z",
  approvedBy: "test",
  alwaysApprove: false,
};

const FETCH_AND_DOUBLE_TOOL: Tool = {
  manifest: {
    name: "fetch-and-double",
    description: "Test workflow with required url parameter",
    rationale: "test workflow",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
    outputShape: { type: "number" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: ["double"],
    limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    hash: WF_HASH,
    createdAt: "2026-01-01T00:00:00Z",
    kind: "workflow",
  },
  code: JSON.stringify({
    schemaVersion: 1,
    name: "fetch-and-double",
    description: "Test workflow",
    goal: "test",
    inputs: [{ name: "url", schema: { type: "string" }, required: true }],
    steps: [
      {
        kind: "tool_call",
        label: "step1",
        tool: "double",
        arguments: { n: { kind: "literal", value: 2 } },
        resultBinding: "result",
      },
    ],
    return: { source: { kind: "symref", ref: "result" } },
  }),
};

const FETCH_AND_DOUBLE_APPROVAL: ApprovalRecord = {
  hash: WF_HASH,
  approvedAt: "2026-01-01T00:00:00Z",
  approvedBy: "test",
  alwaysApprove: false,
};

test("agent: workflow inputSchema — missing required field yields schema_violation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-wf-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    await registry.save(DOUBLE_TOOL_FOR_WF, DOUBLE_APPROVAL_FOR_WF);
    await registry.save(FETCH_AND_DOUBLE_TOOL, FETCH_AND_DOUBLE_APPROVAL);
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "fetch-and-double", args: {} } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });
    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    await loop.run("run the workflow without url");
    const secondReq = llm.calls.chat[1];
    assert.ok(secondReq);
    const toolMsg = secondReq.messages.find((m) => m.role === CHAT_ROLE.tool);
    assert.ok(toolMsg, "expected a tool message in the second chat call");
    const parsed = JSON.parse(toolMsg.content as string) as { ok: boolean; error?: { kind: string } };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error?.kind, "schema_violation");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: workflow inputSchema — unknown key rejected when additionalProperties:false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-wf-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    await registry.save(DOUBLE_TOOL_FOR_WF, DOUBLE_APPROVAL_FOR_WF);
    await registry.save(FETCH_AND_DOUBLE_TOOL, FETCH_AND_DOUBLE_APPROVAL);
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "fetch-and-double", args: { url: "http://example.com", extra: "bad" } } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });
    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    await loop.run("run the workflow with extra key");
    const secondReq = llm.calls.chat[1];
    assert.ok(secondReq);
    const toolMsg = secondReq.messages.find((m) => m.role === CHAT_ROLE.tool);
    assert.ok(toolMsg, "expected a tool message in the second chat call");
    const parsed = JSON.parse(toolMsg.content as string) as { ok: boolean; error?: { kind: string } };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error?.kind, "schema_violation");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: workflow inputSchema — valid input dispatches to executor successfully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-wf-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    await registry.save(DOUBLE_TOOL_FOR_WF, DOUBLE_APPROVAL_FOR_WF);
    await registry.save(FETCH_AND_DOUBLE_TOOL, FETCH_AND_DOUBLE_APPROVAL);
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "fetch-and-double", args: { url: "http://example.com" } } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });
    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    await loop.run("run the workflow with valid url");
    const secondReq = llm.calls.chat[1];
    assert.ok(secondReq);
    const toolMsg = secondReq.messages.find((m) => m.role === CHAT_ROLE.tool);
    assert.ok(toolMsg, "expected a tool message in the second chat call");
    const parsed = JSON.parse(toolMsg.content as string) as { ok: boolean; error?: { kind: string } };
    assert.equal(parsed.ok, true, `expected ok:true but got: ${JSON.stringify(parsed)}`);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const CLOSED_WF_HASH = "sha256:" + "c".repeat(64);

const CLOSED_WF_TOOL: Tool = {
  manifest: {
    name: "closed-workflow",
    description: "Test workflow with no declared parameters",
    rationale: "test closed workflow",
    inputSchema: {},
    outputShape: { type: "number" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: ["double"],
    limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    hash: CLOSED_WF_HASH,
    createdAt: "2026-01-01T00:00:00Z",
    kind: "workflow",
  },
  code: JSON.stringify({
    schemaVersion: 1,
    name: "closed-workflow",
    description: "Test closed workflow",
    goal: "test",
    inputs: [],
    steps: [
      {
        kind: "tool_call",
        label: "step1",
        tool: "double",
        arguments: { n: { kind: "literal", value: 3 } },
        resultBinding: "result",
      },
    ],
    return: { source: { kind: "symref", ref: "result" } },
  }),
};

const CLOSED_WF_APPROVAL: ApprovalRecord = {
  hash: CLOSED_WF_HASH,
  approvedAt: "2026-01-01T00:00:00Z",
  approvedBy: "test",
  alwaysApprove: false,
};

test("agent: workflow inputSchema — closed workflow (inputSchema: {}) accepts any input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-wf-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    await registry.save(DOUBLE_TOOL_FOR_WF, DOUBLE_APPROVAL_FOR_WF);
    await registry.save(CLOSED_WF_TOOL, CLOSED_WF_APPROVAL);
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "closed-workflow", args: { url: "https://x" } } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });
    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    await loop.run("run the closed workflow with extra args");
    const secondReq = llm.calls.chat[1];
    assert.ok(secondReq);
    const toolMsg = secondReq.messages.find((m) => m.role === CHAT_ROLE.tool);
    assert.ok(toolMsg, "expected a tool message in the second chat call");
    const parsed = JSON.parse(toolMsg.content as string) as { ok: boolean; error?: { kind: string } };
    assert.equal(parsed.ok, true, `expected ok:true but got: ${JSON.stringify(parsed)}`);
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
      .onChat(() => asst(null, [{ id: "1", name: META_FN.proposeNewTool, args: { intent: "i", rationale: "r" } }]))
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
