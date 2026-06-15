import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "./validator.ts";
import type { Workflow } from "./types.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";
import type { Tool, ToolSummary } from "../types.ts";

function fakeRegistry(tools: Record<string, Tool>): ToolRegistry {
  const summaries: ToolSummary[] = Object.values(tools).map((t) => ({
    name: t.manifest.name,
    description: t.manifest.description,
    hash: t.manifest.hash,
    kind: t.manifest.kind,
  }));
  return {
    list: async () => summaries,
    listSync: () => summaries,
    has: async (n) => n in tools,
    get: async (n) => tools[n] ?? null,
    getApproval: async () => null,
    save: async () => {},
    delete: async () => {},
    getDependents: async () => [],
    rootDir: () => "/tmp",
    getWorkflow: async () => null,
  };
}

const ATOMIC = (
  name: string,
  inputSchema: Record<string, unknown> = { type: "object", properties: {}, additionalProperties: true },
): Tool => ({
  manifest: {
    name,
    description: "",
    rationale: "",
    inputSchema,
    outputShape: {},
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 1000, maxOldSpaceSizeMb: 64 },
    hash: "sha256:0",
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "atomic",
  },
  code: "export async function run(){return null}",
});

const FETCH = ATOMIC("fetch-mail");
const SUMMARIZE = ATOMIC("summarize-list", {
  type: "object",
  properties: { items: {} },
  required: ["items"],
  additionalProperties: false,
});
const FETCH_WEBPAGE = ATOMIC("fetch-webpage-text", {});

const registry = fakeRegistry({
  "fetch-mail": FETCH,
  "summarize-list": SUMMARIZE,
  "fetch-webpage-text": FETCH_WEBPAGE,
});

function paramWf(...inputs: Workflow["inputs"]): Workflow {
  return {
    schemaVersion: 1, name: "p", description: "", goal: "",
    inputs,
    steps: [{
      kind: "tool_call", label: "s0", tool: "fetch-webpage-text",
      arguments: {}, resultBinding: "r0",
    }],
    return: null,
  };
}

function baseWorkflow(): Workflow {
  return {
    schemaVersion: 1,
    name: "wf",
    description: "",
    goal: "",
    inputs: [],
    steps: [
      {
        kind: "tool_call",
        label: "fetch",
        tool: "fetch-mail",
        arguments: {},
        resultBinding: "emails",
      },
      {
        kind: "tool_call",
        label: "summarize",
        tool: "summarize-list",
        arguments: { items: { kind: "symref", ref: "emails" } },
        resultBinding: "summary",
      },
    ],
    return: { source: { kind: "symref", ref: "summary" } },
  };
}

test("validator: happy path", async () => {
  const reg = fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE });
  const out = await validate(baseWorkflow(), reg);
  assert.equal(out.ok, true);
});

test("validator: rejects unsupported_schema_version", async () => {
  const wf = { ...baseWorkflow(), schemaVersion: 999 as 1 };
  const out = await validate(wf, fakeRegistry({}));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "unsupported_schema_version"));
});


test("validator: rejects duplicate step labels", async () => {
  const wf = baseWorkflow();
  wf.steps[1]!.label = wf.steps[0]!.label;
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "duplicate_step_label"));
});

test("validator: rejects duplicate result bindings", async () => {
  const wf = baseWorkflow();
  wf.steps[1]!.resultBinding = wf.steps[0]!.resultBinding;
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "duplicate_binding"));
});

test("validator: rejects invalid binding name", async () => {
  const wf = baseWorkflow();
  wf.steps[0]!.resultBinding = "bad-binding-with-dash";
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "invalid_binding_name"));
});

test("validator: rejects unknown_tool", async () => {
  const wf = baseWorkflow();
  wf.steps[0]!.tool = "no-such-tool";
  const out = await validate(wf, fakeRegistry({ "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "unknown_tool"));
});

test("validator: rejects meta_tool_not_callable_from_workflow", async () => {
  const wf = baseWorkflow();
  wf.steps[0]!.tool = "find_tool";
  const out = await validate(wf, fakeRegistry({ "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "meta_tool_not_callable_from_workflow"));
});

test("validator: rejects unbound symref", async () => {
  const wf = baseWorkflow();
  wf.steps[1]!.arguments = { items: { kind: "symref", ref: "no_such_binding" } };
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "unbound_symref"));
});

test("validator: rejects missing_required_arg", async () => {
  const wf = baseWorkflow();
  wf.steps[1]!.arguments = {};
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "missing_required_arg"));
});

test("validator: rejects unknown_arg when additionalProperties:false", async () => {
  const wf = baseWorkflow();
  wf.steps[1]!.arguments = {
    items: { kind: "symref", ref: "emails" },
    extra: { kind: "literal", value: 1 },
  };
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "unknown_arg"));
});

