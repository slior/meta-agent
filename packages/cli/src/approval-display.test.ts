import { test } from "node:test";
import assert from "node:assert/strict";
import type { Permissions } from "@meta-agent/core";
import { PERMISSIONS_NET } from "@meta-agent/core";
import { formatArgsTable, formatPermissionsTable, formatWorkflowInputSchema } from "./approval-display.ts";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("formatArgsTable: scalar fields", () => {
  const out = stripAnsi(formatArgsTable({ path: "./tmp/x.md", append: true }));
  assert.match(out, /Arguments/);
  assert.match(out, /path/);
  assert.match(out, /\.\/tmp\/x\.md/);
  assert.match(out, /append/);
  assert.match(out, /true/);
});

test("formatArgsTable: long string truncated", () => {
  const out = stripAnsi(formatArgsTable({ content: "x".repeat(200) }));
  assert.match(out, /content/);
  assert.match(out, /\.\.\./);
});

test("formatArgsTable: multiline string preview under row", () => {
  const out = stripAnsi(formatArgsTable({ content: "line1\nline2\nline3\nline4" }));
  const lines = out.split("\n");
  const multilineIdx = lines.findIndex((l) => l.includes("(multiline,"));
  assert.ok(multilineIdx >= 0);
  const previewIdx = lines.findIndex((l, i) => i > multilineIdx && l.includes("line1"));
  assert.ok(previewIdx > multilineIdx);
  assert.ok(previewIdx - multilineIdx <= 2);
});

test("formatArgsTable: nested object preview under row", () => {
  const out = stripAnsi(formatArgsTable({ opts: { a: 1, b: 2, c: 3, nested: { x: 1 } } }));
  assert.match(out, /\(object,/);
  const lines = out.split("\n");
  const objectIdx = lines.findIndex((l) => l.includes("(object,"));
  const jsonIdx = lines.findIndex((l, i) => i > objectIdx && l.includes('"a"'));
  assert.ok(jsonIdx > objectIdx);
});

test("formatArgsTable: non-object args", () => {
  const out = stripAnsi(formatArgsTable("hello"));
  assert.match(out, /value/);
  assert.match(out, /hello/);
});

test("formatArgsTable: empty object", () => {
  const out = stripAnsi(formatArgsTable({}));
  assert.match(out, /\(no arguments\)/);
});

test("formatPermissionsTable: blocked network", () => {
  const perms: Permissions = {
    fsRead: [],
    fsWrite: ["*"],
    net: PERMISSIONS_NET.NONE,
    netAllowlist: [],
    env: [],
  };
  const out = stripAnsi(formatPermissionsTable(perms));
  assert.match(out, /Permissions/);
  assert.match(out, /Write files/);
  assert.match(out, /all paths/);
  assert.match(out, /Network/);
  assert.match(out, /blocked/);
});

test("formatPermissionsTable: allowlist hosts", () => {
  const perms: Permissions = {
    fsRead: ["/workspace/**"],
    fsWrite: [],
    net: PERMISSIONS_NET.ALLOWLIST,
    netAllowlist: ["api.example.com"],
    env: ["PATH"],
  };
  const out = stripAnsi(formatPermissionsTable(perms));
  assert.match(out, /Read files/);
  assert.match(out, /\/workspace/);
  assert.match(out, /allowlist/);
  assert.match(out, /api\.example\.com/);
  assert.match(out, /PATH/);
});

test("formatPermissionsTable: empty allowlist", () => {
  const perms: Permissions = {
    fsRead: [],
    fsWrite: [],
    net: PERMISSIONS_NET.ALLOWLIST,
    netAllowlist: [],
    env: [],
  };
  const out = stripAnsi(formatPermissionsTable(perms));
  assert.match(out, /allowlist \(no hosts\)/);
});

test("formatWorkflowInputSchema: renders parameter name, type, and required status", () => {
  const schema = {
    type: "object",
    properties: {
      url: { type: "string", description: "the target URL" },
      path: { type: "string" },
    },
    required: ["url"],
  };
  const plain = stripAnsi(formatWorkflowInputSchema(schema));
  assert.match(plain, /url/);
  assert.match(plain, /string/);
  assert.match(plain, /required/);
  assert.match(plain, /path/);
  assert.match(plain, /optional/);
  assert.match(plain, /the target URL/);
});

test("formatWorkflowInputSchema: empty properties renders no-parameters message", () => {
  const plain = stripAnsi(formatWorkflowInputSchema({ type: "object" }));
  assert.match(plain, /no parameters/);
});
