import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLiterate } from "./renderer.ts";
import type { Workflow } from "./types.ts";

const WF: Workflow = {
  schemaVersion: 1,
  name: "filter-and-count",
  description: "",
  goal: "",
  inputs: [],
  steps: [
    {
      kind: "tool_call",
      label: "step_0",
      tool: "read-csv",
      arguments: { path: { kind: "literal", value: "/x.csv" } },
      resultBinding: "r_0",
    },
    {
      kind: "tool_call",
      label: "step_1",
      tool: "count-rows",
      arguments: { rows: { kind: "symref", ref: "r_0" } },
      resultBinding: "r_1",
    },
  ],
  return: { source: { kind: "symref", ref: "r_1" } },
};

test("renderer: env-less render shows raw @names", () => {
  const out = renderLiterate(WF);
  assert.match(out, /Workflow: filter-and-count/);
  assert.match(out, /@r_0\s*←\s*read-csv\(path="\/x\.csv"\)/);
  assert.match(out, /@r_1\s*←\s*count-rows\(rows=@r_0\)/);
  assert.match(out, /Return: @r_1/);
});

test("renderer: env render substitutes values", () => {
  const env = new Map<string, unknown>([
    ["r_0", { rows: [{ a: 1 }] }],
    ["r_1", { count: 1 }],
  ]);
  const out = renderLiterate(WF, env);
  assert.match(out, /@r_0\s*=\s*\{"rows":\[\{"a":1\}\]\}/);
  assert.match(out, /@r_1\s*=\s*\{"count":1\}/);
});

test("renderer: deterministic — same workflow + env yields same string", () => {
  const env = new Map<string, unknown>([["r_0", 1], ["r_1", 2]]);
  assert.equal(renderLiterate(WF, env), renderLiterate(WF, env));
});

test("renderer: workflow with null return omits Return line", () => {
  const wf: Workflow = { ...WF, return: null };
  const out = renderLiterate(wf);
  assert.ok(!out.includes("Return:"));
});
