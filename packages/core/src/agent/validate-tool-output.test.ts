import { test } from "node:test";
import assert from "node:assert/strict";
import { validateToolOutput } from "./validate-tool-output.ts";
import { TOOL_ERROR_KIND } from "../types.ts";

test("validateToolOutput: value matching schema returns ok:true, value unchanged", () => {
  const schema = { type: "object", properties: { count: { type: "number" } }, required: ["count"] };
  const value = { count: 42 };
  const result = validateToolOutput(schema, value);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, value);
});

test("validateToolOutput: value violating schema returns output_schema_violation", () => {
  const schema = { type: "object", properties: { count: { type: "number" } }, required: ["count"] };
  const result = validateToolOutput(schema, { count: "not-a-number" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, TOOL_ERROR_KIND.OUTPUT_SCHEMA_VIOLATION);
    assert.ok(result.error.message.includes("output"), "message references 'output'");
  }
});

test("validateToolOutput: empty schema {} passes any value", () => {
  assert.equal(validateToolOutput({}, "any string").ok, true);
  assert.equal(validateToolOutput({}, null).ok, true);
  assert.equal(validateToolOutput({}, [1, 2, 3]).ok, true);
  assert.equal(validateToolOutput({}, { anything: true }).ok, true);
});

test("validateToolOutput: malformed object-form schema returns output_schema_violation without throwing", () => {
  // { type: 42 } is not valid JSON Schema — type must be a string
  const result = validateToolOutput({ type: 42 } as unknown as Record<string, unknown>, "value");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, TOOL_ERROR_KIND.OUTPUT_SCHEMA_VIOLATION);
});

test("validateToolOutput: error details contains shallow-copied errors array", () => {
  const schema = { type: "number" };
  const result = validateToolOutput(schema, "not-a-number");
  assert.equal(result.ok, false);
  if (!result.ok) {
    const details = result.error.details as { errors: unknown[] } | undefined;
    assert.ok(Array.isArray(details?.errors), "details.errors is an array");
  }
});

test("validateToolOutput: same schema compiled once — repeated calls with same schema work", () => {
  const schema = { type: "string" };
  // First call: pass
  const r1 = validateToolOutput(schema, "hello");
  assert.equal(r1.ok, true);
  // Second call same schema: also pass (cache hit, no double-compile error)
  const r2 = validateToolOutput(schema, "world");
  assert.equal(r2.ok, true);
  // Third call: fail (violation still detected from cached validator)
  const r3 = validateToolOutput(schema, 42);
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.equal(r3.error.kind, TOOL_ERROR_KIND.OUTPUT_SCHEMA_VIOLATION);
});
