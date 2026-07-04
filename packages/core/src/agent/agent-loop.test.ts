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
import { PolicyEnforcedSandbox } from "../sandbox/policy-enforced-sandbox.ts";
import { TieredApprovalPolicy } from "../approval/tiered-policy.ts";
import { APPROVAL_DECISION, type ApprovalPolicy, type Gate1ReviewPayload } from "../approval/interface.ts";
import { TRACE_KIND_EXECUTION_DENIED, TRACE_KIND_TOOL_INVOKED, Tracer, type TraceEvent } from "../tracer.ts";
import { ToolFactory } from "../factory/factory.ts";
import { CHAT_ROLE, CHAT_TOOL_TYPE, type ChatResponse } from "../llm/LLMProvider.ts";
import { META_FN } from "./meta-tools.ts";
import { makeConsistentApproval, makeConsistentTool } from "../testing/tool-fixtures.ts";
import { TOOL_ERROR_KIND, type ApprovalRecord, type Tool } from "../types.ts";

const SAMPLE_BODY = "export async function run(i){return i;}";

function sampleTool(name: string) {
  return makeConsistentTool(
    {
      name,
      description: `desc of ${name}`,
      rationale: "r",
      inputSchema: { type: "object" },
      outputShape: { type: "object" },
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [],
      limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
      createdAt: "2026-04-21T00:00:00Z",
      kind: "atomic",
    },
    SAMPLE_BODY,
  );
}

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
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider().onChat(() => asst("hello!"));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });

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
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "1", name: META_FN.findTool, args: { query: "doesn't matter" } }]))
      .onChat(() => asst(null, [{ id: "2", name: META_FN.stop, args: { reason: "done" } }]))
      .onChat(() => asst("synthesized for user"));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });

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
    const alpha = sampleTool("alpha");
    await registry.save(alpha, makeConsistentApproval(alpha));
    const index = await HybridToolIndex.open(registry);
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "1", name: META_FN.findTool, args: { query: "alpha" } }]))
      .onChat(() => asst(null, [{ id: "2", name: META_FN.stop, args: { reason: "done" } }]))
      .onChat(() => asst("ok"));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });

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
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
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
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });

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
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "1", name: META_FN.findTool, args: { query: "x" } }]))
      .onChat(() => asst(null, [{ id: "2", name: META_FN.stop, args: { reason: "fallback reason" } }]))
      .onChat(() => asst(null));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });

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
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "s1", name: META_FN.stop, args: { reason: "direct stop" } }]));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });

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
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() =>
        asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "missing-tool", args: {} } }]),
      )
      .onChat(() => asst("recovered"));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });

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
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "f1", name: META_FN.findTool, args: { query: "anything" } }]))
      .onChat(() => asst("done"));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });

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

const DOUBLE_CODE = `export async function run(input) { return input.n * 2; }`;
const DOUBLE_TOOL_FOR_WF = makeConsistentTool(
  {
    name: "double",
    description: "Doubles a number",
    rationale: "Basic math",
    inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    outputShape: { type: "number" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 5000, maxOldSpaceSizeMb: 64 },
    createdAt: "2026-01-01T00:00:00Z",
    kind: "atomic",
  },
  DOUBLE_CODE,
);

const FETCH_AND_DOUBLE_BODY = JSON.stringify({
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
});
const FETCH_AND_DOUBLE_TOOL = makeConsistentTool(
  {
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
    createdAt: "2026-01-01T00:00:00Z",
    kind: "workflow",
  },
  FETCH_AND_DOUBLE_BODY,
);

test("agent: workflow inputSchema — missing required field yields schema_violation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-wf-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    await registry.save(DOUBLE_TOOL_FOR_WF, makeConsistentApproval(DOUBLE_TOOL_FOR_WF));
    await registry.save(FETCH_AND_DOUBLE_TOOL, makeConsistentApproval(FETCH_AND_DOUBLE_TOOL));
    const index = await HybridToolIndex.open(registry);
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "fetch-and-double", args: {} } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });
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
    await registry.save(DOUBLE_TOOL_FOR_WF, makeConsistentApproval(DOUBLE_TOOL_FOR_WF));
    await registry.save(FETCH_AND_DOUBLE_TOOL, makeConsistentApproval(FETCH_AND_DOUBLE_TOOL));
    const index = await HybridToolIndex.open(registry);
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "fetch-and-double", args: { url: "http://example.com", extra: "bad" } } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });
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
    await registry.save(DOUBLE_TOOL_FOR_WF, makeConsistentApproval(DOUBLE_TOOL_FOR_WF));
    await registry.save(FETCH_AND_DOUBLE_TOOL, makeConsistentApproval(FETCH_AND_DOUBLE_TOOL));
    const index = await HybridToolIndex.open(registry);
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "fetch-and-double", args: { url: "http://example.com" } } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });
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

