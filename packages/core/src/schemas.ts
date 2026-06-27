import { PERMISSIONS_NET, TOOL_KIND } from "./types.ts";

export const PERMISSIONS_SCHEMA = {
  type: "object",
  properties: {
    fsRead: { type: "array", items: { type: "string" } },
    fsWrite: { type: "array", items: { type: "string" } },
    net: { type: "string", enum: [PERMISSIONS_NET.NONE, PERMISSIONS_NET.ALLOWLIST] },
    netAllowlist: { type: "array", items: { type: "string" } },
    env: { type: "array", items: { type: "string" } },
  },
  required: ["fsRead", "fsWrite", "net", "netAllowlist", "env"],
  additionalProperties: false,
} as const;

export const MANIFEST_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", pattern: "^[a-z][a-z0-9-]{1,63}$" },
    description: { type: "string", minLength: 1, maxLength: 2000 },
    rationale: { type: "string", minLength: 1, maxLength: 4000 },
    inputSchema: { type: "object" },
    outputShape: { type: "object" },
    permissions: PERMISSIONS_SCHEMA,
    dependencies: { type: "array", items: { type: "string" } },
    limits: {
      type: "object",
      properties: {
        timeoutMs: { type: "integer", minimum: 100, maximum: 600000 },
        maxOldSpaceSizeMb: { type: "integer", minimum: 32, maximum: 4096 },
      },
      required: ["timeoutMs", "maxOldSpaceSizeMb"],
      additionalProperties: false,
    },
    hash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    createdAt: { type: "string", format: "date-time" },
    kind: { type: "string", enum: [TOOL_KIND.ATOMIC, TOOL_KIND.COMPOSITE] },
  },
  required: [
    "name", "description", "rationale", "inputSchema", "outputShape",
    "permissions", "dependencies", "limits", "hash", "createdAt", "kind",
  ],
  additionalProperties: false,
} as const;

export const TOOL_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", pattern: "^[a-z][a-z0-9-]{1,63}$" },
    description: { type: "string", minLength: 1, maxLength: 2000 },
    rationale: { type: "string", minLength: 1, maxLength: 4000 },
    inputSchema: { type: "object" },
    outputShape: { type: "object" },
    permissions: PERMISSIONS_SCHEMA,
    code: { type: "string", minLength: 1, maxLength: 50000 },
    dependencies: { type: "array", items: { type: "string" } },
    smokeTestInput: {},
    kind: { type: "string", enum: [TOOL_KIND.ATOMIC, TOOL_KIND.COMPOSITE] },
  },
  required: [
    "name", "description", "rationale", "inputSchema", "outputShape",
    "permissions", "code", "dependencies", "smokeTestInput", "kind",
  ],
  additionalProperties: false,
} as const;
