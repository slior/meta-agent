import { test } from "node:test";
import assert from "node:assert/strict";
import { staticValidateDraft } from "./static-validator.ts";
import type { ToolDraft } from "../types.ts";

function draft(overrides: Partial<ToolDraft> = {}): ToolDraft {
  return {
    name: "t",
    description: "d",
    rationale: "r",
    inputSchema: { type: "object" },
    outputShape: { type: "object" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    code: "export async function run(i){ return i; }",
    dependencies: [],
    smokeTestInput: {},
    kind: "atomic",
    ...overrides,
  };
}

test("passes a minimal atomic draft", () => {
  const r = staticValidateDraft(draft(), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, true);
});

test("rejects duplicate name", () => {
  const r = staticValidateDraft(draft(), { existingNames: new Set(["t"]), tombstoned: new Set() });
  assert.equal(r.ok, false);
});

test("rejects tombstoned name", () => {
  const r = staticValidateDraft(draft(), { existingNames: new Set(), tombstoned: new Set(["t"]) });
  assert.equal(r.ok, false);
});

test("rejects disallowed import (child_process)", () => {
  const r = staticValidateDraft(draft({
    code: `import { spawn } from "node:child_process";\nexport async function run(){}`,
  }), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, false);
});

test("rejects bare npm import (only node:* allowed)", () => {
  const r = staticValidateDraft(draft({
    code: `import lodash from "lodash";\nexport async function run(){}`,
  }), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, false);
});

test("rejects fs import when no fs permission declared", () => {
  const r = staticValidateDraft(draft({
    code: `import { readFile } from "node:fs/promises";\nexport async function run(){}`,
  }), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, false);
});

test("allows fs import when fsRead declared", () => {
  const r = staticValidateDraft(draft({
    permissions: { fsRead: ["/tmp"], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    code: `import { readFile } from "node:fs/promises";\nexport async function run(){}`,
  }), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, true);
});

test("rejects permissions.fsWrite when not an array", () => {
  const r = staticValidateDraft(draft({
    permissions: {
      fsRead: ["/tmp"],
      fsWrite: {} as unknown as string[],
      net: "none",
      netAllowlist: [],
      env: [],
    },
    code: `import { readFile } from "node:fs/promises";\nexport async function run(){}`,
  }), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("fsWrite")));
});

test("rejects permissions.fsRead when not an array", () => {
  const r = staticValidateDraft(draft({
    permissions: {
      fsRead: "/tmp" as unknown as string[],
      fsWrite: [],
      net: "none",
      netAllowlist: [],
      env: [],
    },
    code: `export async function run(){}`,
  }), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("fsRead")));
});

test("rejects missing dependencies array with actionable message", () => {
  const r = staticValidateDraft(
    draft({ dependencies: undefined as unknown as string[] }),
    { existingNames: new Set(), tombstoned: new Set() },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    const msg = r.errors.find((e) => e.includes("dependencies"));
    assert.ok(msg);
    assert.match(msg!, /atomic tool use \[\]/);
    assert.match(msg!, /structured output/i);
  }
});

test("rejects undefined rationale and outputShape", () => {
  const r = staticValidateDraft(
    draft({
      rationale: undefined as unknown as string,
      outputShape: undefined as unknown as Record<string, unknown>,
    }),
    { existingNames: new Set(), tombstoned: new Set() },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.errors.some((e) => e.includes("rationale")));
    assert.ok(r.errors.some((e) => e.includes("outputShape")));
  }
});

test("rejects non-string dependency entries", () => {
  const r = staticValidateDraft(
    draft({
      dependencies: ["ok", null as unknown as string],
    }),
    { existingNames: new Set(), tombstoned: new Set() },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("dependencies[1]")));
});

test("composite: declared deps must match invokeTool call sites", () => {
  const r = staticValidateDraft(draft({
    kind: "composite",
    dependencies: ["alpha"],
    code: `export async function run(){ return await invokeTool("bravo",{}); }`,
  }), { existingNames: new Set(["alpha","bravo"]), tombstoned: new Set() });
  assert.equal(r.ok, false);
});

test("composite: deps matching invokeTool calls passes", () => {
  const r = staticValidateDraft(draft({
    kind: "composite",
    dependencies: ["alpha","bravo"],
    code: `export async function run(){ const a = await invokeTool("alpha",{}); return invokeTool("bravo",a); }`,
  }), { existingNames: new Set(["alpha","bravo"]), tombstoned: new Set() });
  assert.equal(r.ok, true);
});

test("rejects eval/Function use", () => {
  const r = staticValidateDraft(draft({
    code: `export async function run(){ return eval("1+1"); }`,
  }), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, false);
});

test("atomic tool must not contain invokeTool calls", () => {
  const r = staticValidateDraft(draft({
    code: `export async function run(){ return invokeTool("x",{}); }`,
  }), { existingNames: new Set(["x"]), tombstoned: new Set() });
  assert.equal(r.ok, false);
});

test("authored drafts may not declare capabilities", () => {
  const r = staticValidateDraft(
    draft({ capabilities: ["llm"] } as Partial<ToolDraft>),
    { existingNames: new Set(), tombstoned: new Set() },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => /capabilities/.test(e)));
});

test("normal authored draft still validates", () => {
  const r = staticValidateDraft(draft(), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, true);
});
