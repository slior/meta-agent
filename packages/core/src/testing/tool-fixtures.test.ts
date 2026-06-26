import { test } from "node:test";
import assert from "node:assert/strict";
import { INTEGRITY_STATUS, verifyToolIntegrity } from "../registry/integrity.ts";
import { makeConsistentApproval, makeConsistentTool } from "./tool-fixtures.ts";

const SANS_HASH = {
  name: "alpha",
  description: "d",
  rationale: "r",
  inputSchema: { type: "object" as const },
  outputShape: { type: "object" as const },
  permissions: { fsRead: [], fsWrite: [], net: "none" as const, netAllowlist: [], env: [] },
  dependencies: [] as string[],
  limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
  createdAt: "2026-01-01T00:00:00.000Z",
  kind: "atomic" as const,
};

test("makeConsistentTool + makeConsistentApproval produce an ok tool", () => {
  const tool = makeConsistentTool(SANS_HASH, "export async function run(i){return i;}");
  const approval = makeConsistentApproval(tool);
  assert.equal(verifyToolIntegrity(tool.code, tool.manifest, approval).status, INTEGRITY_STATUS.ok);
  assert.equal(approval.hash, tool.manifest.hash);
});
