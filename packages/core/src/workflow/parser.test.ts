import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow } from "./parser.ts";
import type { Workflow } from "./types.ts";

const VALID: Workflow = {
  schemaVersion: 1,
  name: "fetch-and-summarize",
  description: "demo",
  goal: "demo",
  inputs: [],
  steps: [
    {
      kind: "tool_call",
      label: "fetch",
      tool: "fetch-mail",
      arguments: { folder: { kind: "literal", value: "inbox" } },
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

test("parser: accepts a valid workflow", () => {
  const out = parseWorkflow(VALID);
  assert.equal(out.ok, true);
  if (out.ok) assert.deepEqual(out.workflow, VALID);
});

test("parser: rejects missing required fields", () => {
  const out = parseWorkflow({ schemaVersion: 1, steps: [] });
  assert.equal(out.ok, false);
  if (!out.ok) assert.ok(out.errors.length > 0);
});

test("parser: rejects unknown step kinds at structural level", () => {
  const bad = { ...VALID, steps: [{ ...VALID.steps[0], kind: "branch" }] };
  const out = parseWorkflow(bad);
  assert.equal(out.ok, false);
});

test("parser: rejects literal {ref:'x'} as a SymRef shape", () => {
  // The discriminator on `kind` keeps this unambiguous.
  const bad = {
    ...VALID,
    steps: [{ ...VALID.steps[0], arguments: { folder: { ref: "emails" } } }],
  };
  const out = parseWorkflow(bad);
  assert.equal(out.ok, false);
});

test("parser: rejects extra top-level keys (additionalProperties:false)", () => {
  const bad = { ...VALID, mystery: 1 } as unknown;
  const out = parseWorkflow(bad);
  assert.equal(out.ok, false);
});

test("parser: rejects empty steps array", () => {
  const bad = { ...VALID, steps: [] };
  const out = parseWorkflow(bad);
  assert.equal(out.ok, false);
});

test("parser: accepts null return", () => {
  const ok = { ...VALID, return: null };
  const out = parseWorkflow(ok);
  assert.equal(out.ok, true);
});

test("parser: accepts SymRef with optional path (ADR 003)", () => {
  const ok = {
    ...VALID,
    steps: [{
      ...VALID.steps[0],
      arguments: { input: { kind: "symref", ref: "r_0_fetch", path: "text" } },
    }],
  };
  const out = parseWorkflow(ok);
  assert.equal(out.ok, true);
  if (out.ok) {
    const arg = out.workflow.steps[0]!.arguments.input!;
    assert.equal(arg.kind, "symref");
    if (arg.kind === "symref") assert.equal(arg.path, "text");
  }
});

test("parser: accepts return.source with optional path", () => {
  const ok = {
    ...VALID,
    return: { source: { kind: "symref", ref: "r0", path: "text" } },
  };
  const out = parseWorkflow(ok);
  assert.equal(out.ok, true);
});

test("parser: rejects empty SymRef.path", () => {
  const bad = {
    ...VALID,
    steps: [{
      ...VALID.steps[0],
      arguments: { input: { kind: "symref", ref: "r_0_fetch", path: "" } },
    }],
  };
  const out = parseWorkflow(bad);
  assert.equal(out.ok, false);
});
