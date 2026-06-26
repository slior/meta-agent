import { INTEGRITY_STATUS, type IntegrityIssue, type IntegrityStatus } from "@meta-agent/core";

const STATUS_LABEL: Record<IntegrityStatus, string> = {
  [INTEGRITY_STATUS.ok]: "ok",
  [INTEGRITY_STATUS.needsReview]: "needs review",
  [INTEGRITY_STATUS.quarantined]: "quarantined",
};

export function formatIntegrityIssues(issues: IntegrityIssue[]): string | null {
  if (issues.length === 0) return null;
  const lines = issues.map((i) => `  - ${i.name}: ${STATUS_LABEL[i.status]} (${i.reason})`);
  return `⚠ ${issues.length} tool(s) failed integrity checks:\n${lines.join("\n")}`;
}
