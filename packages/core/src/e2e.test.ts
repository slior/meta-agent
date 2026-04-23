import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentLoop, APPROVAL_DECISION, CHAT_ROLE, CHAT_TOOL_TYPE, FsToolRegistry, HybridToolIndex, META_FN, MockLLMProvider,
  NodePermissionSandbox, TieredApprovalPolicy, ToolFactory, Tracer,
} from "./index.ts";
import type { ChatResponse, ToolDraft } from "./index.ts";

function asst(content: string | null, calls: Array<{ id: string; name: string; args: unknown }> = []): ChatResponse {
  return {
    message: {
      role: CHAT_ROLE.assistant,
      content,
      ...(calls.length
        ? {
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: CHAT_TOOL_TYPE.function,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
        : {}),
    },
  };
}

const DOUBLE_DRAFT: ToolDraft = {
  name: "double-int",
  description: "Doubles an integer.",
  rationale: "Testing atomic tool creation.",
  inputSchema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false },
  outputShape: { type: "object", properties: { doubled: { type: "integer" } }, required: ["doubled"], additionalProperties: false },
  permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  code: "export async function run(i){return {doubled: i.x*2};}",
  dependencies: [],
  smokeTestInput: { x: 3 },
  kind: "atomic",
};

const PLUS_ONE_THEN_DOUBLE_DRAFT: ToolDraft = {
  name: "plus-one-then-double",
  description: "Adds 1 to the input then doubles it via double-int.",
  rationale: "Reactive composite example.",
  inputSchema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false },
  outputShape: { type: "object", properties: { doubled: { type: "integer" } }, required: ["doubled"], additionalProperties: false },
  permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  code: `export async function run(i){
  const r = await invokeTool("double-int", { x: i.x + 1 });
  if (!r.ok) throw new Error("inner failed");
  return r.value;
}`,
  dependencies: ["double-int"],
  smokeTestInput: { x: 4 },
  kind: "composite",
};

test("E2E: agent finds-nothing, proposes tool, then invokes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider();

    llm
      .onChat(() => asst(null, [{ id: "1", name: META_FN.findTool, args: { query: "double integer" } }]))
      .onChat(() => asst(null, [{ id: "2", name: META_FN.proposeNewTool, args: { intent: "double an integer", rationale: "user asked" } }]))
      .onStructured<ToolDraft>(() => DOUBLE_DRAFT)
      .onChat(() => asst(null, [{ id: "3", name: META_FN.invokeTool, args: { name: "double-int", args: { x: 7 } } }]))
      .onChat(() => asst("result: 14"));

    const prompter = {
      promptGate1: async () => ({ decision: APPROVAL_DECISION.approve, alwaysApprove: true }),
      promptGate23: async () => { throw new Error("no"); },
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir, yolo: false });
    const tracer = await Tracer.open(join(dir, "traces"), "e2e");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });
    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });

    const out = await loop.run("please double 7");
    assert.match(out, /14/);
    assert.ok(await registry.has("double-int"));
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("E2E: composite invokeTool runs with no ambient authority (depth 1 inner call)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider();

    llm
      .onStructured<ToolDraft>(() => DOUBLE_DRAFT)
      .onStructured<ToolDraft>(() => PLUS_ONE_THEN_DOUBLE_DRAFT);

    const prompter = {
      promptGate1: async () => ({ decision: APPROVAL_DECISION.approve, alwaysApprove: true }),
      promptGate23: async () => { throw new Error("no"); },
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir, yolo: false });
    const tracer = await Tracer.open(join(dir, "traces"), "e2e2");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const a = await factory.createAtomic({ intent: "double", rationale: "base", existingToolsConsidered: [] });
    assert.equal(a.ok, true);
    const c = await factory.createComposite({ name: "plus-one-then-double", intent: "+1 then double", plannedSteps: [{ tool: "double-int", argsTemplate: "{x+1}" }] });
    assert.equal(c.ok, true);

    llm
      .onChat(() => asst(null, [{ id: "x", name: META_FN.invokeTool, args: { name: "plus-one-then-double", args: { x: 10 } } }]))
      .onChat(() => asst("22"));

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("compute");
    assert.match(out, /22/);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
