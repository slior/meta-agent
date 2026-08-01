import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolFactory } from "./factory.ts";
import { MockLLMProvider } from "../llm/mock-provider.ts";
import { FsToolRegistry } from "../registry/fs-registry.ts";
import { NodePermissionSandbox } from "../sandbox/node-permission-sandbox.ts";
import { APPROVAL_DECISION, GATE1_KIND, type Gate1ReviewPayload } from "../approval/interface.ts";
import { TieredApprovalPolicy } from "../approval/tiered-policy.ts";
import { Tracer } from "../tracer.ts";
import { TOOL_KIND, type ToolDraft } from "../types.ts";
import { isWorkflowTool } from "../tool.ts";
import { makeConsistentApproval, makeConsistentCodeTool } from "../testing/tool-fixtures.ts";

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
      promptGate1: async () => ({ kind: GATE1_KIND.CODE, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false }),
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
      promptGate1: async () => ({ kind: GATE1_KIND.CODE, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false }),
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
      promptGate1: async () => ({ kind: GATE1_KIND.CODE, decision: APPROVAL_DECISION.REJECT, reason: "no thanks" }),
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

const FETCH_CODE = `export async function run(i) { return "text"; }`;
const FETCH_TOOL = makeConsistentCodeTool(
  {
    name: "fetch-webpage-text",
    description: "Fetches text content from a URL",
    rationale: "HTTP fetch",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    outputShape: { type: "string" },
    permissions: { fsRead: [], fsWrite: [], net: "allowlist", netAllowlist: ["*"], env: [] },
    dependencies: [],
    limits: { timeoutMs: 10000, maxOldSpaceSizeMb: 64 },
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "atomic",
  },
  FETCH_CODE,
);

const WRITE_CODE = `export async function run(i) { return { written: true }; }`;
const WRITE_TOOL = makeConsistentCodeTool(
  {
    name: "write-file-text",
    description: "Writes text content to a file",
    rationale: "File write",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    outputShape: { type: "object", properties: { written: { type: "boolean" } } },
    permissions: { fsRead: [], fsWrite: ["./"], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 5000, maxOldSpaceSizeMb: 64 },
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "atomic",
  },
  WRITE_CODE,
);

