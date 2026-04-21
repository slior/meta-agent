import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./agent-loop.ts";
import { MockLLMProvider } from "../llm/mock-provider.ts";
import { FsToolRegistry } from "../registry/fs-registry.ts";
import { HybridToolIndex } from "../index-store/hybrid-index.ts";
import { NodePermissionSandbox } from "../sandbox/node-permission-sandbox.ts";
import { TieredApprovalPolicy } from "../approval/tiered-policy.ts";
import { Tracer } from "../tracer.ts";
import { ToolFactory } from "../factory/factory.ts";
import type { ChatResponse } from "../llm/interface.ts";

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
      .onChat(() => asst(null, [{ id: "2", name: "stop", args: { reason: "done" } }]));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("search something");
    assert.equal(out, "done");
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
