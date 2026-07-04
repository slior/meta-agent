import { test } from "node:test";
import assert from "node:assert/strict";
import { liftFromTrace, inputSchemaFromInputs } from "./lift.ts";
import { validate } from "./validator.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";
import type { Tool, ToolSummary } from "../types.ts";

const FETCH: Tool = {
  manifest: {
    name: "read-csv",
    description: "",
    rationale: "",
    inputSchema: {},
    outputShape: {},
    permissions: { fsRead: ["/x.csv"], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 1000, maxOldSpaceSizeMb: 64 },
    hash: "sha256:0",
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "atomic",
  },
  code: "",
};
const FILTER: Tool = {
  ...FETCH,
  manifest: { ...FETCH.manifest, name: "filter-rows", permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] } },
};
const COUNT: Tool = {
  ...FETCH,
  manifest: { ...FETCH.manifest, name: "count-rows", permissions: { fsRead: [], fsWrite: [], net: "allowlist", netAllowlist: ["api"], env: [] } },
};
const STRING_OUT: Tool = {
  ...FETCH,
  manifest: {
    ...FETCH.manifest,
    name: "string-tool",
    outputShape: { type: "string" },
  },
};
const NUMBER_OUT: Tool = {
  ...FETCH,
  manifest: {
    ...FETCH.manifest,
    name: "number-tool",
    outputShape: { type: "number" },
  },
};

const TOOLS: Record<string, Tool> = {
  "read-csv": FETCH,
  "filter-rows": FILTER,
  "count-rows": COUNT,
};

const REF_TOOLS: Record<string, Tool> = {
  fetch: { ...FETCH, manifest: { ...FETCH.manifest, name: "fetch" } },
  summarize: { ...FETCH, manifest: { ...FETCH.manifest, name: "summarize" } },
};

const SLICE = [
  { name: "read-csv", args: { path: "/x.csv" }, ok: true as const, value: [{ a: 1, b: 2 }, { a: 3, b: 4 }] },
  { name: "filter-rows", args: { rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }], predicate: "a > 1" }, ok: true as const, value: [{ a: 3, b: 4 }] },
  { name: "count-rows", args: { rows: [{ a: 3, b: 4 }] }, ok: true as const, value: { count: 1 } },
];

test("lift: structural — args matching prior values become symrefs; others stay literal", () => {
  const out = liftFromTrace({
    slice: SLICE,
    name: "filter-and-count",
    description: "",
    goal: "",
    toolsByName: TOOLS,
  });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const wf = out.workflow;
  assert.equal(wf.steps.length, 3);
  assert.deepEqual(wf.steps[0]!.arguments, { path: { kind: "literal", value: "/x.csv" } });
  assert.deepEqual(wf.steps[1]!.arguments, {
    rows: { kind: "symref", ref: wf.steps[0]!.resultBinding },
    predicate: { kind: "literal", value: "a > 1" },
  });
  assert.deepEqual(wf.steps[2]!.arguments, { rows: { kind: "symref", ref: wf.steps[1]!.resultBinding } });
  assert.deepEqual(wf.return, { source: { kind: "symref", ref: wf.steps[2]!.resultBinding! } });
});

