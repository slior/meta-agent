import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceStringifiedJsonInput, rootJsonSchemaKind } from "./coerce-tool-input.ts";

test("rootJsonSchemaKind accepts only exact object or array", () => {
  assert.equal(rootJsonSchemaKind({ type: "object" }), "object");
  assert.equal(rootJsonSchemaKind({ type: "array" }), "array");
  assert.equal(rootJsonSchemaKind({ type: "string" }), null);
  assert.equal(rootJsonSchemaKind({}), null);
  assert.equal(rootJsonSchemaKind({ oneOf: [{ type: "object" }] }), null);
  assert.equal(rootJsonSchemaKind({ type: ["object", "null"] } as Record<string, unknown>), null);
});

test("coerceStringifiedJsonInput leaves non-string or null kind unchanged", () => {
  assert.deepEqual(coerceStringifiedJsonInput({ a: 1 }, "object"), { a: 1 });
  assert.equal(coerceStringifiedJsonInput('{"a":1}', null), '{"a":1}');
});

test("coerce object-typed string JSON to object", () => {
  assert.deepEqual(coerceStringifiedJsonInput('{"path":"/x","lines":3}', "object"), { path: "/x", lines: 3 });
});

test("coerce array-typed string JSON to array", () => {
  assert.deepEqual(coerceStringifiedJsonInput("[1,2,3]", "array"), [1, 2, 3]);
});

test("coerce object kind rejects JSON array string", () => {
  assert.equal(coerceStringifiedJsonInput("[1,2]", "object"), "[1,2]");
});

test("coerce array kind rejects JSON object string", () => {
  assert.equal(coerceStringifiedJsonInput('{"a":1}', "array"), '{"a":1}');
});

test("coerce object kind keeps string on invalid JSON", () => {
  assert.equal(coerceStringifiedJsonInput("not-json{", "object"), "not-json{");
});

test("coerce object kind keeps string when parse yields non-object", () => {
  assert.equal(coerceStringifiedJsonInput('"hello"', "object"), '"hello"');
});
