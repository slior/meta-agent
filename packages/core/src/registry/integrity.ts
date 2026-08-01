import { hashToolBody } from "../hash.ts";
import { TOOL_KIND, type ApprovalRecord, type CodeKind, type ToolManifest } from "../types.ts";

/**
 * Discriminator values for the kind-tagged body passed to {@link verifyToolIntegrity}.
 * Distinct from {@link TOOL_KIND}: body shape is `code` (source) vs `workflow` (IR bytes).
 */
export const INTEGRITY_BODY_KIND = {
  CODE: "code",
  WORKFLOW: "workflow",
} as const;

/** Kind tag on a raw integrity-check body. */
export type IntegrityBodyKind = (typeof INTEGRITY_BODY_KIND)[keyof typeof INTEGRITY_BODY_KIND];

type CodeIntegrityBody = { kind: typeof INTEGRITY_BODY_KIND.CODE; code: string };
type WorkflowIntegrityBody = { kind: typeof INTEGRITY_BODY_KIND.WORKFLOW; raw: string };

/** Per-entry integrity outcome at the registry persistence boundary. */
export const INTEGRITY_STATUS = {
  /** Body matches manifest.hash AND a matching approval is bound. */
  OK: "ok",
  /** Body matches manifest.hash, but no approval binds to it (missing or stale). */
  NEEDS_REVIEW: "needs_review",
  /** Body does NOT match manifest.hash: tampered/corrupt; manifest is untrustworthy. */
  QUARANTINED: "quarantined",
  /** Body hash passed, but its structure is unusable. */
  INVALID: "invalid",
} as const;

/** Per-entry integrity status string produced by {@link verifyToolIntegrity}. */
export type IntegrityStatus = (typeof INTEGRITY_STATUS)[keyof typeof INTEGRITY_STATUS];

/** Result of {@link verifyToolIntegrity}; carries a human-readable reason for non-ok states. */
export type IntegrityResult =
  | { status: typeof INTEGRITY_STATUS.OK }
  | { status: typeof INTEGRITY_STATUS.NEEDS_REVIEW; reason: string }
  | { status: typeof INTEGRITY_STATUS.QUARANTINED; reason: string }
  | { status: typeof INTEGRITY_STATUS.INVALID; reason: string };

/** A recorded integrity problem for a single registry entry, surfaced via integrityReport(). */
export type IntegrityIssue = {
  name: string;
  path: string;
  status: IntegrityStatus;
  reason: string;
};

/** Stable reason strings so callers/tests don't depend on prose wording in one place. */
export const INTEGRITY_REASON = {
  BODY_HASH_MISMATCH:
    "manifest hash does not match tool body; code/workflow or manifest was edited on disk",
  BODY_MANIFEST_KIND_MISMATCH: "tool body kind does not match manifest kind",
  APPROVAL_MISSING: "no approval record is bound to this tool",
  APPROVAL_HASH_MISMATCH: "approval hash does not match the current manifest hash",
  WORKFLOW_PARSE_FAILED: "workflow body failed structural validation",
} as const;

/**
 * Verifies a tool's content and approval integrity at the persistence boundary.
 *
 * Link A (manifest ↔ body): `manifest.hash` must equal `hashToolBody(body, manifestSansHash)`.
 * Link B (approval ↔ manifest): approval must exist and `approval.hash` must equal `manifest.hash`.
 *
 * @param body - Kind-tagged raw tool body bytes.
 * @param manifest - Parsed manifest; its `hash` field is the claimed Link-A hash.
 * @param approval - Parsed approval record, or null when absent.
 * @returns Integrity status; non-ok results include a stable {@link INTEGRITY_REASON} string.
 */
export function verifyToolIntegrity(
  body: CodeIntegrityBody,
  manifest: ToolManifest & { kind: CodeKind },
  approval: ApprovalRecord | null,
): IntegrityResult;
export function verifyToolIntegrity(
  body: WorkflowIntegrityBody,
  manifest: ToolManifest & { kind: typeof TOOL_KIND.WORKFLOW },
  approval: ApprovalRecord | null,
): IntegrityResult;
export function verifyToolIntegrity(
  body: CodeIntegrityBody | WorkflowIntegrityBody,
  manifest: ToolManifest,
  approval: ApprovalRecord | null,
): IntegrityResult {
  const isCodeBody = body.kind === INTEGRITY_BODY_KIND.CODE;
  const isCodeManifest = manifest.kind !== TOOL_KIND.WORKFLOW;
  if (isCodeBody !== isCodeManifest) {
    return {
      status: INTEGRITY_STATUS.QUARANTINED,
      reason: INTEGRITY_REASON.BODY_MANIFEST_KIND_MISMATCH,
    };
  }

  const { hash: _claimed, ...manifestSansHash } = manifest;
  const recomputed = hashToolBody(isCodeBody ? body.code : body.raw, manifestSansHash);
  if (recomputed !== manifest.hash) {
    return { status: INTEGRITY_STATUS.QUARANTINED, reason: INTEGRITY_REASON.BODY_HASH_MISMATCH };
  }
  if (approval === null) {
    return { status: INTEGRITY_STATUS.NEEDS_REVIEW, reason: INTEGRITY_REASON.APPROVAL_MISSING };
  }
  if (approval.hash !== manifest.hash) {
    return { status: INTEGRITY_STATUS.NEEDS_REVIEW, reason: INTEGRITY_REASON.APPROVAL_HASH_MISMATCH };
  }
  return { status: INTEGRITY_STATUS.OK };
}

/**
 * Thrown by the registry when asked to persist a self-inconsistent tool entry.
 */
export class RegistryIntegrityError extends Error {
  /** Integrity status that caused the failure. */
  readonly status: IntegrityStatus;
  /** Tool name that failed the check. */
  readonly toolName: string;

  /**
   * @param toolName - Name of the tool that failed integrity.
   * @param result - Non-ok integrity status and reason.
   */
  constructor(toolName: string, result: { status: IntegrityStatus; reason: string }) {
    super(`registry integrity check failed for '${toolName}': ${result.status}: ${result.reason}`);
    this.name = "RegistryIntegrityError";
    this.status = result.status;
    this.toolName = toolName;
  }
}
