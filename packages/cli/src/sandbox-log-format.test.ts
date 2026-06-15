import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSandboxDetail, SANDBOX_DETAIL_KIND, writeSandboxLogLine } from "./sandbox-log-format.ts";

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

test("writeSandboxLogLine: badge, message, and detail table", () => {
  const out = stripAnsi(captureStderr(() =>
    writeSandboxLogLine("sandbox writing args frame to child stdin", "tool=write-file-text op=args"),
  ));
  assert.match(out, /SANDBOX/);
  assert.match(out, /sandbox writing args frame/);
  assert.match(out, /write-file-text/);
  assert.match(out, /args/);
  assert.ok(!out.includes("tool=write-file-text"));
  assert.ok(out.split("\n").length >= 3);
  assert.ok(out.endsWith("\n"));
});

test("writeSandboxLogLine: error styling with detail table", () => {
  const out = stripAnsi(captureStderr(() =>
    writeSandboxLogLine("sandbox tool child killed", "tool=x pid=1", { error: true }),
  ));
  assert.match(out, /SANDBOX/);
  assert.match(out, /killed/);
  assert.match(out, /\bx\b/);
  assert.match(out, /pid/);
  assert.ok(!out.includes("tool=x"));
});

test("writeSandboxLogLine: message only", () => {
  const out = stripAnsi(captureStderr(() => writeSandboxLogLine("child runner finished")));
  assert.match(out, /SANDBOX/);
  assert.match(out, /child runner finished/);
  assert.ok(!out.includes(" — "));
});

test("parseSandboxDetail: key=value pairs", () => {
  const parsed = parseSandboxDetail("tool=write-file-text op=args");
  assert.equal(parsed.kind, SANDBOX_DETAIL_KIND.table);
  if (parsed.kind === SANDBOX_DETAIL_KIND.table) {
    assert.deepEqual(parsed.rows, [
      ["tool", "write-file-text"],
      ["op", "args"],
    ]);
  }
});

test("parseSandboxDetail: value may contain equals signs", () => {
  const parsed = parseSandboxDetail("hash=abc=def");
  assert.equal(parsed.kind, SANDBOX_DETAIL_KIND.table);
  if (parsed.kind === SANDBOX_DETAIL_KIND.table) {
    assert.deepEqual(parsed.rows, [["hash", "abc=def"]]);
  }
});

test("parseSandboxDetail: plain text fallback", () => {
  const parsed = parseSandboxDetail("Error: something\n  at foo.js:1");
  assert.equal(parsed.kind, SANDBOX_DETAIL_KIND.text);
});

test("writeSandboxLogLine: renders detail table on separate lines", () => {
  const out = stripAnsi(captureStderr(() =>
    writeSandboxLogLine("sandbox tool child spawned", "pid=9442 tool=write-file-text net=none"),
  ));
  assert.match(out, /SANDBOX/);
  assert.match(out, /sandbox tool child spawned/);
  assert.match(out, /9442/);
  assert.match(out, /write-file-text/);
  assert.ok(out.split("\n").length >= 3);
});