const CLOSED_WF_BODY = JSON.stringify({
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
});
const CLOSED_WF_TOOL = makeConsistentTool(
  {
    name: "closed-workflow",
    description: "Test workflow with no declared parameters",
    rationale: "test closed workflow",
    inputSchema: {},
    outputShape: { type: "number" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: ["double"],
    limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    createdAt: "2026-01-01T00:00:00Z",
    kind: "workflow",
  },
  CLOSED_WF_BODY,
);

test("agent: workflow inputSchema — closed workflow (inputSchema: {}) accepts any input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-wf-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    await registry.save(DOUBLE_TOOL_FOR_WF, makeConsistentApproval(DOUBLE_TOOL_FOR_WF));
    await registry.save(CLOSED_WF_TOOL, makeConsistentApproval(CLOSED_WF_TOOL));
    const index = await HybridToolIndex.open(registry);
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "closed-workflow", args: { url: "https://x" } } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });
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

// ─── workflow approval gate tests ─────────────────────────────────────────────

/**
 * Builds a mock ApprovalPolicy whose `checkExecution` records every tool name it
 * was called with, and optionally rejects a specific tool by name.
 */
function makeTrackingPolicy(rejectName?: string): { policy: ApprovalPolicy; checkedNames: string[] } {
  const checkedNames: string[] = [];
  const policy: ApprovalPolicy = {
    yolo: false,
    reviewDraft: async (_payload: Gate1ReviewPayload) => { throw new Error("reviewDraft should not be called"); },
    async checkExecution(tool: Tool, _args: unknown, _approval: ApprovalRecord | null) {
      checkedNames.push(tool.manifest.name);
      if (tool.manifest.name === rejectName) {
        return { decision: APPROVAL_DECISION.REJECT, reason: "test rejection" };
      }
      return { decision: APPROVAL_DECISION.APPROVE, cacheForSession: false };
    },
  };
  return { policy, checkedNames };
}

