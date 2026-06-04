import { test, describe, before, after } from "node:test";
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
import type { Tool, ToolDraft, ApprovalRecord } from "../types.ts";

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

const FETCH_TOOL: Tool = {
  manifest: {
    name: "fetch-webpage-text",
    description: "Fetches text content from a URL",
    rationale: "HTTP fetch",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    outputShape: { type: "string" },
    permissions: { fsRead: [], fsWrite: [], net: "allowlist", netAllowlist: ["*"], env: [] },
    dependencies: [],
    limits: { timeoutMs: 10000, maxOldSpaceSizeMb: 64 },
    hash: "sha256:fetch-webpage-text",
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "atomic",
  },
  code: `export async function run(i) { return "text"; }`,
};

const WRITE_TOOL: Tool = {
  manifest: {
    name: "write-file-text",
    description: "Writes text content to a file",
    rationale: "File write",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    outputShape: { type: "object", properties: { written: { type: "boolean" } } },
    permissions: { fsRead: [], fsWrite: ["./"], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 5000, maxOldSpaceSizeMb: 64 },
    hash: "sha256:write-file-text",
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "atomic",
  },
  code: `export async function run(i) { return { written: true }; }`,
};

const TOOL_APPROVAL: ApprovalRecord = {
  hash: "sha256:stub",
  approvedAt: "2026-01-01T00:00:00.000Z",
  approvedBy: "test",
  alwaysApprove: false,
};

describe("createWorkflow and previewWorkflow", () => {
  let wfDir: string;
  let wfRegistry: FsToolRegistry;
  let factory: ToolFactory;

  before(async () => {
    wfDir = await mkdtemp(join(tmpdir(), "fac-wf-"));
    wfRegistry = await FsToolRegistry.open(join(wfDir, "tools"));
    await wfRegistry.save(FETCH_TOOL, { ...TOOL_APPROVAL, hash: FETCH_TOOL.manifest.hash });
    await wfRegistry.save(WRITE_TOOL, { ...TOOL_APPROVAL, hash: WRITE_TOOL.manifest.hash });

    const sandbox = new NodePermissionSandbox({ workspace: wfDir });
    const llm = new MockLLMProvider();
    const prompter = {
      promptGate1: async () => ({ decision: APPROVAL_DECISION.approve, alwaysApprove: false }),
      promptGate23: async () => { throw new Error("no"); },
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: wfDir });
    const tracer = await Tracer.open(join(wfDir, "traces"), "s");
    factory = new ToolFactory({ llm, registry: wfRegistry, sandbox, approval, tracer, tombstoned: new Set() });
  });

  after(async () => {
    await rm(wfDir, { recursive: true, force: true });
  });

  test("createWorkflow: promotes a literal to a required input and projects inputSchema", async () => {
    const slice = [
      { name: "fetch-webpage-text", args: { url: "https://x/p.md" }, ok: true, value: "text" },
      { name: "write-file-text", args: { path: "./o.md", content: "text" }, ok: true, value: { written: true } },
    ];
    const out = await factory.createWorkflow({
      slice, name: "summarize_paper", intent: "summarize", description: "d",
      promotions: [
        { stepLabel: "step_0_fetch_webpage_text", argName: "url", paramName: "url", required: true },
        { stepLabel: "step_1_write_file_text", argName: "path", paramName: "path", required: false, description: "out path" },
      ],
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    const schema = out.tool.manifest.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    assert.deepEqual(schema.required, ["url"]);
    assert.ok("path" in schema.properties);
  });

  test("previewWorkflow: returns literalFallbacks without persisting", async () => {
    const slice = [{ name: "fetch-webpage-text", args: { url: "https://x" }, ok: true, value: "t" }];
    const pv = await factory.previewWorkflow({ slice, name: "x", intent: "", description: "" });
    assert.equal(pv.ok, true);
    if (!pv.ok) return;
    assert.ok(pv.literalFallbacks.some((f) => f.argName === "url"));
    // Confirm not persisted — tool with name "x" should not be in registry
    const saved = await wfRegistry.get("x");
    assert.ok(!saved);
  });
});
