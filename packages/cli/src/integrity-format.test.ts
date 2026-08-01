import { test } from "node:test";
import assert from "node:assert/strict";
import { INTEGRITY_STATUS } from "@meta-agent/core";
import { formatIntegrityIssues } from "./integrity-format.ts";

test("formatIntegrityIssues returns null when there are no issues", () => {
  assert.equal(formatIntegrityIssues([]), null);
});

test("formatIntegrityIssues lists each issue with a readable label", () => {
  const out = formatIntegrityIssues([
    { name: "csv-parse", path: "/t/csv-parse/tool.ts", status: INTEGRITY_STATUS.QUARANTINED, reason: "edited" },
    { name: "web-fetch", path: "/t/web-fetch/workflow.json", status: INTEGRITY_STATUS.NEEDS_REVIEW, reason: "stale approval" },
    { name: "broken-flow", path: "/t/broken-flow/workflow.json", status: INTEGRITY_STATUS.INVALID, reason: "invalid workflow" },
  ]);
  assert.ok(out);
  assert.match(out, /3 tool\(s\)/);
  assert.match(out, /csv-parse: quarantined/);
  assert.match(out, /web-fetch: needs review/);
  assert.match(out, /broken-flow: invalid/);
});
