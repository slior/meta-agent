import { test } from "node:test";
import assert from "node:assert/strict";
import { INTEGRITY_STATUS } from "@meta-agent/core";
import { formatIntegrityIssues } from "./integrity-format.ts";

test("formatIntegrityIssues returns null when there are no issues", () => {
  assert.equal(formatIntegrityIssues([]), null);
});

test("formatIntegrityIssues lists each issue with a readable label", () => {
  const out = formatIntegrityIssues([
    { name: "csv-parse", path: "/t/csv-parse/tool.ts", status: INTEGRITY_STATUS.quarantined, reason: "edited" },
    { name: "web-fetch", path: "/t/web-fetch/workflow.json", status: INTEGRITY_STATUS.needsReview, reason: "stale approval" },
  ]);
  assert.ok(out);
  assert.match(out, /2 tool\(s\)/);
  assert.match(out, /csv-parse: quarantined/);
  assert.match(out, /web-fetch: needs review/);
});
