import { test } from "node:test";
import assert from "node:assert/strict";
import { hashToolBody } from "../hash.ts";
import { TOOL_KIND, type ApprovalRecord, type CodeKind, type ToolManifest } from "../types.ts";
import {
  INTEGRITY_BODY_KIND,
  INTEGRITY_REASON,
  INTEGRITY_STATUS,
  RegistryIntegrityError,
  verifyToolIntegrity,
} from "./integrity.ts";

const CODE = "export async function run(i){return i;}";
const WORKFLOW = JSON.stringify({ version: 1, steps: [] }, null, 2);

function manifestFor<K extends ToolManifest["kind"]>(
  kind: K,
  body: string,
): ToolManifest & { kind: K } {
  const sansHash: Omit<ToolManifest, "hash"> & { kind: K } = {
    name: "t",
    description: "d",
    rationale: "r",
    inputSchema: { type: "object" },
    outputShape: { type: "object" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    createdAt: "2026-01-01T00:00:00.000Z",
    kind,
  };
  return { ...sansHash, hash: hashToolBody(body, sansHash) };
}

function approvalFor(manifest: ToolManifest): ApprovalRecord {
  return { hash: manifest.hash, approvedAt: "x", approvedBy: "u", alwaysApprove: false };
}

test("verifyToolIntegrity: consistent tool+approval => ok", () => {
  const m = manifestFor(TOOL_KIND.ATOMIC, CODE);
  assert.equal(
    verifyToolIntegrity({ kind: INTEGRITY_BODY_KIND.CODE, code: CODE }, m, approvalFor(m)).status,
    INTEGRITY_STATUS.OK,
  );
});

test("verifyToolIntegrity: edited body (manifest hash mismatch) => quarantined", () => {
  const m = manifestFor(TOOL_KIND.ATOMIC, CODE);
  const r = verifyToolIntegrity({ kind: INTEGRITY_BODY_KIND.CODE, code: CODE + " // tampered" }, m, approvalFor(m));
  assert.equal(r.status, INTEGRITY_STATUS.QUARANTINED);
});

test("verifyToolIntegrity: missing approval => needs_review", () => {
  const m = manifestFor(TOOL_KIND.ATOMIC, CODE);
  assert.equal(
    verifyToolIntegrity({ kind: INTEGRITY_BODY_KIND.CODE, code: CODE }, m, null).status,
    INTEGRITY_STATUS.NEEDS_REVIEW,
  );
});

test("verifyToolIntegrity: approval hash != manifest hash => needs_review", () => {
  const m = manifestFor(TOOL_KIND.ATOMIC, CODE);
  const stale: ApprovalRecord = { hash: "sha256:" + "b".repeat(64), approvedAt: "x", approvedBy: "u", alwaysApprove: true };
  assert.equal(
    verifyToolIntegrity({ kind: INTEGRITY_BODY_KIND.CODE, code: CODE }, m, stale).status,
    INTEGRITY_STATUS.NEEDS_REVIEW,
  );
});

test("verifyToolIntegrity: works for workflow JSON bodies", () => {
  const m = manifestFor(TOOL_KIND.WORKFLOW, WORKFLOW);
  assert.equal(
    verifyToolIntegrity({ kind: INTEGRITY_BODY_KIND.WORKFLOW, raw: WORKFLOW }, m, approvalFor(m)).status,
    INTEGRITY_STATUS.OK,
  );
});

test("verifyToolIntegrity: code body with workflow manifest => quarantined kind mismatch", () => {
  const m = manifestFor(TOOL_KIND.WORKFLOW, CODE);
  const mismatchedManifest = m as unknown as ToolManifest & { kind: CodeKind };
  const result = verifyToolIntegrity({ kind: INTEGRITY_BODY_KIND.CODE, code: CODE }, mismatchedManifest, approvalFor(m));
  assert.equal(result.status, INTEGRITY_STATUS.QUARANTINED);
  assert.equal(result.reason, INTEGRITY_REASON.BODY_MANIFEST_KIND_MISMATCH);
});

test("INTEGRITY_STATUS.INVALID is distinct from quarantined", () => {
  assert.equal(INTEGRITY_STATUS.INVALID, "invalid");
  assert.notEqual(INTEGRITY_STATUS.INVALID, INTEGRITY_STATUS.QUARANTINED);
});

test("RegistryIntegrityError carries status and tool name", () => {
  const err = new RegistryIntegrityError("foo", { status: INTEGRITY_STATUS.QUARANTINED, reason: "bad" });
  assert.equal(err.status, INTEGRITY_STATUS.QUARANTINED);
  assert.equal(err.toolName, "foo");
  assert.match(err.message, /foo/);
});
