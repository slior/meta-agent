import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTool } from "../hash.ts";
import type { ApprovalRecord, ToolManifest } from "../types.ts";
import { INTEGRITY_STATUS, RegistryIntegrityError, verifyToolIntegrity } from "./integrity.ts";

const BODY = "export async function run(i){return i;}";

function manifestFor(body: string): ToolManifest {
  const sansHash: Omit<ToolManifest, "hash"> = {
    name: "t",
    description: "d",
    rationale: "r",
    inputSchema: { type: "object" },
    outputShape: { type: "object" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "atomic",
  };
  return { ...sansHash, hash: hashTool(body, sansHash) };
}

function approvalFor(manifest: ToolManifest): ApprovalRecord {
  return { hash: manifest.hash, approvedAt: "x", approvedBy: "u", alwaysApprove: false };
}

test("verifyToolIntegrity: consistent tool+approval => ok", () => {
  const m = manifestFor(BODY);
  assert.equal(verifyToolIntegrity(BODY, m, approvalFor(m)).status, INTEGRITY_STATUS.ok);
});

test("verifyToolIntegrity: edited body (manifest hash mismatch) => quarantined", () => {
  const m = manifestFor(BODY);
  const r = verifyToolIntegrity(BODY + " // tampered", m, approvalFor(m));
  assert.equal(r.status, INTEGRITY_STATUS.quarantined);
});

test("verifyToolIntegrity: missing approval => needs_review", () => {
  const m = manifestFor(BODY);
  assert.equal(verifyToolIntegrity(BODY, m, null).status, INTEGRITY_STATUS.needsReview);
});

test("verifyToolIntegrity: approval hash != manifest hash => needs_review", () => {
  const m = manifestFor(BODY);
  const stale: ApprovalRecord = { hash: "sha256:" + "b".repeat(64), approvedAt: "x", approvedBy: "u", alwaysApprove: true };
  assert.equal(verifyToolIntegrity(BODY, m, stale).status, INTEGRITY_STATUS.needsReview);
});

test("verifyToolIntegrity: works for workflow JSON bodies", () => {
  const workflowBody = JSON.stringify({ version: 1, steps: [] }, null, 2);
  const m = manifestFor(workflowBody);
  assert.equal(verifyToolIntegrity(workflowBody, m, approvalFor(m)).status, INTEGRITY_STATUS.ok);
});

test("RegistryIntegrityError carries status and tool name", () => {
  const err = new RegistryIntegrityError("foo", { status: INTEGRITY_STATUS.quarantined, reason: "bad" });
  assert.equal(err.status, INTEGRITY_STATUS.quarantined);
  assert.equal(err.toolName, "foo");
  assert.match(err.message, /foo/);
});
