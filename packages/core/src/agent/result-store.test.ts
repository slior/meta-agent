import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ResultStore, isRefSentinel, resolveRefs, describeForModel,
  ELISION_MAX_BYTES, sanitizeBinding,
} from "./result-store.ts";

test("isRefSentinel accepts {$ref} and {$ref,path}, rejects others", () => {
  assert.equal(isRefSentinel({ $ref: "r_0_x" }), true);
  assert.equal(isRefSentinel({ $ref: "r_0_x", path: "text" }), true);
  assert.equal(isRefSentinel({ $ref: "r_0_x", path: 3 }), false);
  assert.equal(isRefSentinel({ $ref: "r_0_x", extra: 1 }), false);
  assert.equal(isRefSentinel({ ref: "r_0_x" }), false);
  assert.equal(isRefSentinel("r_0_x"), false);
  assert.equal(isRefSentinel(null), false);
});

test("resolveRefs substitutes whole-value and projected refs", () => {
  const store = new ResultStore();
  store.put("r_0_fetch", { text: "BODY", title: "T" });
  const out = resolveRefs(
    { content: { $ref: "r_0_fetch" }, input: { $ref: "r_0_fetch", path: "text" }, lit: 5 },
    store,
  );
  assert.equal(out.ok, true);
  assert.deepEqual((out as { ok: true; value: unknown }).value, {
    content: { text: "BODY", title: "T" }, input: "BODY", lit: 5,
  });
});

test("resolveRefs reports unknown ref and missing path", () => {
  const store = new ResultStore();
  store.put("r_0_fetch", { text: "BODY" });
  const a = resolveRefs({ x: { $ref: "r_9_nope" } }, store);
  assert.equal(a.ok, false);
  assert.match((a as { ok: false; error: string }).error, /unknown ref 'r_9_nope'/);
  const b = resolveRefs({ x: { $ref: "r_0_fetch", path: "missing" } }, store);
  assert.equal(b.ok, false);
  assert.match((b as { ok: false; error: string }).error, /no key 'missing'/);
});

test("resolveRefs passes non-object args through unchanged", () => {
  const store = new ResultStore();
  const out = resolveRefs("just-a-string", store);
  assert.deepEqual(out, { ok: true, value: "just-a-string" });
});

test("describeForModel inlines small values and elides large ones", () => {
  const small = describeForModel({ a: 1 }, "r_0_x") as Record<string, unknown>;
  assert.equal(small.ref, "r_0_x");
  assert.deepEqual(small.value, { a: 1 });
  assert.equal("preview" in small, false);

  const big = { text: "x".repeat(ELISION_MAX_BYTES + 50) };
  const elided = describeForModel(big, "r_1_fetch") as Record<string, unknown>;
  assert.equal(elided.ref, "r_1_fetch");
  assert.equal("value" in elided, false);
  assert.deepEqual(elided.shape, { type: "object", keys: ["text"] });
  assert.equal(typeof elided.preview, "string");
});

test("sanitizeBinding lowercases and replaces non-word chars", () => {
  assert.equal(sanitizeBinding("Fetch-Webpage-Text"), "fetch_webpage_text");
});
