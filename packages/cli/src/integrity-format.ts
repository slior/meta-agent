import { INTEGRITY_STATUS, type IntegrityIssue, type IntegrityStatus } from "@meta-agent/core";

const STATUS_LABEL: Record<IntegrityStatus, string> = {
  [INTEGRITY_STATUS.OK]: "ok",
  [INTEGRITY_STATUS.NEEDS_REVIEW]: "needs review",
  [INTEGRITY_STATUS.QUARANTINED]: "quarantined",
  [INTEGRITY_STATUS.INVALID]: "invalid",
};

/**
 * Formats registry integrity issues for REPL display, or null when there are none.
 *
 * @param issues - Issues from {@link ToolRegistry.integrityReport}.
 * @returns Multi-line warning string, or null when `issues` is empty.
 */
export function formatIntegrityIssues(issues: IntegrityIssue[]): string | null {
  if (issues.length === 0) return null;
  const lines = issues.map((i) => `  - ${i.name}: ${STATUS_LABEL[i.status]} (${i.reason})`);
  return `⚠ ${issues.length} tool(s) failed integrity checks:\n${lines.join("\n")}`;
}
