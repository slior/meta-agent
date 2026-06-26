import { hashTool } from "../hash.ts";
import type { ApprovalRecord, Tool, ToolManifest } from "../types.ts";

export function makeConsistentTool(manifestSansHash: Omit<ToolManifest, "hash">, body: string): Tool {
  const hash = hashTool(body, manifestSansHash);
  return { manifest: { ...manifestSansHash, hash }, code: body };
}

export function makeConsistentApproval(tool: Tool, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    hash: tool.manifest.hash,
    approvedAt: "2026-01-01T00:00:00.000Z",
    approvedBy: "test",
    alwaysApprove: false,
    ...overrides,
  };
}
