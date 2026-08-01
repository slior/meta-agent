import { hashCodeTool, hashWorkflowTool } from "../hash.ts";
import { TOOL_KIND, type ApprovalRecord, type CodeKind, type ToolManifest } from "../types.ts";
import type { CodeTool, Tool, WorkflowTool } from "../tool.ts";
import type { Workflow } from "../workflow/types.ts";

/**
 * Builds a {@link CodeTool} whose `manifest.hash` matches {@link hashCodeTool}.
 * Intended for tests and fixtures only — not part of the public package API.
 *
 * @param manifestSansHash - Manifest fields excluding `hash`; kind must be atomic or composite.
 * @param code - TypeScript source body.
 * @returns Code tool with a consistent Link-A hash.
 */
export function makeConsistentCodeTool(
  manifestSansHash: Omit<ToolManifest, "hash"> & { kind: CodeKind },
  code: string,
): CodeTool {
  const hash = hashCodeTool(code, manifestSansHash);
  return { manifest: { ...manifestSansHash, hash }, code };
}

/**
 * Builds a {@link WorkflowTool} whose `manifest.hash` matches {@link hashWorkflowTool}.
 * Intended for tests and fixtures only — not part of the public package API.
 *
 * @param manifestSansHash - Manifest fields excluding `hash`; kind must be workflow.
 * @param workflow - Workflow IR body.
 * @returns Workflow tool with a consistent Link-A hash.
 */
export function makeConsistentWorkflowTool(
  manifestSansHash: Omit<ToolManifest, "hash"> & { kind: typeof TOOL_KIND.WORKFLOW },
  workflow: Workflow,
): WorkflowTool {
  const hash = hashWorkflowTool(workflow, manifestSansHash);
  return { manifest: { ...manifestSansHash, hash }, workflow };
}

/**
 * Builds an {@link ApprovalRecord} bound to `tool.manifest.hash`.
 * Intended for tests and fixtures only — not part of the public package API.
 *
 * @param tool - Tool whose hash should be approved.
 * @param overrides - Optional fields to override defaults.
 * @returns Approval record suitable for registry save / integrity checks.
 */
export function makeConsistentApproval(tool: Tool, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    hash: tool.manifest.hash,
    approvedAt: "2026-01-01T00:00:00.000Z",
    approvedBy: "test",
    alwaysApprove: false,
    ...overrides,
  };
}
