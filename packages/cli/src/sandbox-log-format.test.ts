import { test } from "node:test";
import assert from "node:assert/strict";
import { writeSandboxLogLine } from "./sandbox-log-format.ts";

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

test("writeSandboxLogLine: badge, message, and detail", () => {
  const out = stripAnsi(captureStderr(() =>
    writeSandboxLogLine("sandbox writing args frame to child stdin", "tool=write-file-text op=args"),
  ));
  assert.match(out, /SANDBOX/);
  assert.match(out, /sandbox writing args frame/);
  assert.match(out, /tool=write-file-text/);
  assert.ok(out.endsWith("\n"));
});

test("writeSandboxLogLine: error styling", () => {
  const out = stripAnsi(captureStderr(() =>
    writeSandboxLogLine("sandbox tool child killed", "tool=x pid=1", { error: true }),
  ));
  assert.match(out, /SANDBOX/);
  assert.match(out, /killed/);
  assert.match(out, /tool=x/);
});

test("writeSandboxLogLine: message only", () => {
  const out = stripAnsi(captureStderr(() => writeSandboxLogLine("child runner finished")));
  assert.match(out, /SANDBOX/);
  assert.match(out, /child runner finished/);
  assert.ok(!out.includes(" — "));
});
