import { test } from "node:test";
import assert from "node:assert/strict";
import { INTEGRITY_BODY_KIND, INTEGRITY_STATUS, verifyToolIntegrity } from "../registry/integrity.ts";
import { serializeWorkflowBody } from "../hash.ts";
import { TOOL_KIND } from "../types.ts";
import type { Workflow } from "../workflow/types.ts";
import {
  makeConsistentApproval,
  makeConsistentCodeTool,
  makeConsistentWorkflowTool,
} from "./tool-fixtures.ts";

const CODE_MANIFEST_SANS_HASH = {
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

const WORKFLOW_MANIFEST_SANS_HASH = {
  ...CODE_MANIFEST_SANS_HASH,
  name: "alpha-workflow",
  kind: TOOL_KIND.WORKFLOW,
};

const WORKFLOW: Workflow = {
  schemaVersion: 1,
  name: "alpha-workflow",
  description: "d",
  goal: "r",
  inputs: [],
  steps: [],
  return: null,
};

test("makeConsistentCodeTool and approval produce an ok code tool", () => {
  const tool = makeConsistentCodeTool(CODE_MANIFEST_SANS_HASH, "export async function run(i){return i;}");
  const approval = makeConsistentApproval(tool);
  assert.equal(
    verifyToolIntegrity({ kind: INTEGRITY_BODY_KIND.CODE, code: tool.code }, tool.manifest, approval).status,
    INTEGRITY_STATUS.OK,
  );
  assert.equal(approval.hash, tool.manifest.hash);
});

test("makeConsistentWorkflowTool and approval produce an ok workflow tool", () => {
  const tool = makeConsistentWorkflowTool(WORKFLOW_MANIFEST_SANS_HASH, WORKFLOW);
  const approval = makeConsistentApproval(tool);
  assert.equal(
    verifyToolIntegrity(
      { kind: INTEGRITY_BODY_KIND.WORKFLOW, raw: serializeWorkflowBody(tool.workflow) },
      tool.manifest,
      approval,
    ).status,
    INTEGRITY_STATUS.OK,
  );
  assert.equal(approval.hash, tool.manifest.hash);
});
