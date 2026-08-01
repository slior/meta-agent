import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FsToolRegistry } from "./fs-registry.ts";
import { INTEGRITY_REASON, INTEGRITY_STATUS, RegistryIntegrityError } from "./integrity.ts";
import type { CodeTool, WorkflowTool } from "../tool.ts";
import { hashToolBody } from "../hash.ts";
import type { ApprovalRecord, ToolManifest } from "../types.ts";
import type { Workflow } from "../workflow/types.ts";
import {
  makeConsistentApproval,
  makeConsistentCodeTool,
  makeConsistentWorkflowTool,
} from "../testing/tool-fixtures.ts";

const BODY = "export async function run(i){return i;}";

const LEGACY_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/legacy-registry", import.meta.url));

const manifestFields = (name: string, deps: string[] = []): Omit<ToolManifest, "hash" | "kind"> => ({
  name,
  description: `desc of ${name}`,
  rationale: "r",
  inputSchema: { type: "object" },
  outputShape: { type: "object" },
  permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  dependencies: deps,
  limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
  createdAt: "2026-04-21T00:00:00Z",
});

const sample = (name: string, deps: string[] = []): CodeTool =>
  makeConsistentCodeTool(
    { ...manifestFields(name, deps), kind: deps.length ? "composite" : "atomic" },
    BODY,
  );

const workflowIr = (name: string, overrides: Partial<Workflow> = {}): Workflow => ({
  schemaVersion: 1,
  name,
  description: "d",
  goal: "g",
  inputs: [],
  steps: [{ kind: "tool_call", label: "s0", tool: "alpha", arguments: {}, resultBinding: "r0" }],
  return: null,
  ...overrides,
});

const sampleWorkflow = (name: string, overrides: Partial<Workflow> = {}): WorkflowTool =>
  makeConsistentWorkflowTool({ ...manifestFields(name), kind: "workflow" }, workflowIr(name, overrides));

