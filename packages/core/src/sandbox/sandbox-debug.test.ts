import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SANDBOX_DEBUG_ENV,
  sandboxDebug,
  setSandboxDebugSink,
} from "./sandbox-debug.ts";

test("setSandboxDebugSink: routes messages to custom sink", () => {
  const prev = process.env[SANDBOX_DEBUG_ENV];
  process.env[SANDBOX_DEBUG_ENV] = "1";
  const lines: Array<{ message: string; detail?: string; error?: boolean }> = [];
  setSandboxDebugSink((message, detail, opts) => {
    lines.push(
      detail !== undefined
        ? { message, detail, ...(opts?.error ? { error: true } : {}) }
        : { message, ...(opts?.error ? { error: true } : {}) },
    );
  });
  try {
    sandboxDebug("test message", "detail=value");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.message, "test message");
    assert.equal(lines[0]?.detail, "detail=value");
  } finally {
    setSandboxDebugSink(undefined);
    if (prev === undefined) delete process.env[SANDBOX_DEBUG_ENV];
    else process.env[SANDBOX_DEBUG_ENV] = prev;
  }
});
