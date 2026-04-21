import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsToolRegistry } from "./fs-registry.ts";
import type { Tool, ApprovalRecord } from "../types.ts";

const sample = (name: string, deps: string[] = []): Tool => ({
  code: "export async function run(i){return i;}",
  manifest: {
    name,
    description: `desc of ${name}`,
    rationale: "r",
    inputSchema: { type: "object" },
    outputShape: { type: "object" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: deps,
    limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    hash: "sha256:" + "a".repeat(64),
    createdAt: "2026-04-21T00:00:00Z",
    kind: deps.length ? "composite" : "atomic",
  },
});

const approval: ApprovalRecord = {
  hash: "sha256:" + "a".repeat(64),
  approvedAt: "2026-04-21T00:00:00Z",
  approvedBy: "test",
  alwaysApprove: false,
};

async function tmp() {
  return mkdtemp(join(tmpdir(), "meta-agent-reg-"));
}

test("save/get roundtrip", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    await reg.save(sample("alpha"), approval);
    const got = await reg.get("alpha");
    assert.ok(got);
    assert.equal(got.manifest.name, "alpha");
    assert.equal(got.code, "export async function run(i){return i;}");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list returns summaries", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    await reg.save(sample("alpha"), approval);
    await reg.save(sample("bravo"), approval);
    const names = (await reg.list()).map((t) => t.name).sort();
    assert.deepEqual(names, ["alpha", "bravo"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getApproval returns saved record", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    await reg.save(sample("alpha"), approval);
    const got = await reg.getApproval("alpha");
    assert.deepEqual(got, approval);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getDependents finds composites that reference a tool", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    await reg.save(sample("base"), approval);
    await reg.save(sample("comp", ["base"]), approval);
    assert.deepEqual(await reg.getDependents("base"), ["comp"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete refuses when dependents exist unless cascade", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    await reg.save(sample("base"), approval);
    await reg.save(sample("comp", ["base"]), approval);
    await assert.rejects(reg.delete("base"), /dependents/i);
    await reg.delete("base", { cascade: true });
    assert.equal(await reg.get("base"), null);
    assert.equal(await reg.get("comp"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry rehydrates from disk on reopen", async () => {
  const dir = await tmp();
  try {
    let reg = await FsToolRegistry.open(dir);
    await reg.save(sample("alpha"), approval);
    reg = await FsToolRegistry.open(dir);
    assert.equal((await reg.list()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
