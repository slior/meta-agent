import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolFactory } from "./factory.ts";
import { MockLLMProvider } from "../llm/mock-provider.ts";
import { FsToolRegistry } from "../registry/fs-registry.ts";
import { NodePermissionSandbox } from "../sandbox/node-permission-sandbox.ts";
import { APPROVAL_DECISION } from "../approval/interface.ts";
import { TieredApprovalPolicy } from "../approval/tiered-policy.ts";
import { Tracer } from "../tracer.ts";
import type { ToolDraft } from "../types.ts";

const GOOD_DRAFT: ToolDraft = {
  name: "double-int",
  description: "Doubles an integer.",
  rationale: "Tests need doubling.",
  inputSchema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"] },
  outputShape: { type: "object", properties: { doubled: { type: "integer" } } },
  permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  code: "export async function run(i){return {doubled: i.x*2};}",
  dependencies: [],
  smokeTestInput: { x: 5 },
  kind: "atomic",
};

test("factory: happy path — static passes, smoke passes, approval auto-approves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fac-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider().onStructured<ToolDraft>(() => GOOD_DRAFT);
    const prompter = {
      promptGate1: async () => ({ decision: APPROVAL_DECISION.approve, alwaysApprove: false }),
      promptGate23: async () => { throw new Error("no"); },
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const out = await factory.createAtomic({ intent: "double ints", rationale: "need it", existingToolsConsidered: [] });
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.tool.manifest.name, "double-int");
    await tracer.close();
    assert.ok(await registry.has("double-int"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("factory: static failure triggers repair loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fac-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onStructured<ToolDraft>(() => ({ ...GOOD_DRAFT, name: "BadName" }))
      .onStructured<ToolDraft>(() => GOOD_DRAFT);
    const prompter = {
      promptGate1: async () => ({ decision: APPROVAL_DECISION.approve, alwaysApprove: false }),
      promptGate23: async () => { throw new Error("no"); },
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const out = await factory.createAtomic({ intent: "x", rationale: "y", existingToolsConsidered: [] });
    assert.equal(out.ok, true);
    assert.equal(llm.calls.structured.length, 2);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("factory: rejected by reviewer returns failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fac-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider().onStructured<ToolDraft>(() => GOOD_DRAFT);
    const prompter = {
      promptGate1: async () => ({ decision: APPROVAL_DECISION.reject, reason: "no thanks" }),
      promptGate23: async () => { throw new Error("no"); },
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const out = await factory.createAtomic({ intent: "x", rationale: "y", existingToolsConsidered: [] });
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.reason, /no thanks/);
    await tracer.close();
    assert.equal(await registry.has("double-int"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
