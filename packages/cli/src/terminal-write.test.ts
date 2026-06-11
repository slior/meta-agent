import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDebugPayload,
  writeDebugEvent,
  writeProgressLine,
} from "./terminal-write.ts";

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join("");
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("writeProgressLine: assembles meta, detail, body, newline", () => {
  const out = captureStderr(() =>
    writeProgressLine({
      time: "12:04:05",
      label: "tool-invoked",
      detail: "read_file",
      body: "Executed in 42ms — success",
      status: "ok",
    }),
  );
  const plain = stripAnsi(out);
  assert.ok(plain.endsWith("\n"));
  assert.match(plain, /12:04:05/);
  assert.match(plain, /tool-invoked/);
  assert.match(plain, /read_file/);
  assert.match(plain, /Executed in 42ms/);
});

test("writeProgressLine: pending status includes body text", () => {
  const out = stripAnsi(captureStderr(() =>
    writeProgressLine({
      time: "12:04:05",
      label: "llm-turn-start",
      detail: "2",
      body: "LLM request…",
      status: "pending",
    }),
  ));
  assert.match(out, /LLM request/);
});

test("writeProgressLine: fail status includes body text", () => {
  const out = stripAnsi(captureStderr(() =>
    writeProgressLine({
      time: "12:04:05",
      label: "tool-call",
      detail: "bad",
      body: "Tool call: bad → failed",
      status: "fail",
    }),
  ));
  assert.match(out, /failed/);
});

test("writeProgressLine: without detail", () => {
  const out = stripAnsi(captureStderr(() =>
    writeProgressLine({
      time: "12:04:05",
      label: "llm-synthesis-start",
      body: "LLM: final answer…",
      status: "pending",
    }),
  ));
  assert.match(out, /llm-synthesis-start/);
  assert.ok(!out.includes("  undefined"));
});

test("formatDebugPayload: normal JSON", () => {
  const r = formatDebugPayload({ key: "value" });
  assert.equal(r.truncated, false);
  assert.match(r.payload, /"key"/);
  assert.match(r.payload, /\n/);
});

test("formatDebugPayload: circular uses inspect", () => {
  const o: Record<string, unknown> = {};
  o.self = o;
  const r = formatDebugPayload(o);
  assert.equal(r.truncated, false);
  assert.match(r.payload, /Circular|self/);
});

test("formatDebugPayload: under limit not truncated", () => {
  const r = formatDebugPayload({ pad: "a".repeat(100) });
  assert.equal(r.truncated, false);
});

test("formatDebugPayload: over limit truncates at 4000", () => {
  const r = formatDebugPayload({ pad: "x".repeat(5000) });
  assert.equal(r.truncated, true);
  assert.equal(r.payload.length, 4000);
  assert.ok(r.totalChars! > 4000);
});

test("formatDebugPayload: exactly 4000 chars not truncated", () => {
  let padLen = 0;
  for (let n = 3900; n <= 4100; n++) {
    if (JSON.stringify({ a: "x".repeat(n) }, null, 2).length === 4000) {
      padLen = n;
      break;
    }
  }
  assert.ok(padLen > 0, "fixture must exist");
  const r = formatDebugPayload({ a: "x".repeat(padLen) });
  assert.equal(r.truncated, false);
  assert.equal(r.payload.length, 4000);
});

test("writeDebugEvent: header and indented payload", () => {
  const out = stripAnsi(captureStderr(() =>
    writeDebugEvent("test.kind", { foo: 1 }, "2026-06-11T12:04:05.123Z"),
  ));
  const lines = out.trimEnd().split("\n");
  assert.ok(lines.length >= 2);
  assert.match(lines[0]!, /12:04:05/);
  assert.match(lines[0]!, /DEBUG/);
  assert.match(lines[0]!, /test\.kind/);
  assert.ok(lines[1]!.startsWith("  "));
  assert.match(out, /"foo"/);
});

test("writeDebugEvent: truncation line only when needed", () => {
  const big = { pad: "y".repeat(5000) };
  const out = stripAnsi(captureStderr(() =>
    writeDebugEvent("big", big, "2026-06-11T12:04:05.123Z"),
  ));
  assert.match(out, /truncated, \d+ chars total/);
});

test("writeDebugEvent: small payload has no truncation line", () => {
  const out = stripAnsi(captureStderr(() =>
    writeDebugEvent("small", { a: 1 }, "2026-06-11T12:04:05.123Z"),
  ));
  assert.ok(!out.includes("truncated"));
});
