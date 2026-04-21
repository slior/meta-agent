import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { MANIFEST_SCHEMA, TOOL_DRAFT_SCHEMA } from "./schemas.ts";

const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validateManifest = ajv.compile(MANIFEST_SCHEMA);
const validateDraft = ajv.compile(TOOL_DRAFT_SCHEMA);

const validManifest = {
  name: "csv-parse",
  description: "Parses a CSV string into rows.",
  rationale: "Task needed quoted-field CSV.",
  inputSchema: { type: "object" },
  outputShape: { type: "array" },
  permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  dependencies: [],
  limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
  hash: "sha256:" + "a".repeat(64),
  createdAt: "2026-04-21T00:00:00Z",
  kind: "atomic",
};

test("MANIFEST_SCHEMA accepts a valid manifest", () => {
  assert.equal(validateManifest(validManifest), true, JSON.stringify(validateManifest.errors));
});

test("MANIFEST_SCHEMA rejects uppercase name", () => {
  assert.equal(validateManifest({ ...validManifest, name: "CsvParse" }), false);
});

test("MANIFEST_SCHEMA rejects missing permissions", () => {
  const { permissions, ...m } = validManifest;
  assert.equal(validateManifest(m), false);
});

test("TOOL_DRAFT_SCHEMA accepts a valid draft", () => {
  const draft = {
    name: "csv-parse",
    description: "Parses a CSV string.",
    rationale: "Because.",
    inputSchema: { type: "object" },
    outputShape: { type: "array" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    code: "export async function run(i){return [];}",
    dependencies: [],
    smokeTestInput: { s: "a,b\n1,2" },
    kind: "atomic",
  };
  assert.equal(validateDraft(draft), true, JSON.stringify(validateDraft.errors));
});