test("agent: workflow wrapper checkExecution is called before executor runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-wf-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    await registry.save(DOUBLE_TOOL_FOR_WF, makeConsistentApproval(DOUBLE_TOOL_FOR_WF));
    await registry.save(FETCH_AND_DOUBLE_TOOL, makeConsistentApproval(FETCH_AND_DOUBLE_TOOL));
    const index = await HybridToolIndex.open(registry);
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const { policy, checkedNames } = makeTrackingPolicy();
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, policy, registry);
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "fetch-and-double", args: { url: "http://example.com" } } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval: policy, tracer, tombstoned: new Set() });
    const loop = new AgentLoop({ llm, registry, index, sandbox, approval: policy, factory, tracer });
    await loop.run("run the workflow");
    // The workflow wrapper must be checked first, then the step tool.
    assert.ok(checkedNames.includes("fetch-and-double"), "checkExecution must be called for the workflow wrapper");
    assert.ok(checkedNames.includes("double"), "checkExecution must be called for the step tool");
    assert.equal(checkedNames[0], "fetch-and-double", "workflow wrapper approval checked before step tools");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: rejected workflow wrapper returns rejected_by_user without running steps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-wf-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    await registry.save(DOUBLE_TOOL_FOR_WF, makeConsistentApproval(DOUBLE_TOOL_FOR_WF));
    await registry.save(FETCH_AND_DOUBLE_TOOL, makeConsistentApproval(FETCH_AND_DOUBLE_TOOL));
    const index = await HybridToolIndex.open(registry);
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const { policy, checkedNames } = makeTrackingPolicy("fetch-and-double");
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, policy, registry);
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "fetch-and-double", args: { url: "http://example.com" } } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval: policy, tracer, tombstoned: new Set() });
    const loop = new AgentLoop({ llm, registry, index, sandbox, approval: policy, factory, tracer });
    await loop.run("run the workflow");
    const secondReq = llm.calls.chat[1];
    assert.ok(secondReq);
    const toolMsg = secondReq.messages.find((m) => m.role === CHAT_ROLE.tool);
    assert.ok(toolMsg, "expected a tool message in the second chat call");
    const parsed = JSON.parse(toolMsg.content as string) as { ok: boolean; error?: { kind: string } };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error?.kind, TOOL_ERROR_KIND.REJECTED_BY_USER);
    // The step tool must never have been checked — executor never ran.
    assert.ok(!checkedNames.includes("double"), "step tool must not be checked when wrapper is rejected");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: workflow wrapper emits tool-invoked and not execution-denied on success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-wf-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    await registry.save(DOUBLE_TOOL_FOR_WF, makeConsistentApproval(DOUBLE_TOOL_FOR_WF));
    await registry.save(FETCH_AND_DOUBLE_TOOL, makeConsistentApproval(FETCH_AND_DOUBLE_TOOL));
    const index = await HybridToolIndex.open(registry);
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const captured: TraceEvent[] = [];
    const tracer = await Tracer.open(join(dir, "traces"), "s", { observers: [(e) => captured.push(e)] });
    const { policy } = makeTrackingPolicy();
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, policy, registry);
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "fetch-and-double", args: { url: "http://example.com" } } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval: policy, tracer, tombstoned: new Set() });
    const loop = new AgentLoop({ llm, registry, index, sandbox, approval: policy, factory, tracer });
    await loop.run("run the workflow");
    const wrapperInvoked = captured.find(
      (e) => e.kind === TRACE_KIND_TOOL_INVOKED && e.data["name"] === "fetch-and-double",
    );
    assert.ok(wrapperInvoked, "tool-invoked trace event must be emitted for the workflow wrapper");
    const deniedEvents = captured.filter((e) => e.kind === TRACE_KIND_EXECUTION_DENIED);
    assert.equal(deniedEvents.length, 0, "no execution-denied events on a successful run");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: rejected workflow wrapper emits execution-denied trace event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-wf-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    await registry.save(DOUBLE_TOOL_FOR_WF, makeConsistentApproval(DOUBLE_TOOL_FOR_WF));
    await registry.save(FETCH_AND_DOUBLE_TOOL, makeConsistentApproval(FETCH_AND_DOUBLE_TOOL));
    const index = await HybridToolIndex.open(registry);
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const captured: TraceEvent[] = [];
    const tracer = await Tracer.open(join(dir, "traces"), "s", { observers: [(e) => captured.push(e)] });
    const { policy } = makeTrackingPolicy("fetch-and-double");
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, policy, registry);
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "fetch-and-double", args: { url: "http://example.com" } } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval: policy, tracer, tombstoned: new Set() });
    const loop = new AgentLoop({ llm, registry, index, sandbox, approval: policy, factory, tracer });
    await loop.run("run the workflow");
    const denied = captured.find(
      (e) => e.kind === TRACE_KIND_EXECUTION_DENIED && e.data["name"] === "fetch-and-double",
    );
    assert.ok(denied, "execution-denied trace event must be emitted when workflow wrapper is rejected");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: workflow wrapper calls onToolInvoked at depth 0 on success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-wf-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    await registry.save(DOUBLE_TOOL_FOR_WF, makeConsistentApproval(DOUBLE_TOOL_FOR_WF));
    await registry.save(FETCH_AND_DOUBLE_TOOL, makeConsistentApproval(FETCH_AND_DOUBLE_TOOL));
    const index = await HybridToolIndex.open(registry);
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const { policy } = makeTrackingPolicy();
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, policy, registry);
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "inv1", name: META_FN.invokeTool, args: { name: "fetch-and-double", args: { url: "http://example.com" } } }]))
      .onChat(() => asst("done"));
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval: policy, tracer, tombstoned: new Set() });
    const invokedNames: string[] = [];
    const loop = new AgentLoop({
      llm, registry, index, sandbox, approval: policy, factory, tracer,
      onToolInvoked: (ev) => invokedNames.push(ev.name),
    });
    await loop.run("run the workflow");
    assert.ok(invokedNames.includes("fetch-and-double"), "onToolInvoked must fire for the workflow wrapper");
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
    const innerSandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "1", name: META_FN.proposeNewTool, args: { intent: "i", rationale: "r" } }]))
      .onChat(() => asst("I was told to find first."));
    const prompter = { promptGate1: async () => { throw new Error("no prompt expected"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("do it");
    assert.match(out, /find first/);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