test("validator: rejects unbound return", async () => {
  const wf = baseWorkflow();
  wf.return = { source: { kind: "symref", ref: "no_such_binding" } };
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.some((e) => e.code === "unbound_return"));
});

test("validator: accepts null return", async () => {
  const wf = baseWorkflow();
  wf.return = null;
  const out = await validate(wf, fakeRegistry({ "fetch-mail": FETCH, "summarize-list": SUMMARIZE }));
  assert.equal(out.ok, true);
});

test("validator: input SymRef resolves in scope; parameterized workflow is valid", async () => {
  const wf: Workflow = {
    schemaVersion: 1, name: "p", description: "", goal: "",
    inputs: [{ name: "url", schema: { type: "string" }, required: true }],
    steps: [{
      kind: "tool_call", label: "s0", tool: "fetch-webpage-text",
      arguments: { url: { kind: "symref", ref: "url" } }, resultBinding: "r0",
    }],
    return: { source: { kind: "symref", ref: "r0" } },
  };
  const res = await validate(wf, registry);
  assert.equal(res.ok, true, res.ok ? "" : res.errors.map((e) => e.code).join(","));
});

test("validator: invalid_input_name", async () => {
  const wf = paramWf({ name: "1bad", schema: { type: "string" }, required: true });
  const res = await validate(wf, registry);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.code === "invalid_input_name"));
});

test("validator: duplicate_input", async () => {
  const wf = paramWf(
    { name: "x", schema: { type: "string" }, required: true },
    { name: "x", schema: { type: "string" }, required: true },
  );
  const res = await validate(wf, registry);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.code === "duplicate_input"));
});

test("validator: input_binding_collision", async () => {
  const wf = paramWf({ name: "r0", schema: { type: "string" }, required: true });
  const res = await validate(wf, registry);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.code === "input_binding_collision"));
});

test("validator: optional_input_missing_default", async () => {
  const wf = paramWf({ name: "x", schema: { type: "string" }, required: false });
  const res = await validate(wf, registry);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.code === "optional_input_missing_default"));
});

test("validator: invalid_input_schema", async () => {
  const wf = paramWf({ name: "x", schema: null as unknown as Record<string, unknown>, required: true });
  const res = await validate(wf, registry);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.code === "invalid_input_schema"));
});

test("validator: symref to invalid input name emits both invalid_input_name and unbound_symref", async () => {
  const wf = paramWf({ name: "1bad", schema: { type: "string" }, required: true });
  wf.steps[0]!.arguments = { x: { kind: "symref", ref: "1bad" } as const };
  const res = await validate(wf, registry);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === "invalid_input_name"));
    assert.ok(res.errors.some((e) => e.code === "unbound_symref"));
  }
});

function setupWithToolCapabilities(caps: string[]): { registry: ToolRegistry; workflow: Workflow } {
  const tool: Tool = {
    ...ATOMIC("telepathy-tool"),
    manifest: {
      ...ATOMIC("telepathy-tool").manifest,
      capabilities: caps,
    },
  };
  const reg = fakeRegistry({ "telepathy-tool": tool });
  const workflow: Workflow = {
    schemaVersion: 1,
    name: "cap-wf",
    description: "",
    goal: "",
    inputs: [],
    steps: [{
      kind: "tool_call",
      label: "call",
      tool: "telepathy-tool",
      arguments: {},
      resultBinding: "r0",
    }],
    return: null,
  };
  return { registry: reg, workflow };
}

test("validator rejects a step whose tool declares an unknown capability", async () => {
  const { registry: reg, workflow } = setupWithToolCapabilities(["telepathy"]);
  const r = await validate(workflow, reg);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.code === "unknown_capability"));
});

test("validator: symref with single-key path is accepted", async () => {
  const reg = fakeRegistry({ "fetch-webpage-text": ATOMIC("fetch-webpage-text", {}), "write-file-text": ATOMIC("write-file-text", {}) });
  const wf: Workflow = {
    schemaVersion: 1, name: "wf", description: "", goal: "", inputs: [],
    steps: [
      { kind: "tool_call", label: "s0", tool: "fetch-webpage-text", arguments: {}, resultBinding: "r_0_fetch" },
      { kind: "tool_call", label: "s1", tool: "write-file-text", arguments: { content: { kind: "symref", ref: "r_0_fetch", path: "text" } }, resultBinding: "r_1_write" },
    ],
    return: { source: { kind: "symref", ref: "r_1_write" } },
  };
  const res = await validate(wf, reg);
  assert.equal(res.ok, true);
});
