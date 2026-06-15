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
import { hashTool } from "../hash.ts";
import { CHAT_ROLE, CHAT_TOOL_TYPE, type ChatResponse } from "../llm/LLMProvider.ts";
import { META_FN } from "./meta-tools.ts";
import type { ApprovalRecord, Tool } from "../types.ts";

function toolWith(name: string, code: string): { tool: Tool; approval: ApprovalRecord } {
  const manifestNoHash = {
    name, description: `desc ${name}`, rationale: "r",
    inputSchema: { type: "object" as const }, outputShape: {},
    permissions: { fsRead: [], fsWrite: [], net: "none" as const, netAllowlist: [], env: [] },
    dependencies: [], limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    createdAt: "2026-04-21T00:00:00Z", kind: "atomic" as const,
  };
  const hash = hashTool(code, manifestNoHash);
  return {
    tool: { code, manifest: { ...manifestNoHash, hash } },
    approval: { hash, approvedAt: "2026-04-21T00:00:00Z", approvedBy: "test", alwaysApprove: true },
  };
}

function asst(content: string | null, toolCalls?: Array<{ id: string; name: string; args: unknown }>): ChatResponse {
  return {
    message: {
      role: CHAT_ROLE.assistant, content,
      ...(toolCalls ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: CHAT_TOOL_TYPE.function, function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
    },
  };
}

test("agent passes a $ref to a later tool; recorded args keep the sentinel, tool sees resolved value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ref-flow-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const fetch = toolWith("fetch", `export async function run(){ return { text: "FULL BODY TEXT", title: "T" }; }`);
    const summarize = toolWith("summarize", `export async function run(i){ return i; }`);
    await registry.save(fetch.tool, fetch.approval);
    await registry.save(summarize.tool, summarize.approval);
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm: new MockLLMProvider(), registry, sandbox, approval, tracer, tombstoned: new Set() });

    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "c1", name: META_FN.invokeTool, args: { name: "fetch", args: {} } }]))
      .onChat(() => asst(null, [{ id: "c2", name: META_FN.invokeTool, args: { name: "summarize", args: { input: { $ref: "r_0_fetch", path: "text" } } } }]))
      .onChat(() => asst(null, [{ id: "c3", name: META_FN.stop, args: { reason: "done" } }]))
      .onChat(() => asst("done"));

    const invocations: Array<{ name: string; args: unknown; binding?: string; value?: unknown }> = [];
    const agent = new AgentLoop({
      llm, registry, index, sandbox, approval, factory, tracer, maxTurns: 10,
      onToolInvoked: (ev) => invocations.push({
        name: ev.name, args: ev.args, value: ev.value,
        ...(ev.binding !== undefined ? { binding: ev.binding } : {}),
      }),
    });
    await agent.run("summarize the page");
    await tracer.close();

    const fetchInv = invocations.find((i) => i.name === "fetch")!;
    assert.equal(fetchInv.binding, "r_0_fetch");
    const sumInv = invocations.find((i) => i.name === "summarize")!;
    assert.deepEqual(sumInv.args, { input: { $ref: "r_0_fetch", path: "text" } });
    assert.deepEqual(sumInv.value, { input: "FULL BODY TEXT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
