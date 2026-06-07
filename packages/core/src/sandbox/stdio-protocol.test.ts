import { test } from "node:test";
import assert from "node:assert/strict";
import { SANDBOX_STDIO_OP } from "./stdio-protocol.ts";

test("protocol defines llm and llmResult ops", () => {
  assert.equal(SANDBOX_STDIO_OP.llm, "llm");
  assert.equal(SANDBOX_STDIO_OP.llmResult, "llmResult");
});