test("lift: top-level only — sub-value access falls back to literal", () => {
  const slice = [
    { name: "read-csv", args: { path: "/x.csv" }, ok: true as const, value: { rows: [{ a: 1 }] } },
    { name: "filter-rows", args: { firstRow: { a: 1 } }, ok: true as const, value: { rows: [] } },
  ];
  const out = liftFromTrace({ slice, name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.workflow.steps[1]!.arguments.firstRow!.kind, "literal");
});

test("lift: earliest-wins on duplicate canonical values", () => {
  const slice = [
    { name: "read-csv", args: {}, ok: true as const, value: { same: true } },
    { name: "read-csv", args: {}, ok: true as const, value: { same: true } },
    { name: "filter-rows", args: { rows: { same: true } }, ok: true as const, value: { rows: [] } },
  ];
  const out = liftFromTrace({ slice, name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const sym = out.workflow.steps[2]!.arguments.rows!;
  assert.equal(sym.kind, "symref");
  if (sym.kind === "symref") assert.equal(sym.ref, out.workflow.steps[0]!.resultBinding);
});

test("lift: deterministic — same input twice yields byte-identical IR", () => {
  const a = liftFromTrace({ slice: SLICE, name: "x", description: "", goal: "", toolsByName: TOOLS });
  const b = liftFromTrace({ slice: SLICE, name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(JSON.stringify(a.workflow), JSON.stringify(b.workflow));
});

test("lift: manifest derivation — permissions union and dependencies", () => {
  const out = liftFromTrace({ slice: SLICE, name: "x", description: "d", goal: "g", toolsByName: TOOLS });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.manifest.kind, "workflow");
  assert.deepEqual(out.manifest.dependencies.sort(), ["count-rows", "filter-rows", "read-csv"]);
  assert.equal(out.manifest.permissions.net, "allowlist");
  assert.deepEqual(out.manifest.permissions.fsRead, ["/x.csv"]);
  assert.deepEqual(out.manifest.permissions.netAllowlist, ["api"]);
});

test("lift: filters out non-ok invocations", () => {
  const slice = [
    { name: "read-csv", args: {}, ok: true as const, value: { x: 1 } },
    { name: "read-csv", args: {}, ok: false as const, value: undefined },
    { name: "filter-rows", args: { rows: { x: 1 } }, ok: true as const, value: null },
  ];
  const out = liftFromTrace({ slice, name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.workflow.steps.length, 2);
});

test("lift: rejects empty slice (after filter)", () => {
  const out = liftFromTrace({ slice: [], name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.errors[0]!.code, "empty_slice");
});

test("lift: rejects unknown tool in slice", () => {
  const slice = [{ name: "no-such", args: {}, ok: true as const, value: 1 }];
  const out = liftFromTrace({ slice, name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.errors[0]!.code, "unknown_tool");
});

test("lift: kebab-case tool names produce validator-safe bindings (compose regression)", async () => {
  const fetchWebpage = { ...FETCH, manifest: { ...FETCH.manifest, name: "fetch-webpage-text" } };
  const writeFile = { ...FETCH, manifest: { ...FETCH.manifest, name: "write-file-text" } };
  const tools: Record<string, Tool> = {
    "fetch-webpage-text": fetchWebpage,
    "write-file-text": writeFile,
  };
  const slice = [
    { name: "fetch-webpage-text", args: { url: "https://example.com" }, ok: true as const, value: "page text" },
    { name: "write-file-text", args: { path: "/tmp/out.txt", content: "page text" }, ok: true as const, value: { written: true } },
  ];
  const out = liftFromTrace({
    slice,
    name: "fetch-and-write",
    description: "",
    goal: "",
    toolsByName: tools,
  });
  assert.equal(out.ok, true);
  if (!out.ok) return;

  assert.equal(out.workflow.steps[0]!.resultBinding, "r_0_fetch_webpage_text");
  assert.equal(out.workflow.steps[1]!.resultBinding, "r_1_write_file_text");
  assert.deepEqual(out.workflow.return, {
    source: { kind: "symref", ref: "r_1_write_file_text" },
  });

  const summaries: ToolSummary[] = Object.values(tools).map((t) => ({
    name: t.manifest.name,
    description: t.manifest.description,
    hash: t.manifest.hash,
    kind: t.manifest.kind,
  }));
  const registry: ToolRegistry = {
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
  const validation = await validate(out.workflow, registry);
  assert.equal(validation.ok, true, !validation.ok ? validation.errors.map((e) => e.message).join("; ") : "");
});

test("lift: surfaces literal-fallback list for sub-value args", () => {
  const slice = [
    { name: "read-csv", args: { path: "/x.csv" }, ok: true as const, value: { rows: [{ a: 1 }] } },
    { name: "filter-rows", args: { firstRow: { a: 1 } }, ok: true as const, value: null },
  ];
  const out = liftFromTrace({ slice, name: "x", description: "", goal: "", toolsByName: TOOLS });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  // 2 fallbacks: step_0.path (first step, always literal) and step_1.firstRow (sub-value, no match)
  assert.equal(out.literalFallbacks.length, 2);
  assert.equal(out.literalFallbacks[0]!.argName, "path");
  assert.equal(out.literalFallbacks[1]!.argName, "firstRow");
});

test("inputSchemaFromInputs: empty inputs project to {}", () => {
  assert.deepEqual(inputSchemaFromInputs([]), {});
});

test("inputSchemaFromInputs: required, defaults, and descriptions project correctly", () => {
  const schema = inputSchemaFromInputs([
    { name: "path", schema: { type: "string" }, required: true },
    { name: "url", schema: { type: "string" }, required: false, default: "https://x", description: "the url" },
  ]);
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      path: { type: "string" },
      url: { type: "string", description: "the url", default: "https://x" },
    },
    required: ["path"],
    additionalProperties: false,
  });
});

test("lift: $ref sentinel arg becomes a symref with path; out-of-slice ref errors", () => {
  const slice = [
    { name: "fetch", args: {}, ok: true as const, value: { text: "BODY" }, binding: "r_0_fetch" },
    {
      name: "summarize",
      args: { input: { $ref: "r_0_fetch", path: "text" } },
      ok: true as const, value: "SUMMARY", binding: "r_1_summarize",
    },
  ];
  const out = liftFromTrace({ slice, name: "wf", description: "d", goal: "g", toolsByName: REF_TOOLS });
  assert.equal(out.ok, true);
  const step1 = (out as { ok: true; workflow: { steps: Array<{ arguments: Record<string, unknown> }> } }).workflow.steps[1]!;
  assert.deepEqual(step1.arguments.input, { kind: "symref", ref: "r_0_fetch", path: "text" });

  const out2 = liftFromTrace({ slice: [slice[1]!], name: "wf", description: "d", goal: "g", toolsByName: REF_TOOLS });
  assert.equal(out2.ok, false);
  assert.equal((out2 as { ok: false; errors: Array<{ code: string }> }).errors[0]!.code, "ref_out_of_slice");
});

test("lift: runtime binding ids are translated to slice-local ids", () => {
  const slice = [
    { name: "fetch", args: {}, ok: true as const, value: { text: "BODY" }, binding: "r_7_fetch" },
    { name: "summarize", args: { input: { $ref: "r_7_fetch", path: "text" } }, ok: true as const, value: "S", binding: "r_8_summarize" },
  ];
  const out = liftFromTrace({ slice, name: "wf", description: "d", goal: "g", toolsByName: REF_TOOLS });
  assert.equal(out.ok, true);
  const wf = (out as { ok: true; workflow: { steps: Array<{ resultBinding: string; arguments: Record<string, { ref?: string }> }> } }).workflow;
  assert.equal(wf.steps[0]!.resultBinding, "r_0_fetch");
  assert.equal(wf.steps[1]!.arguments.input!.ref, "r_0_fetch");
});

test("lift: outputShape derived from last step's tool manifest", () => {
  const out = liftFromTrace({
    slice: [
      { name: "read-csv", args: {}, ok: true, value: ["row"] },
      { name: "string-tool", args: { rows: ["row"] }, ok: true, value: "result" },
    ],
    name: "csv-to-string",
    description: "",
    goal: "",
    toolsByName: { "read-csv": FETCH, "string-tool": STRING_OUT },
  });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.manifest.outputShape, { type: "string" });
});

test("lift: outputShape is last step's shape, not first step's", () => {
  const out = liftFromTrace({
    slice: [
      { name: "number-tool", args: {}, ok: true, value: 1 },
      { name: "string-tool", args: { n: 1 }, ok: true, value: "done" },
    ],
    name: "num-then-str",
    description: "",
    goal: "",
    toolsByName: { "number-tool": NUMBER_OUT, "string-tool": STRING_OUT },
  });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.manifest.outputShape, { type: "string" });
});

test("lift: outputShape falls back to {} when last step's tool has outputShape {}", () => {
  const out = liftFromTrace({
    slice: [{ name: "read-csv", args: {}, ok: true, value: ["row"] }],
    name: "just-read",
    description: "",
    goal: "",
    toolsByName: { "read-csv": FETCH },
  });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  // FETCH.manifest.outputShape is {} — derives through
  assert.deepEqual(out.manifest.outputShape, {});
});
