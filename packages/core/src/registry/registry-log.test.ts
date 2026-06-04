import { test } from "node:test";
import assert from "node:assert/strict";
import { isENOENT, registryDebugEnabled, REGISTRY_DEBUG_ENV } from "./registry-log.ts";

test("isENOENT recognizes ENOENT errors", () => {
  assert.equal(isENOENT(Object.assign(new Error("x"), { code: "ENOENT" })), true);
  assert.equal(isENOENT(Object.assign(new Error("x"), { code: "EACCES" })), false);
  assert.equal(isENOENT("nope"), false);
});

test("registryDebugEnabled follows REGISTRY_DEBUG_ENV", () => {
  const prev = process.env[REGISTRY_DEBUG_ENV];
  try {
    delete process.env[REGISTRY_DEBUG_ENV];
    assert.equal(registryDebugEnabled(), false);
    process.env[REGISTRY_DEBUG_ENV] = "1";
    assert.equal(registryDebugEnabled(), true);
    process.env[REGISTRY_DEBUG_ENV] = "0";
    assert.equal(registryDebugEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env[REGISTRY_DEBUG_ENV];
    else process.env[REGISTRY_DEBUG_ENV] = prev;
  }
});
