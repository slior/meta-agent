import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLLMGenerateTool, LLM_GENERATE_NAME, seedBuiltins } from "./builtins.ts";
import { FsToolRegistry } from "../registry/fs-registry.ts";
import { SOURCE_LABEL, TOOL_CAPABILITY } from "../types.ts";

test("llm_generate is atomic, declares llm capability, no net/env, taint-labeled", () => {
  const t = buildLLMGenerateTool();
  assert.equal(t.manifest.name, LLM_GENERATE_NAME);
  assert.equal(t.manifest.kind, "atomic");
  assert.deepEqual(t.manifest.capabilities, [TOOL_CAPABILITY.LLM]);
  assert.equal(t.manifest.permissions.net, "none");
  assert.deepEqual(t.manifest.permissions.env, []);
  assert.deepEqual(t.manifest.sourceLabels, [SOURCE_LABEL.LLM_GENERATED]);
  assert.match(t.manifest.hash, /^sha256:[0-9a-f]{64}$/);
});

test("buildLlmGenerateTool is deterministic", () => {
  assert.equal(buildLLMGenerateTool().manifest.hash, buildLLMGenerateTool().manifest.hash);
});

test("seedBuiltins registers llm_generate once with an always-approve record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seed-"));
  try {
    const reg = await FsToolRegistry.open(dir);
    await seedBuiltins(reg);
    await seedBuiltins(reg); // idempotent
    assert.equal(await reg.has(LLM_GENERATE_NAME), true);
    const approval = await reg.getApproval(LLM_GENERATE_NAME);
    assert.equal(approval?.alwaysApprove, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