describe("createWorkflow and previewWorkflow", () => {
  let wfDir: string;
  let wfRegistry: FsToolRegistry;
  let factory: ToolFactory;

  before(async () => {
    wfDir = await mkdtemp(join(tmpdir(), "fac-wf-"));
    wfRegistry = await FsToolRegistry.open(join(wfDir, "tools"));
    await wfRegistry.saveCode(FETCH_TOOL, makeConsistentApproval(FETCH_TOOL));
    await wfRegistry.saveCode(WRITE_TOOL, makeConsistentApproval(WRITE_TOOL));

    const sandbox = new NodePermissionSandbox({ workspace: wfDir });
    const llm = new MockLLMProvider();
    const prompter = {
      promptGate1: async (payload: Gate1ReviewPayload) => {
        if (payload.kind === GATE1_KIND.WORKFLOW) {
          return { kind: GATE1_KIND.WORKFLOW, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false };
        }
        return { kind: GATE1_KIND.CODE, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false };
      },
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

  test("createWorkflow: returns a WorkflowTool and persists it through saveWorkflow", async () => {
    const slice = [
      { name: "fetch-webpage-text", args: { url: "https://x/typed.md" }, ok: true, value: "text" },
      { name: "write-file-text", args: { path: "./typed.md", content: "text" }, ok: true, value: { written: true } },
    ];
    const out = await factory.createWorkflow({
      slice, name: "typed_workflow", intent: "typed", description: "typed workflow",
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;

    const created = out.tool;
    assert.ok(isWorkflowTool(created), "createWorkflow must return a WorkflowTool, not a code tool");
    assert.equal(created.manifest.kind, TOOL_KIND.WORKFLOW);
    assert.equal(created.workflow.name, "typed_workflow");
    assert.equal(created.workflow.steps.length, 2);

    // saveWorkflow (not saveCode) is the persistence path: the entry reads back as a workflow only.
    const persisted = await wfRegistry.getWorkflow("typed_workflow");
    assert.ok(persisted, "workflow tool must be readable via getWorkflow");
    assert.deepEqual(persisted.workflow, created.workflow);
    assert.equal(persisted.manifest.hash, created.manifest.hash);
    assert.equal(await wfRegistry.getCode("typed_workflow"), null);
  });

  test("previewWorkflow: returns literalFallbacks without persisting", async () => {
    const slice = [{ name: "fetch-webpage-text", args: { url: "https://x" }, ok: true, value: "t" }];
    const pv = await factory.previewWorkflow({ slice, name: "x", intent: "", description: "" });
    assert.equal(pv.ok, true);
    if (!pv.ok) return;
    assert.ok(pv.literalFallbacks.some((f) => f.argName === "url"));
    // Confirm not persisted — tool with name "x" should not be in registry
    assert.equal(await wfRegistry.getManifest("x"), null);
  });

  test("createWorkflow: calls reviewDraft with workflow payload before saving", async () => {
    const slice = [
      { name: "fetch-webpage-text", args: { url: "https://x/p.md" }, ok: true, value: "text" },
    ];
    let capturedPayload: Gate1ReviewPayload | undefined;

    const customPrompter = {
      promptGate1: async (p: Gate1ReviewPayload) => {
        capturedPayload = p;
        return { kind: GATE1_KIND.WORKFLOW, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false };
      },
      promptGate23: async () => { throw new Error("no"); },
    };
    const customApproval = new TieredApprovalPolicy(customPrompter, { workspace: wfDir });
    const customFactory = new ToolFactory({
      llm: new MockLLMProvider(),
      registry: wfRegistry,
      sandbox: new NodePermissionSandbox({ workspace: wfDir }),
      approval: customApproval,
      tracer: await Tracer.open(join(wfDir, "traces"), "s2"),
      tombstoned: new Set(),
    });

    const out = await customFactory.createWorkflow({
      slice, name: "fetch-only", intent: "fetch a url", description: "fetches url",
    });

    assert.equal(out.ok, true);
    assert.ok(capturedPayload, "reviewDraft should have been called");
    assert.equal(capturedPayload?.kind, GATE1_KIND.WORKFLOW);
    if (capturedPayload?.kind === GATE1_KIND.WORKFLOW) {
      assert.equal(capturedPayload.manifest.name, "fetch-only");
      assert.ok(typeof capturedPayload.literateRendering === "string");
      assert.ok(capturedPayload.literateRendering.length > 0);
      assert.equal(capturedPayload.effectivePermissions.net, "allowlist");
    }
  });

  test("createWorkflow: returns { ok: false } when reviewer rejects", async () => {
    const slice = [
      { name: "fetch-webpage-text", args: { url: "https://x" }, ok: true, value: "t" },
    ];
    const rejectPrompter = {
      promptGate1: async (p: Gate1ReviewPayload) => {
        if (p.kind === GATE1_KIND.WORKFLOW) {
          return { kind: GATE1_KIND.WORKFLOW, decision: APPROVAL_DECISION.REJECT, reason: "not today" };
        }
        return { kind: GATE1_KIND.CODE, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false };
      },
      promptGate23: async () => { throw new Error("no"); },
    };
    const rejectApproval = new TieredApprovalPolicy(rejectPrompter, { workspace: wfDir });
    const rejectFactory = new ToolFactory({
      llm: new MockLLMProvider(),
      registry: wfRegistry,
      sandbox: new NodePermissionSandbox({ workspace: wfDir }),
      approval: rejectApproval,
      tracer: await Tracer.open(join(wfDir, "traces"), "s3"),
      tombstoned: new Set(),
    });

    const out = await rejectFactory.createWorkflow({
      slice, name: "rejected-wf", intent: "test", description: "d",
    });

    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.reason, /not today/);
    assert.equal(await wfRegistry.has("rejected-wf"), false);
  });

  test("createWorkflow: applies editedName from approval decision", async () => {
    const slice = [
      { name: "fetch-webpage-text", args: { url: "https://x/q.md" }, ok: true, value: "text" },
    ];
    const editPrompter = {
      promptGate1: async (p: Gate1ReviewPayload) => {
        if (p.kind === GATE1_KIND.WORKFLOW) {
          return {
            kind: GATE1_KIND.WORKFLOW,
            decision: APPROVAL_DECISION.APPROVE,
            alwaysApprove: false,
            editedName: "renamed-fetch",
          };
        }
        return { kind: GATE1_KIND.CODE, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false };
      },
      promptGate23: async () => { throw new Error("no"); },
    };
    const editApproval = new TieredApprovalPolicy(editPrompter, { workspace: wfDir });
    const editFactory = new ToolFactory({
      llm: new MockLLMProvider(),
      registry: wfRegistry,
      sandbox: new NodePermissionSandbox({ workspace: wfDir }),
      approval: editApproval,
      tracer: await Tracer.open(join(wfDir, "traces"), "s4"),
      tombstoned: new Set(),
    });

    const out = await editFactory.createWorkflow({
      slice, name: "original-name", intent: "test", description: "d",
    });

    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.tool.manifest.name, "renamed-fetch");
    assert.equal(await wfRegistry.has("renamed-fetch"), true);
    assert.equal(await wfRegistry.has("original-name"), false);
  });
});

// A draft whose code always returns the wrong shape (string instead of declared number)
const WRONG_OUTPUT_DRAFT: ToolDraft = {
  name: "wrong-output",
  description: "Returns wrong shape.",
  rationale: "test",
  inputSchema: { type: "object" },
  outputShape: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
  permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  code: `export async function run(_i) { return { n: "oops" }; }`,
  dependencies: [],
  smokeTestInput: {},
  kind: "atomic",
};

// A draft that fixes the shape on retry
const FIXED_OUTPUT_DRAFT: ToolDraft = {
  ...WRONG_OUTPUT_DRAFT,
  code: `export async function run(_i) { return { n: 42 }; }`,
};

test("factory: smoke output violating outputShape enters repair loop and succeeds on fix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fac-osv-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    // LLM: first returns wrong draft, second (repair) returns fixed draft
    const llm = new MockLLMProvider()
      .onStructured<ToolDraft>(() => WRONG_OUTPUT_DRAFT)
      .onStructured<ToolDraft>(() => FIXED_OUTPUT_DRAFT);
    const prompter = {
      promptGate1: async () => ({ kind: GATE1_KIND.CODE, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false }),
      promptGate23: async () => { throw new Error("no"); },
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const out = await factory.createAtomic({ intent: "test", rationale: "test", existingToolsConsidered: [] });
    assert.equal(out.ok, true, `expected ok:true but got: ${JSON.stringify(out)}`);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("factory: smoke output violating outputShape exhausts repair and rejects tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fac-osv-exhaust-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    // LLM always returns the wrong draft (maxRepair = 2 by default, so 3 total structured calls)
    const llm = new MockLLMProvider()
      .onStructured<ToolDraft>(() => WRONG_OUTPUT_DRAFT)
      .onStructured<ToolDraft>(() => WRONG_OUTPUT_DRAFT)
      .onStructured<ToolDraft>(() => WRONG_OUTPUT_DRAFT);
    const prompter = {
      promptGate1: async () => { throw new Error("should not reach Gate 1"); },
      promptGate23: async () => { throw new Error("no"); },
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const out = await factory.createAtomic({ intent: "test", rationale: "test", existingToolsConsidered: [] });
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.ok(
        out.reason.includes("outputShape") || out.reason.includes("output_schema"),
        `expected outputShape error in reason, got: ${out.reason}`,
      );
    }
    assert.equal(await registry.has("wrong-output"), false, "rejected tool must not be in registry");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("factory: presentAndSave re-validates edited draft and rejects if output violates outputShape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fac-edit-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider().onStructured<ToolDraft>(() => GOOD_DRAFT);
    // Gate 1 reviewer returns an edited draft whose code now returns the wrong shape
    const brokenEditedDraft: ToolDraft = {
      ...GOOD_DRAFT,
      code: `export async function run(i){ return { doubled: "oops" }; }`,  // string instead of integer
    };
    const prompter = {
      promptGate1: async (payload: Gate1ReviewPayload) => ({
        kind: GATE1_KIND.CODE,
        decision: APPROVAL_DECISION.APPROVE,
        alwaysApprove: false,
        ...(payload.kind === GATE1_KIND.CODE ? { editedDraft: brokenEditedDraft } : {}),
      }),
      promptGate23: async () => { throw new Error("no"); },
    };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const out = await factory.createAtomic({ intent: "test", rationale: "test", existingToolsConsidered: [] });
    assert.equal(out.ok, false, "edited draft with wrong output shape must be rejected");
    assert.equal(await registry.has("double-int"), false, "broken tool must not be in registry");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
