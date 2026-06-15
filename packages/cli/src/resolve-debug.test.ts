import { test } from "node:test";
import assert from "node:assert/strict";
import type { DebugEvent } from "@meta-agent/core";
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

function captureSinkOutput(event: DebugEvent): string {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    createStderrDebugSink()(event);
  } finally {
    process.stderr.write = orig;
  }
  return lines.join("");
}

test("createStderrDebugSink: circular payload falls back to inspect without throwing", () => {
  const o: Record<string, unknown> = {};
  o.self = o;
  const out = captureSinkOutput({ kind: "circular", data: o });
  assert.match(out, /DEBUG/);
  assert.match(out, /circular/);
  assert.match(out, /Circular|self/);
});

test("createStderrDebugSink: normal JSON on indented lines", () => {
  const out = captureSinkOutput({ kind: "openai.chat.completion", data: { id: "abc" } });
  assert.match(out, /DEBUG/);
  assert.match(out, /openai\.chat\.completion/);
  assert.match(out, /"id"/);
  assert.match(out, /\n  /);
});

test("createStderrDebugSink: large payload shows truncation", () => {
  const out = captureSinkOutput({ kind: "huge", data: { pad: "z".repeat(5000) } });
  assert.match(out, /truncated, \d+ chars total/);
});
