import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

test("loadConfig resolves relative paths against config dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfg-"));
  try {
    await writeFile(join(dir, "c.json"), JSON.stringify({
      llm: { model: "m", apiKeyEnv: "K" },
      workspace: "./w",
    }));
    const c = await loadConfig(join(dir, "c.json"));
    assert.equal(c.workspace, join(dir, "w"));
    assert.equal(c.llm.model, "m");
    assert.equal(c.yolo, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig fails on missing llm.model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfg-"));
  try {
    await writeFile(join(dir, "c.json"), JSON.stringify({ llm: { apiKeyEnv: "K" } }));
    await assert.rejects(loadConfig(join(dir, "c.json")), /llm\.model/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
