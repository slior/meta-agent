import { hashTool } from "../hash.ts";
import type { ApprovalRecord, ToolManifest } from "../types.ts";

/** Per-entry integrity outcome at the registry persistence boundary. */
export const INTEGRITY_STATUS = {
  /** Body matches manifest.hash AND a matching approval is bound. */
  ok: "ok",
  /** Body matches manifest.hash, but no approval binds to it (missing or stale). */
  needsReview: "needs_review",
  /** Body does NOT match manifest.hash: tampered/corrupt; manifest is untrustworthy. */
  quarantined: "quarantined",
} as const;

export type IntegrityStatus = (typeof INTEGRITY_STATUS)[keyof typeof INTEGRITY_STATUS];

/** Result of {@link verifyToolIntegrity}; carries a human-readable reason for non-ok states. */
export type IntegrityResult =
  | { status: typeof INTEGRITY_STATUS.ok }
  | { status: typeof INTEGRITY_STATUS.needsReview; reason: string }
  | { status: typeof INTEGRITY_STATUS.quarantined; reason: string };

/** A recorded integrity problem for a single registry entry, surfaced via integrityReport(). */
export type IntegrityIssue = {
  name: string;
  path: string;
  status: IntegrityStatus;
  reason: string;
};

/** Stable reason strings so callers/tests don't depend on prose wording in one place. */
export const INTEGRITY_REASON = {
  bodyHashMismatch:
    "manifest hash does not match tool body; code/workflow or manifest was edited on disk",
  approvalMissing: "no approval record is bound to this tool",
  approvalHashMismatch: "approval hash does not match the current manifest hash",
} as const;

/**
 * Verifies a tool's content and approval integrity at the persistence boundary.
 *
 * Link A (manifest <-> body): manifest.hash must equal hashTool(body, manifestSansHash).
 * Link B (approval <-> manifest): approval must exist and approval.hash must equal manifest.hash.
 *
 * @param body     Raw tool body bytes: tool.ts for atomic/composite, workflow.json for workflows.
 * @param manifest Parsed manifest; its `hash` field is the claimed Link-A hash.
 * @param approval Parsed approval record, or null when absent.
 */
export function verifyToolIntegrity(
  body: string,
  manifest: ToolManifest,
  approval: ApprovalRecord | null,
): IntegrityResult {
  const { hash: _claimed, ...manifestSansHash } = manifest;
  const recomputed = hashTool(body, manifestSansHash);
  if (recomputed !== manifest.hash) {
    return { status: INTEGRITY_STATUS.quarantined, reason: INTEGRITY_REASON.bodyHashMismatch };
  }
  if (approval === null) {
    return { status: INTEGRITY_STATUS.needsReview, reason: INTEGRITY_REASON.approvalMissing };
  }
  if (approval.hash !== manifest.hash) {
    return { status: INTEGRITY_STATUS.needsReview, reason: INTEGRITY_REASON.approvalHashMismatch };
  }
  return { status: INTEGRITY_STATUS.ok };
}

/** Thrown by the registry when asked to persist a self-inconsistent tool entry. */
export class RegistryIntegrityError extends Error {
  readonly status: IntegrityStatus;
  readonly toolName: string;
  constructor(toolName: string, result: { status: IntegrityStatus; reason: string }) {
    super(`registry integrity check failed for '${toolName}': ${result.status}: ${result.reason}`);
    this.name = "RegistryIntegrityError";
    this.status = result.status;
    this.toolName = toolName;
  }
}