async function tmp() {
  return mkdtemp(join(tmpdir(), "meta-agent-reg-"));
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

test("saveCode/getCode roundtrip", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    await reg.saveCode(t, makeConsistentApproval(t));
    const got = await reg.getCode("alpha");
    assert.ok(got);
    assert.equal(got.manifest.name, "alpha");
    assert.equal(got.code, BODY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveWorkflow/getWorkflow roundtrip returns a WorkflowTool with typed IR", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const t = sampleWorkflow("wf");
    await reg.saveWorkflow(t, makeConsistentApproval(t));
    const got = await reg.getWorkflow("wf");
    assert.ok(got);
    assert.equal(got.manifest.name, "wf");
    assert.deepEqual(got.workflow, t.workflow);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cross-kind getters return null", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const code = sample("alpha");
    const wf = sampleWorkflow("wf");
    await reg.saveCode(code, makeConsistentApproval(code));
    await reg.saveWorkflow(wf, makeConsistentApproval(wf));
    assert.equal(await reg.getCode("wf"), null);
    assert.equal(await reg.getWorkflow("alpha"), null);
    assert.equal(await reg.getCode("nope"), null);
    assert.equal(await reg.getWorkflow("nope"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getManifest and getKind expose metadata without a body fetch", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const code = sample("alpha");
    const wf = sampleWorkflow("wf");
    await reg.saveCode(code, makeConsistentApproval(code));
    await reg.saveWorkflow(wf, makeConsistentApproval(wf));
    const manifest = await reg.getManifest("alpha");
    assert.ok(manifest);
    assert.equal(manifest.name, "alpha");
    assert.equal(manifest.hash, code.manifest.hash);
    assert.equal(await reg.getKind("alpha"), "atomic");
    assert.equal(await reg.getKind("wf"), "workflow");
    assert.equal(await reg.getManifest("nope"), null);
    assert.equal(await reg.getKind("nope"), null);
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
    await reg.saveCode(alpha, makeConsistentApproval(alpha));
    await reg.saveCode(bravo, makeConsistentApproval(bravo));
    const names = (await reg.list()).map((t) => t.name).sort();
    assert.deepEqual(names, ["alpha", "bravo"]);
    assert.deepEqual(reg.listSync().map((t) => t.name).sort(), ["alpha", "bravo"]);
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
    await reg.saveCode(t, approval);
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
    await reg.saveCode(base, makeConsistentApproval(base));
    await reg.saveCode(comp, makeConsistentApproval(comp));
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
    await reg.saveCode(base, makeConsistentApproval(base));
    await reg.saveCode(comp, makeConsistentApproval(comp));
    await assert.rejects(reg.delete("base"), /dependents/i);
    await reg.delete("base", { cascade: true });
    assert.equal(await reg.getCode("base"), null);
    assert.equal(await reg.getCode("comp"), null);
    assert.equal(await reg.has("base"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry rehydrates code and workflow entries from disk on reopen", async () => {
  const dir = await tmp();
  try {
    let reg = await FsToolRegistry.open(dir);
    const code = sample("alpha");
    const wf = sampleWorkflow("wf");
    await reg.saveCode(code, makeConsistentApproval(code));
    await reg.saveWorkflow(wf, makeConsistentApproval(wf));
    reg = await FsToolRegistry.open(dir);
    assert.equal((await reg.list()).length, 2);
    assert.equal(reg.integrityReport().length, 0);
    const reloaded = await reg.getWorkflow("wf");
    assert.ok(reloaded);
    assert.deepEqual(reloaded.workflow, wf.workflow);
    assert.equal((await reg.getCode("alpha"))?.code, BODY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load quarantines a tool whose code was edited after approval", async () => {
  const dir = await tmp();
  try {
    let reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    await reg.saveCode(t, makeConsistentApproval(t));
    // Tamper with the body on disk, leaving manifest.json/approval.json intact.
    await writeFile(join(dir, "alpha", "tool.ts"), "export async function run(i){return 'evil';}", "utf8");
    reg = await FsToolRegistry.open(dir);
    assert.equal(await reg.getCode("alpha"), null);
    assert.equal((await reg.list()).length, 0);
    const report = reg.integrityReport();
    assert.equal(report.length, 1);
    const issue = report[0];
    assert.ok(issue);
    assert.equal(issue.name, "alpha");
    assert.equal(issue.status, INTEGRITY_STATUS.QUARANTINED);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load marks needs-review when approval hash no longer matches manifest", async () => {
  const dir = await tmp();
  try {
    let reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    await reg.saveCode(t, makeConsistentApproval(t));
    // Replace approval.json with a stale (non-matching) hash; body+manifest stay consistent.
    const stale = { hash: "sha256:" + "c".repeat(64), approvedAt: "x", approvedBy: "u", alwaysApprove: true };
    await writeFile(join(dir, "alpha", "approval.json"), JSON.stringify(stale, null, 2), "utf8");
    reg = await FsToolRegistry.open(dir);
    assert.ok(await reg.getCode("alpha")); // still discoverable
    assert.equal(await reg.getApproval("alpha"), null); // approval not bound
    const report = reg.integrityReport();
    assert.equal(report.length, 1);
    const issue = report[0];
    assert.ok(issue);
    assert.equal(issue.status, INTEGRITY_STATUS.NEEDS_REVIEW);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load marks invalid when Link A passes but the workflow IR is unusable", async () => {
  const dir = await tmp();
  try {
    // Structurally invalid IR (no steps) whose bytes still match manifest.hash.
    const raw = JSON.stringify({
      schemaVersion: 1,
      name: "badwf",
      description: "d",
      goal: "g",
      inputs: [],
      steps: [],
      return: null,
    });
    const manifestSansHash = { ...manifestFields("badwf"), kind: "workflow" as const };
    const hash = hashToolBody(raw, manifestSansHash);
    const approval: ApprovalRecord = {
      hash,
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedBy: "test",
      alwaysApprove: false,
    };
    const sub = join(dir, "badwf");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "manifest.json"), JSON.stringify({ ...manifestSansHash, hash }, null, 2), "utf8");
    await writeFile(join(sub, "approval.json"), JSON.stringify(approval, null, 2), "utf8");
    await writeFile(join(sub, "workflow.json"), raw, "utf8");

    const reg = await FsToolRegistry.open(dir);
    assert.equal(await reg.getWorkflow("badwf"), null);
    assert.equal((await reg.list()).length, 0);
    const report = reg.integrityReport();
    assert.equal(report.length, 1);
    const issue = report[0];
    assert.ok(issue);
    assert.equal(issue.name, "badwf");
    assert.equal(issue.status, INTEGRITY_STATUS.INVALID);
    assert.equal(issue.reason, INTEGRITY_REASON.WORKFLOW_PARSE_FAILED);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveCode throws when manifest hash does not match the body", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    const broken: CodeTool = { ...t, manifest: { ...t.manifest, hash: "sha256:" + "d".repeat(64) } };
    await assert.rejects(reg.saveCode(broken, makeConsistentApproval(t)), RegistryIntegrityError);
    const reopened = await FsToolRegistry.open(dir);
    assert.equal(await reopened.getCode("alpha"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveCode throws when approval hash does not bind to the manifest", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    const badApproval = { hash: "sha256:" + "e".repeat(64), approvedAt: "x", approvedBy: "u", alwaysApprove: false };
    await assert.rejects(reg.saveCode(t, badApproval), RegistryIntegrityError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveWorkflow throws when the workflow fails structural parsing", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const t = sampleWorkflow("wf", { steps: [] });
    await assert.rejects(reg.saveWorkflow(t, makeConsistentApproval(t)), /workflow/i);
    assert.equal(await reg.getWorkflow("wf"), null);
    assert.equal(await exists(join(dir, "wf", "workflow.json")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("save rejects a tool whose manifest kind does not match the save method", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const wf = sampleWorkflow("wf");
    const code = sample("alpha");
    await assert.rejects(
      reg.saveCode(wf as unknown as CodeTool, makeConsistentApproval(wf)),
      /kind/i,
    );
    await assert.rejects(
      reg.saveWorkflow(code as unknown as WorkflowTool, makeConsistentApproval(code)),
      /kind/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kind-changing save deletes the alternate body file", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const code = sample("shifty");
    await reg.saveCode(code, makeConsistentApproval(code));
    assert.equal(await exists(join(dir, "shifty", "tool.ts")), true);

    const wf = sampleWorkflow("shifty");
    await reg.saveWorkflow(wf, makeConsistentApproval(wf));
    assert.equal(await exists(join(dir, "shifty", "workflow.json")), true);
    assert.equal(await exists(join(dir, "shifty", "tool.ts")), false);
    assert.equal(await reg.getCode("shifty"), null);
    assert.ok(await reg.getWorkflow("shifty"));

    const back = makeConsistentCodeTool({ ...manifestFields("shifty"), kind: "atomic" }, BODY);
    await reg.saveCode(back, makeConsistentApproval(back));
    assert.equal(await exists(join(dir, "shifty", "tool.ts")), true);
    assert.equal(await exists(join(dir, "shifty", "workflow.json")), false);
    assert.equal(await reg.getWorkflow("shifty"), null);

    const reopened = await FsToolRegistry.open(dir);
    assert.equal(reopened.integrityReport().length, 0);
    assert.equal((await reopened.getCode("shifty"))?.code, BODY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getters return defensive clones", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const code = sample("alpha");
    const wf = sampleWorkflow("wf");
    await reg.saveCode(code, makeConsistentApproval(code));
    await reg.saveWorkflow(wf, makeConsistentApproval(wf));

    const gotCode = await reg.getCode("alpha");
    assert.ok(gotCode);
    gotCode.code = "mutated";
    gotCode.manifest.description = "mutated";
    assert.equal((await reg.getCode("alpha"))?.code, BODY);
    assert.equal((await reg.getManifest("alpha"))?.description, "desc of alpha");

    const gotWf = await reg.getWorkflow("wf");
    assert.ok(gotWf);
    gotWf.workflow.steps.length = 0;
    gotWf.workflow.name = "mutated";
    const again = await reg.getWorkflow("wf");
    assert.deepEqual(again?.workflow, wf.workflow);

    const manifest = await reg.getManifest("wf");
    assert.ok(manifest);
    manifest.dependencies.push("injected");
    assert.deepEqual((await reg.getManifest("wf"))?.dependencies, []);

    const approval = await reg.getApproval("alpha");
    assert.ok(approval);
    approval.approvedBy = "attacker";
    assert.equal((await reg.getApproval("alpha"))?.approvedBy, "test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("save stores a clone so later caller mutation cannot poison the cache", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const code = sample("alpha");
    await reg.saveCode(code, makeConsistentApproval(code));
    code.code = "mutated";
    code.manifest.name = "mutated";
    assert.equal((await reg.getCode("alpha"))?.code, BODY);

    const wf = sampleWorkflow("wf");
    await reg.saveWorkflow(wf, makeConsistentApproval(wf));
    const originalIr = structuredClone(wf.workflow);
    wf.workflow.steps[0]!.tool = "hacked";
    assert.deepEqual((await reg.getWorkflow("wf"))?.workflow, originalIr);
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
    await reg.saveCode(t, makeConsistentApproval(t));
    await writeFile(join(dir, "alpha", "tool.ts"), "export async function run(i){return 0;}", "utf8");
    reg = await FsToolRegistry.open(dir);
    assert.match(captured, /warn:/);
    assert.match(captured, /alpha/);
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test("workflow save writes the exact bytes that were hashed", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const t = sampleWorkflow("wf");
    await reg.saveWorkflow(t, makeConsistentApproval(t));
    const onDisk = await readFile(join(dir, "wf", "workflow.json"), "utf8");
    const { hash: _hash, ...sansHash } = t.manifest;
    assert.equal(hashToolBody(onDisk, sansHash), t.manifest.hash);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy registry fixture opens without quarantine or invalid entries", async () => {
  const before = await readFile(join(LEGACY_FIXTURE_DIR, "mini-wf", "workflow.json"), "utf8");
  const reg = await FsToolRegistry.open(LEGACY_FIXTURE_DIR);

  const names = (await reg.list()).map((t) => t.name).sort();
  assert.deepEqual(names, ["echo-code", "mini-wf"]);

  const issues = reg
    .integrityReport()
    .filter((i) => i.name === "echo-code" || i.name === "mini-wf");
  assert.deepEqual(issues, []);

  const code = await reg.getCode("echo-code");
  assert.ok(code);
  assert.match(code.code, /echo/);
  assert.equal(await reg.getKind("echo-code"), "atomic");

  const wf = await reg.getWorkflow("mini-wf");
  assert.ok(wf);
  assert.equal(wf.workflow.name, "mini-wf");
  assert.equal(wf.workflow.steps[0]?.tool, "echo-code");
  assert.ok(await reg.getApproval("mini-wf"));

  // Frozen corpus: opening the registry must not rewrite fixture bytes.
  assert.equal(await readFile(join(LEGACY_FIXTURE_DIR, "mini-wf", "workflow.json"), "utf8"), before);
});
