import { test } from "node:test";
import assert from "node:assert/strict";
import { createStderrDebugSink, resolveDebugEnabled } from "./resolve-debug.ts";

test("resolveDebugEnabled: unset env and no CLI => false", () => {
  assert.equal(resolveDebugEnabled({}, undefined), false);
});

test("resolveDebugEnabled: META_AGENT_DEBUG=1 and no CLI => true", () => {
  assert.equal(resolveDebugEnabled({}, "1"), true);
});

test("resolveDebugEnabled: META_AGENT_DEBUG=true (case) => true", () => {
  assert.equal(resolveDebugEnabled({}, "TRUE"), true);
});

test("resolveDebugEnabled: META_AGENT_DEBUG=yes => true", () => {
  assert.equal(resolveDebugEnabled({}, "yes"), true);
});

test("resolveDebugEnabled: META_AGENT_DEBUG=0 => false", () => {
  assert.equal(resolveDebugEnabled({}, "0"), false);
});

test("resolveDebugEnabled: --debug wins over env off", () => {
  assert.equal(resolveDebugEnabled({ debug: true }, "0"), true);
});

test("resolveDebugEnabled: --no-debug wins over env on", () => {
  assert.equal(resolveDebugEnabled({ "no-debug": true }, "1"), false);
});

test("resolveDebugEnabled: --debug wins over --no-debug and env", () => {
  assert.equal(resolveDebugEnabled({ debug: true, "no-debug": true }, "0"), true);
});

test("resolveDebugEnabled: unknown env value => false", () => {
  assert.equal(resolveDebugEnabled({}, "maybe"), false);
});

test("createStderrDebugSink: circular payload falls back to inspect without throwing", () => {
  const o: Record<string, unknown> = {};
  o.self = o;
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    createStderrDebugSink()({ kind: "circular", data: o });
  } finally {
    process.stderr.write = orig;
  }
  assert.ok(lines.some((l) => l.includes("[meta-agent:debug] circular")));
});
