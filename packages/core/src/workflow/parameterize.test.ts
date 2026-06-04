import { test } from "node:test";
import assert from "node:assert/strict";
import { parameterize, jsonSchemaTypeOf } from "./parameterize.ts";
import { ARG_KIND, STEP_KIND, IR_SCHEMA_VERSION, type Workflow } from "./types.ts";

function baseWorkflow(): Workflow {
  return {
    schemaVersion: IR_SCHEMA_VERSION,
    name: "summarize_paper",
    description: "",
    goal: "",
    inputs: [],
    steps: [
      {
        kind: STEP_KIND.tool_call,
        label: "step_0_fetch_webpage_text",
        tool: "fetch-webpage-text",
        arguments: { url: { kind: ARG_KIND.literal, value: "https://example.com/p.md" } },
        resultBinding: "r_0_fetch_webpage_text",
      },
      {
        kind: STEP_KIND.tool_call,
        label: "step_1_write_file_text",
        tool: "write-file-text",
        arguments: {
          content: { kind: ARG_KIND.symref, ref: "r_0_fetch_webpage_text" },
          path: { kind: ARG_KIND.literal, value: "./out.md" },
        },
        resultBinding: "r_1_write_file_text",
      },
    ],
    return: { source: { kind: ARG_KIND.symref, ref: "r_1_write_file_text" } },
  };
}

test("jsonSchemaTypeOf infers JSON types", () => {
  assert.deepEqual(jsonSchemaTypeOf("x"), { type: "string" });
  assert.deepEqual(jsonSchemaTypeOf(3), { type: "number" });
  assert.deepEqual(jsonSchemaTypeOf(true), { type: "boolean" });
  assert.deepEqual(jsonSchemaTypeOf([1]), { type: "array" });
  assert.deepEqual(jsonSchemaTypeOf(null), { type: "null" });
  assert.deepEqual(jsonSchemaTypeOf({ a: 1 }), { type: "object" });
});

test("parameterize: optional promotion stores default = original literal and rewrites to symref", () => {
  const out = parameterize(baseWorkflow(), [
    { stepLabel: "step_0_fetch_webpage_text", argName: "url", paramName: "url", required: false, description: "paper url" },
  ]);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.workflow.inputs, [
    { name: "url", schema: { type: "string" }, required: false, default: "https://example.com/p.md", description: "paper url" },
  ]);
  assert.deepEqual(out.workflow.steps[0]!.arguments.url, { kind: ARG_KIND.symref, ref: "url" });
});

test("parameterize: required promotion omits default", () => {
  const out = parameterize(baseWorkflow(), [
    { stepLabel: "step_1_write_file_text", argName: "path", paramName: "path", required: true },
  ]);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.workflow.inputs.length, 1);
  assert.equal(out.workflow.inputs[0]!.name, "path");
  assert.equal("default" in out.workflow.inputs[0]!, false);
});

test("parameterize: shared paramName across two occurrences collapses to one input", () => {
  const wf = baseWorkflow();
  wf.steps[0]!.arguments.dup = { kind: ARG_KIND.literal, value: "same" };
  wf.steps[1]!.arguments.dup = { kind: ARG_KIND.literal, value: "same" };
  const out = parameterize(wf, [
    { stepLabel: "step_0_fetch_webpage_text", argName: "dup", paramName: "shared", required: true },
    { stepLabel: "step_1_write_file_text", argName: "dup", paramName: "shared", required: true },
  ]);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.workflow.inputs.length, 1);
  assert.deepEqual(out.workflow.steps[0]!.arguments.dup, { kind: ARG_KIND.symref, ref: "shared" });
  assert.deepEqual(out.workflow.steps[1]!.arguments.dup, { kind: ARG_KIND.symref, ref: "shared" });
});

test("parameterize: error when target step/arg missing", () => {
  const out = parameterize(baseWorkflow(), [
    { stepLabel: "nope", argName: "url", paramName: "u", required: true },
  ]);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.errors[0]!.code, "promotion_target_missing");
});

test("parameterize: error when target arg is not a literal", () => {
  const out = parameterize(baseWorkflow(), [
    { stepLabel: "step_1_write_file_text", argName: "content", paramName: "c", required: true },
  ]);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.errors[0]!.code, "promotion_target_not_literal");
});

test("parameterize: error on conflicting metadata for shared name", () => {
  const wf = baseWorkflow();
  wf.steps[0]!.arguments.dup = { kind: ARG_KIND.literal, value: "a" };
  wf.steps[1]!.arguments.dup = { kind: ARG_KIND.literal, value: 7 };
  const out = parameterize(wf, [
    { stepLabel: "step_0_fetch_webpage_text", argName: "dup", paramName: "shared", required: true },
    { stepLabel: "step_1_write_file_text", argName: "dup", paramName: "shared", required: true },
  ]);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.errors[0]!.code, "promotion_name_conflict");
});

test("parameterize: deterministic — same input twice yields identical output", () => {
  const promos = [{ stepLabel: "step_0_fetch_webpage_text", argName: "url", paramName: "url", required: false }];
  const a = parameterize(baseWorkflow(), promos);
  const b = parameterize(baseWorkflow(), promos);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(JSON.stringify(a.workflow), JSON.stringify(b.workflow));
});

test("parameterize: no promotions returns an equivalent workflow", () => {
  const out = parameterize(baseWorkflow(), []);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.workflow.inputs, []);
});
