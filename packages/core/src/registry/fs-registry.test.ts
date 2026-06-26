import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsToolRegistry } from "./fs-registry.ts";
import { INTEGRITY_STATUS, RegistryIntegrityError } from "./integrity.ts";
import type { Tool } from "../types.ts";
import { makeConsistentApproval, makeConsistentTool } from "../testing/tool-fixtures.ts";

const BODY = "export async function run(i){return i;}";

const sample = (name: string, deps: string[] = []): Tool =>
  makeConsistentTool(
    {
      name,
      description: `desc of ${name}`,
      rationale: "r",
      inputSchema: { type: "object" },
      outputShape: { type: "object" },
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: deps,
      limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
      createdAt: "2026-04-21T00:00:00Z",
      kind: deps.length ? "composite" : "atomic",
    },
    BODY,
  );

async function tmp() {
  return mkdtemp(join(tmpdir(), "meta-agent-reg-"));
}

test("save/get roundtrip", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    await reg.save(t, makeConsistentApproval(t));
    const got = await reg.get("alpha");
    assert.ok(got);
    assert.equal(got.manifest.name, "alpha");
    assert.equal(got.code, BODY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list returns summaries", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const alpha = sample("alpha");
    const bravo = sample("bravo");
    await reg.save(alpha, makeConsistentApproval(alpha));
    await reg.save(bravo, makeConsistentApproval(bravo));
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
    const t = sample("alpha");
    const approval = makeConsistentApproval(t);
    await reg.save(t, approval);
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
    const base = sample("base");
    const comp = sample("comp", ["base"]);
    await reg.save(base, makeConsistentApproval(base));
    await reg.save(comp, makeConsistentApproval(comp));
    assert.deepEqual(await reg.getDependents("base"), ["comp"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete refuses when dependents exist unless cascade", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const base = sample("base");
    const comp = sample("comp", ["base"]);
    await reg.save(base, makeConsistentApproval(base));
    await reg.save(comp, makeConsistentApproval(comp));
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
    const t = sample("alpha");
    await reg.save(t, makeConsistentApproval(t));
    reg = await FsToolRegistry.open(dir);
    assert.equal((await reg.list()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load quarantines a tool whose code was edited after approval", async () => {
  const dir = await tmp();
  try {
    let reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    await reg.save(t, makeConsistentApproval(t));
    // Tamper with the body on disk, leaving manifest.json/approval.json intact.
    await writeFile(join(dir, "alpha", "tool.ts"), "export async function run(i){return 'evil';}", "utf8");
    reg = await FsToolRegistry.open(dir);
    assert.equal(await reg.get("alpha"), null);
    assert.equal((await reg.list()).length, 0);
    const report = reg.integrityReport();
    assert.equal(report.length, 1);
    const issue = report[0];
    assert.ok(issue);
    assert.equal(issue.name, "alpha");
    assert.equal(issue.status, INTEGRITY_STATUS.quarantined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load marks needs-review when approval hash no longer matches manifest", async () => {
  const dir = await tmp();
  try {
    let reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    await reg.save(t, makeConsistentApproval(t));
    // Replace approval.json with a stale (non-matching) hash; body+manifest stay consistent.
    const stale = { hash: "sha256:" + "c".repeat(64), approvedAt: "x", approvedBy: "u", alwaysApprove: true };
    await writeFile(join(dir, "alpha", "approval.json"), JSON.stringify(stale, null, 2), "utf8");
    reg = await FsToolRegistry.open(dir);
    assert.ok(await reg.get("alpha")); // still discoverable
    assert.equal(await reg.getApproval("alpha"), null); // approval not bound
    const report = reg.integrityReport();
    assert.equal(report.length, 1);
    const issue = report[0];
    assert.ok(issue);
    assert.equal(issue.status, INTEGRITY_STATUS.needsReview);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("save throws when manifest hash does not match the body", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    const broken = { ...t, manifest: { ...t.manifest, hash: "sha256:" + "d".repeat(64) } };
    await assert.rejects(reg.save(broken, makeConsistentApproval(t)), RegistryIntegrityError);
    const reopened = await FsToolRegistry.open(dir);
    assert.equal(await reopened.get("alpha"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("save throws when approval hash does not bind to the manifest", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    const badApproval = { hash: "sha256:" + "e".repeat(64), approvedAt: "x", approvedBy: "u", alwaysApprove: false };
    await assert.rejects(reg.save(t, badApproval), RegistryIntegrityError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load logs a warning for each integrity issue", async () => {
  const dir = await tmp();
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    captured += s;
    return true;
  };
  try {
    let reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    await reg.save(t, makeConsistentApproval(t));
    await writeFile(join(dir, "alpha", "tool.ts"), "export async function run(i){return 0;}", "utf8");
    reg = await FsToolRegistry.open(dir);
    assert.match(captured, /warn:/);
    assert.match(captured, /alpha/);
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
    await rm(dir, { recursive: true, force: true });
  }
});
