import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, hashTool } from "./hash.ts";

test("canonicalJson sorts object keys deterministically", () => {
  const a = canonicalJson({ b: 1, a: 2, c: { z: 3, y: 4 } });
  const b = canonicalJson({ a: 2, c: { y: 4, z: 3 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":{"y":4,"z":3}}');
});

test("canonicalJson preserves array order", () => {
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
});

test("hashTool is stable under key reordering of manifest", () => {
  const code = "export async function run(){return 1;}";
  const manifest1 = { name: "t", x: 1, y: 2 };
  const manifest2 = { y: 2, name: "t", x: 1 };
  assert.equal(hashTool(code, manifest1 as any), hashTool(code, manifest2 as any));
});

test("hashTool changes when code changes", () => {
  const manifest = { name: "t" } as any;
  assert.notEqual(hashTool("a", manifest), hashTool("b", manifest));
});

test("hashTool produces sha256:<hex> format", () => {
  const h = hashTool("x", { name: "t" } as any);
  assert.match(h, /^sha256:[a-f0-9]{64}$/);
});
