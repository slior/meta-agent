# Meta-Agent v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the meta-agent described in `docs/meta-tool-design.md` — an OpenAI-SDK-driven agent that dynamically creates, reuses, composes, and executes TypeScript tools under a Node `--permission` sandbox, with a tiered HITL approval model and a filesystem-backed tool registry.

**Architecture:** Monorepo with two packages — `packages/core` (all mechanics, zero TTY deps) and `packages/cli` (demo REPL + approval TUI). Every major dimension (registry, index, sandbox, approval, LLM) sits behind an interface so future implementations can be swapped in.

**Tech Stack:**

- Node.js ≥ 22.7 (needs `--permission` and `--experimental-transform-types`; `--experimental-strip-types` is on by default from 22.6+ but does not handle TypeScript-only syntax like access modifiers, so transform-types is required)
- TypeScript (source) run directly via Node type-stripping — no transpile step for generated tools
- `openai` SDK for LLM calls (configurable `baseURL` → OpenAI/gateways/Ollama/vLLM)
- `ajv` for JSON Schema validation
- Node's built-in test runner (`node:test` + `node:assert`)
- No other runtime deps

---

## Execution Status


| Task | Title                                 | Status                 |
| ---- | ------------------------------------- | ---------------------- |
| 1    | Workspace Scaffold                    | ✅ complete (`d312ddd`) |
| 2    | Shared Types and JSON Schemas         | ✅ complete (`a236893`) |
| 3    | Canonical JSON and Hashing            | ✅ complete (`d9f5716`) |
| 4    | Tracer (JSONL Append-Only)            | ✅ complete (`65161c9`) |
| 5    | Filesystem Tool Registry              | ✅ complete (`4553741`) |
| 6    | Hybrid Tool Index                     | ✅ complete (`11f23dc`) |
| 7    | Tiered Approval Policy                | ✅ complete (`1f3ea3f`) |
| 8    | LLM Provider (OpenAI SDK + Mock)      | ✅ complete (`e5ba4d5`) |
| 9    | Sandbox Runner (Child-Side Bootstrap) | ✅ complete (`697e132`) |
| 10   | NodePermissionSandbox (Parent-Side)   | ✅ complete (`aa36aac`) |
| 11   | Static Validator                      | ✅ complete (`46dd62b`) |
| 12   | Tool Factory                          | ✅ complete (`6460f40`) |
| 13   | Meta-Tools and System Prompt          | ✅ complete (`c50ed1a`) |
| 14   | Agent Loop                            | ✅ complete (`b6d740b`) |
| 15   | CLI Config Loader and Approval TUI    | ✅ complete (`70af26b`) |
| 16   | CLI REPL, /compose, and Bin Entry     | ✅ complete (`83407f3`) |
| 17   | End-to-End Smoke Test with Mocked LLM | ✅ complete (`b7e121d`) |


Legend: ⬜ pending · ⏳ in progress · ✅ complete

---

## Pre-flight

Before starting, confirm the environment:

```bash
node --version    # must be >= 22.7.0 (22.22+ recommended for stable transform-types)
git --version
```

All work happens inside the `meta-agent` repo root. Every task ends with a commit; the commits should be small and reviewable.

---

## File Structure Overview

This is the final layout you're working toward. Tasks build it up incrementally.

```
meta-agent/
├── package.json                          # root, workspaces, scripts
├── tsconfig.base.json                    # shared TS config
├── .gitignore
├── .nvmrc                                # 22.22.2
├── docs/
│   ├── meta-tool-design.md               # (exists)
│   └── v1-implementation-plan.md         # (this file)
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                  # public barrel
│   │       ├── types.ts                  # shared types
│   │       ├── schemas.ts                # JSON schemas (manifest, draft, etc.)
│   │       ├── hash.ts                   # canonical-JSON + sha256
│   │       ├── tracer.ts                 # JSONL event logger
│   │       ├── errors.ts                 # ToolError factory
│   │       ├── registry/
│   │       │   ├── interface.ts
│   │       │   └── fs-registry.ts
│   │       ├── index-store/
│   │       │   ├── interface.ts
│   │       │   └── hybrid-index.ts
│   │       ├── approval/
│   │       │   ├── interface.ts
│   │       │   └── tiered-policy.ts
│   │       ├── llm/
│   │       │   ├── interface.ts
│   │       │   ├── openai-provider.ts
│   │       │   └── mock-provider.ts
│   │       ├── sandbox/
│   │       │   ├── interface.ts
│   │       │   ├── node-permission-sandbox.ts
│   │       │   └── runner.ts             # child-side bootstrap
│   │       ├── factory/
│   │       │   ├── static-validator.ts
│   │       │   ├── code-gen-prompts.ts
│   │       │   └── factory.ts
│   │       ├── agent/
│   │       │   ├── meta-tools.ts
│   │       │   ├── system-prompt.ts
│   │       │   └── agent-loop.ts
│   │       └── *.test.ts                 # colocated tests
│   └── cli/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── config.ts
│           ├── approval-tui.ts
│           ├── compose.ts
│           ├── repl.ts
│           └── bin.ts
├── tools/                                # created at runtime
└── traces/                               # created at runtime
```

---

## Task 1: Workspace Scaffold

**Files:**

- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.nvmrc`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/bin.ts`
- **Step 1: Create `.nvmrc`**

```
22.22.2
```

- **Step 2: Create `.gitignore`**

```
node_modules/
dist/
tools/*/
!tools/.gitkeep
traces/*.jsonl
.DS_Store
*.log
.env
.env.local
```

- **Step 3: Create root `package.json`**

```json
{
  "name": "meta-agent",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.7.0" },
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "npm test --workspaces --if-present",
    "typecheck": "tsc -b packages/core packages/cli",
    "cli": "node --experimental-transform-types --no-warnings packages/cli/src/bin.ts"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "typescript": "^5.6.0"
  }
}
```

- **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noImplicitAny": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "lib": ["ES2023"]
  }
}
```

- **Step 5: Create `packages/core/package.json`**

```json
{
  "name": "@meta-agent/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "node --test --experimental-transform-types --no-warnings 'src/**/*.test.ts'"
  },
  "dependencies": {
    "openai": "^4.67.0",
    "ajv": "^8.17.1"
  }
}
```

Note: the `'src/**/*.test.ts'` is single-quoted so the shell does not expand the glob; Node's `--test` flag expands `**` recursively and includes `.ts` files (which the default auto-discovery does not as of Node 22.6).

- **Step 6: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src" },
  "include": ["src/**/*.ts"]
}
```

- **Step 7: Create `packages/core/src/index.ts`**

```ts
export const version = "0.1.0";
```

- **Step 8: Create `packages/cli/package.json`**

```json
{
  "name": "@meta-agent/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/bin.ts",
  "bin": { "meta-agent": "./src/bin.ts" },
  "scripts": {
    "test": "node --test --experimental-transform-types --no-warnings 'src/**/*.test.ts'"
  },
  "dependencies": {
    "@meta-agent/core": "*"
  }
}
```

- **Step 9: Create `packages/cli/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src" },
  "include": ["src/**/*.ts"]
}
```

Note: no `references` — core cannot be a `composite` project while it also sets `noEmit: true`, and the workspace symlink at `node_modules/@meta-agent/core` plus `moduleResolution: Bundler` resolves the import at typecheck time.

- **Step 10: Create `packages/cli/src/bin.ts`**

```ts
#!/usr/bin/env node
import { version } from "@meta-agent/core";
console.log(`meta-agent v${version} — bin stub`);
```

- **Step 11: Install and verify**

```bash
npm install
npm run typecheck
npm run cli
```

Expected output from `npm run cli`:

```
meta-agent v0.1.0 — bin stub
```

- **Step 12: Commit**

```bash
git add -A
git commit -m "Task 1: scaffold npm workspaces, TS config, bin stub"
```

---

## Task 2: Shared Types and JSON Schemas

**Files:**

- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/schemas.ts`
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/src/schemas.test.ts`
- **Step 1: Create `packages/core/src/types.ts`**

```ts
export type Permissions = {
  fsRead: string[];
  fsWrite: string[];
  net: "none" | "allowlist";
  netAllowlist: string[];
  env: string[];
};

export type Limits = {
  timeoutMs: number;
  maxOldSpaceSizeMb: number;
};

export type ToolKind = "atomic" | "composite";

export type ToolManifest = {
  name: string;
  description: string;
  rationale: string;
  inputSchema: Record<string, unknown>;
  outputShape: Record<string, unknown>;
  permissions: Permissions;
  dependencies: string[];
  limits: Limits;
  hash: string;
  createdAt: string;
  kind: ToolKind;
};

export type Tool = {
  manifest: ToolManifest;
  code: string;
};

export type ToolDraft = {
  name: string;
  description: string;
  rationale: string;
  inputSchema: Record<string, unknown>;
  outputShape: Record<string, unknown>;
  permissions: Permissions;
  code: string;
  dependencies: string[];
  smokeTestInput: unknown;
  kind: ToolKind;
  limits?: Partial<Limits>;
};

export type ApprovalRecord = {
  hash: string;
  approvedAt: string;
  approvedBy: string;
  alwaysApprove: boolean;
  notes?: string;
};

export type ApprovalToken = string;

export type ToolErrorKind =
  | "timeout"
  | "permission_denied"
  | "runtime_error"
  | "rejected_by_user"
  | "schema_violation"
  | "output_truncated"
  | "depth_exceeded"
  | "unknown_tool";

export type ToolError = {
  kind: ToolErrorKind;
  message: string;
  details?: unknown;
};

export type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; error: ToolError };

export type CatalogEntry = {
  name: string;
  shortDescription: string;
  kind: ToolKind;
};

export type FindResult = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  score: number;
  matchSpans: string[];
};

export type ToolSummary = {
  name: string;
  description: string;
  hash: string;
  kind: ToolKind;
};
```

- **Step 2: Create `packages/core/src/schemas.ts`**

```ts
export const PERMISSIONS_SCHEMA = {
  type: "object",
  properties: {
    fsRead: { type: "array", items: { type: "string" } },
    fsWrite: { type: "array", items: { type: "string" } },
    net: { type: "string", enum: ["none", "allowlist"] },
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
    kind: { type: "string", enum: ["atomic", "composite"] },
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
    kind: { type: "string", enum: ["atomic", "composite"] },
  },
  required: [
    "name", "description", "rationale", "inputSchema", "outputShape",
    "permissions", "code", "dependencies", "smokeTestInput", "kind",
  ],
  additionalProperties: false,
} as const;
```

- **Step 3: Create `packages/core/src/errors.ts`**

```ts
import type { ToolError, ToolErrorKind } from "./types.ts";

export function toolError(
  kind: ToolErrorKind,
  message: string,
  details?: unknown,
): { ok: false; error: ToolError } {
  return { ok: false, error: details === undefined
    ? { kind, message }
    : { kind, message, details }
  };
}
```

- **Step 4: Write the failing test — `packages/core/src/schemas.test.ts`**

```ts
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
```

- **Step 5: Add `ajv-formats` dependency**

```bash
cd packages/core && npm install ajv-formats@^3.0.1 && cd ../..
```

- **Step 6: Run tests (verify they pass)**

```bash
npm test -w @meta-agent/core
```

Expected: 4 tests pass.

- **Step 7: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- **Step 8: Commit**

```bash
git add -A
git commit -m "Task 2: shared types, JSON schemas (manifest + draft), error factory"
```

---

## Task 3: Canonical JSON and Hashing

**Files:**

- Create: `packages/core/src/hash.ts`
- Create: `packages/core/src/hash.test.ts`
- **Step 1: Write the failing test — `packages/core/src/hash.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, hashTool } from "./hash.ts";

test("canonicalJson sorts object keys deterministically", () => {
  const a = canonicalJson({ b: 1, a: 2, c: { z: 3, y: 4 } });
  const b = canonicalJson({ a: 2, c: { y: 4, z: 3 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":{"y":4,"z":3}}');
});

test("canonicalJson preserves array order", () => {
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
});

test("hashTool is stable under key reordering of manifest", () => {
  const code = "export async function run(){return 1;}";
  const manifest1 = { name: "t", x: 1, y: 2 };
  const manifest2 = { y: 2, name: "t", x: 1 };
  assert.equal(hashTool(code, manifest1 as any), hashTool(code, manifest2 as any));
});

test("hashTool changes when code changes", () => {
  const manifest = { name: "t" } as any;
  assert.notEqual(hashTool("a", manifest), hashTool("b", manifest));
});

test("hashTool produces sha256:<hex> format", () => {
  const h = hashTool("x", { name: "t" } as any);
  assert.match(h, /^sha256:[a-f0-9]{64}$/);
});
```

- **Step 2: Run test to verify it fails**

```bash
npm test -w @meta-agent/core
```

Expected: errors — cannot resolve `./hash.ts`.

- **Step 3: Create `packages/core/src/hash.ts`**

```ts
import { createHash } from "node:crypto";
import type { ToolManifest } from "./types.ts";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}

export function hashTool(code: string, manifestWithoutHash: Omit<ToolManifest, "hash"> | Record<string, unknown>): string {
  const h = createHash("sha256");
  h.update(code);
  h.update("\n---manifest---\n");
  h.update(canonicalJson(manifestWithoutHash));
  return "sha256:" + h.digest("hex");
}
```

- **Step 4: Run tests to verify they pass**

```bash
npm test -w @meta-agent/core
```

Expected: all tests pass.

- **Step 5: Commit**

```bash
git add -A
git commit -m "Task 3: canonical JSON + sha256 tool hashing helper"
```

---

## Task 4: Tracer (JSONL Append-Only)

**Files:**

- Create: `packages/core/src/tracer.ts`
- Create: `packages/core/src/tracer.test.ts`
- **Step 1: Write the failing test**

```ts
// packages/core/src/tracer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer } from "./tracer.ts";

async function tmp() {
  return mkdtemp(join(tmpdir(), "meta-agent-trace-"));
}

test("Tracer writes JSONL events in order", async () => {
  const dir = await tmp();
  try {
    const tracer = await Tracer.open(dir, "session-1");
    tracer.log("llm-turn", { modelId: "x", latency: 10 });
    tracer.log("tool-invoked", { name: "t", duration: 5 });
    await tracer.close();

    const files = (await readFile(join(dir, tracer.filename), "utf8")).trim().split("\n");
    assert.equal(files.length, 2);
    const e1 = JSON.parse(files[0]!);
    const e2 = JSON.parse(files[1]!);
    assert.equal(e1.kind, "llm-turn");
    assert.equal(e1.sessionId, "session-1");
    assert.ok(e1.ts);
    assert.equal(e2.kind, "tool-invoked");
    assert.equal(e2.data.name, "t");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Tracer.log is synchronous from caller's perspective but flushes on close", async () => {
  const dir = await tmp();
  try {
    const tracer = await Tracer.open(dir, "s");
    for (let i = 0; i < 100; i++) tracer.log("x", { i });
    await tracer.close();
    const lines = (await readFile(join(dir, tracer.filename), "utf8")).trim().split("\n");
    assert.equal(lines.length, 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- **Step 2: Run test (expect failure)**

```bash
npm test -w @meta-agent/core
```

Expected: cannot resolve `./tracer.ts`.

- **Step 3: Create `packages/core/src/tracer.ts`**

```ts
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type TraceEvent = {
  ts: string;
  sessionId: string;
  kind: string;
  data: Record<string, unknown>;
};

export class Tracer {
  readonly filename: string;
  readonly sessionId: string;
  private stream: WriteStream;

  private constructor(filename: string, sessionId: string, stream: WriteStream) {
    this.filename = filename;
    this.sessionId = sessionId;
    this.stream = stream;
  }

  static async open(dir: string, sessionId: string): Promise<Tracer> {
    await mkdir(dir, { recursive: true });
    const iso = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${iso}-${sessionId}.jsonl`;
    const stream = createWriteStream(join(dir, filename), { flags: "a" });
    return new Tracer(filename, sessionId, stream);
  }

  log(kind: string, data: Record<string, unknown>): void {
    const event: TraceEvent = {
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      kind,
      data,
    };
    this.stream.write(JSON.stringify(event) + "\n");
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
```

- **Step 4: Run tests (expect pass)**

```bash
npm test -w @meta-agent/core
```

Expected: both tests pass.

- **Step 5: Commit**

```bash
git add -A
git commit -m "Task 4: JSONL append-only tracer"
```

---

## Task 5: Filesystem Tool Registry

**Files:**

- Create: `packages/core/src/registry/interface.ts`
- Create: `packages/core/src/registry/fs-registry.ts`
- Create: `packages/core/src/registry/fs-registry.test.ts`
- **Step 1: Create the interface — `packages/core/src/registry/interface.ts`**

```ts
import type { ApprovalRecord, Tool, ToolSummary } from "../types.ts";

export interface ToolRegistry {
  list(): Promise<ToolSummary[]>;
  get(name: string): Promise<Tool | null>;
  getApproval(name: string): Promise<ApprovalRecord | null>;
  save(tool: Tool, approval: ApprovalRecord): Promise<void>;
  delete(name: string, opts?: { cascade?: boolean }): Promise<void>;
  getDependents(name: string): Promise<string[]>;
  has(name: string): Promise<boolean>;
  rootDir(): string;
}
```

- **Step 2: Write the failing test — `packages/core/src/registry/fs-registry.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsToolRegistry } from "./fs-registry.ts";
import type { Tool, ApprovalRecord } from "../types.ts";

const sample = (name: string, deps: string[] = []): Tool => ({
  code: "export async function run(i){return i;}",
  manifest: {
    name,
    description: `desc of ${name}`,
    rationale: "r",
    inputSchema: { type: "object" },
    outputShape: { type: "object" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: deps,
    limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    hash: "sha256:" + "a".repeat(64),
    createdAt: "2026-04-21T00:00:00Z",
    kind: deps.length ? "composite" : "atomic",
  },
});

const approval: ApprovalRecord = {
  hash: "sha256:" + "a".repeat(64),
  approvedAt: "2026-04-21T00:00:00Z",
  approvedBy: "test",
  alwaysApprove: false,
};

async function tmp() {
  return mkdtemp(join(tmpdir(), "meta-agent-reg-"));
}

test("save/get roundtrip", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    await reg.save(sample("alpha"), approval);
    const got = await reg.get("alpha");
    assert.ok(got);
    assert.equal(got.manifest.name, "alpha");
    assert.equal(got.code, "export async function run(i){return i;}");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list returns summaries", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    await reg.save(sample("alpha"), approval);
    await reg.save(sample("bravo"), approval);
    const names = (await reg.list()).map((t) => t.name).sort();
    assert.deepEqual(names, ["alpha", "bravo"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getApproval returns saved record", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    await reg.save(sample("alpha"), approval);
    const got = await reg.getApproval("alpha");
    assert.deepEqual(got, approval);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getDependents finds composites that reference a tool", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    await reg.save(sample("base"), approval);
    await reg.save(sample("comp", ["base"]), approval);
    assert.deepEqual(await reg.getDependents("base"), ["comp"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete refuses when dependents exist unless cascade", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    await reg.save(sample("base"), approval);
    await reg.save(sample("comp", ["base"]), approval);
    await assert.rejects(reg.delete("base"), /dependents/i);
    await reg.delete("base", { cascade: true });
    assert.equal(await reg.get("base"), null);
    assert.equal(await reg.get("comp"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry rehydrates from disk on reopen", async () => {
  const dir = await tmp();
  try {
    let reg = await FsToolRegistry.open(dir);
    await reg.save(sample("alpha"), approval);
    reg = await FsToolRegistry.open(dir);
    assert.equal((await reg.list()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- **Step 3: Run test (expect failure)**

```bash
npm test -w @meta-agent/core
```

Expected: cannot resolve `./fs-registry.ts`.

- **Step 4: Create `packages/core/src/registry/fs-registry.ts`**

```ts
import { mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalRecord, Tool, ToolManifest, ToolSummary } from "../types.ts";
import type { ToolRegistry } from "./interface.ts";

export class FsToolRegistry implements ToolRegistry {
  private readonly dir: string;
  private cache = new Map<string, { tool: Tool; approval: ApprovalRecord | null }>();

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async open(dir: string): Promise<FsToolRegistry> {
    await mkdir(dir, { recursive: true });
    const reg = new FsToolRegistry(dir);
    await reg.rehydrate();
    return reg;
  }

  rootDir(): string {
    return this.dir;
  }

  private async rehydrate(): Promise<void> {
    this.cache.clear();
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const sub = join(this.dir, name);
      const st = await stat(sub).catch(() => null);
      if (!st?.isDirectory()) continue;
      const manifestPath = join(sub, "manifest.json");
      const codePath = join(sub, "tool.ts");
      const approvalPath = join(sub, "approval.json");
      try {
        const [mRaw, code] = await Promise.all([
          readFile(manifestPath, "utf8"),
          readFile(codePath, "utf8"),
        ]);
        const manifest = JSON.parse(mRaw) as ToolManifest;
        let approval: ApprovalRecord | null = null;
        try {
          approval = JSON.parse(await readFile(approvalPath, "utf8")) as ApprovalRecord;
        } catch { /* missing approval.json is OK */ }
        this.cache.set(manifest.name, { tool: { manifest, code }, approval });
      } catch {
        // Corrupt/partial entry — skip. Future work: surface as warning via Tracer.
      }
    }
  }

  async list(): Promise<ToolSummary[]> {
    return Array.from(this.cache.values()).map(({ tool }) => ({
      name: tool.manifest.name,
      description: tool.manifest.description,
      hash: tool.manifest.hash,
      kind: tool.manifest.kind,
    }));
  }

  async has(name: string): Promise<boolean> {
    return this.cache.has(name);
  }

  async get(name: string): Promise<Tool | null> {
    return this.cache.get(name)?.tool ?? null;
  }

  async getApproval(name: string): Promise<ApprovalRecord | null> {
    return this.cache.get(name)?.approval ?? null;
  }

  async save(tool: Tool, approval: ApprovalRecord): Promise<void> {
    const sub = join(this.dir, tool.manifest.name);
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "tool.ts"), tool.code, "utf8");
    await writeFile(join(sub, "manifest.json"), JSON.stringify(tool.manifest, null, 2), "utf8");
    await writeFile(join(sub, "approval.json"), JSON.stringify(approval, null, 2), "utf8");
    this.cache.set(tool.manifest.name, { tool, approval });
  }

  async delete(name: string, opts: { cascade?: boolean } = {}): Promise<void> {
    const dependents = await this.getDependents(name);
    if (dependents.length > 0 && !opts.cascade) {
      throw new Error(`Cannot delete '${name}': dependents exist: ${dependents.join(", ")}`);
    }
    if (opts.cascade) {
      for (const d of dependents) await this.delete(d, { cascade: true });
    }
    await rm(join(this.dir, name), { recursive: true, force: true });
    this.cache.delete(name);
  }

  async getDependents(name: string): Promise<string[]> {
    const out: string[] = [];
    for (const { tool } of this.cache.values()) {
      if (tool.manifest.dependencies.includes(name)) out.push(tool.manifest.name);
    }
    return out.sort();
  }
}
```

- **Step 5: Run tests (expect pass)**

```bash
npm test -w @meta-agent/core
```

Expected: all 6 registry tests pass.

- **Step 6: Commit**

```bash
git add -A
git commit -m "Task 5: FsToolRegistry with caching, dependents, cascade delete"
```

---

## Task 6: Hybrid Tool Index (Catalog + Substring/BM25-Lite Find)

**Files:**

- Create: `packages/core/src/index-store/interface.ts`
- Create: `packages/core/src/index-store/hybrid-index.ts`
- Create: `packages/core/src/index-store/hybrid-index.test.ts`
- **Step 1: Create the interface — `packages/core/src/index-store/interface.ts`**

```ts
import type { CatalogEntry, FindResult } from "../types.ts";

export interface ToolIndex {
  catalog(opts?: { maxEntries?: number }): CatalogEntry[];
  find(query: string, opts?: { k?: number }): Promise<FindResult[]>;
}
```

- **Step 2: Write the failing test — `packages/core/src/index-store/hybrid-index.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { HybridToolIndex } from "./hybrid-index.ts";
import type { ToolRegistry } from "../registry/interface.ts";
import type { ApprovalRecord, Tool, ToolSummary } from "../types.ts";

function mkTool(name: string, description: string, rationale = ""): Tool {
  return {
    code: "",
    manifest: {
      name, description, rationale,
      inputSchema: { type: "object" }, outputShape: { type: "object" },
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [], limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
      hash: "sha256:" + "a".repeat(64),
      createdAt: "2026-04-21T00:00:00Z", kind: "atomic",
    },
  };
}

class StubRegistry implements ToolRegistry {
  private tools: Tool[];
  constructor(tools: Tool[]) { this.tools = tools; }
  rootDir() { return "/tmp"; }
  async list(): Promise<ToolSummary[]> {
    return this.tools.map((t) => ({
      name: t.manifest.name, description: t.manifest.description,
      hash: t.manifest.hash, kind: t.manifest.kind,
    }));
  }
  async get(name: string) { return this.tools.find((t) => t.manifest.name === name) ?? null; }
  async getApproval(_n: string): Promise<ApprovalRecord | null> { return null; }
  async save() { throw new Error("stub"); }
  async delete() { throw new Error("stub"); }
  async getDependents() { return []; }
  async has(n: string) { return this.tools.some((t) => t.manifest.name === n); }
}

test("catalog returns name + short description", async () => {
  const reg = new StubRegistry([
    mkTool("web-fetch", "Fetches a URL and returns the body as text."),
    mkTool("csv-parse", "Parses CSV strings into row objects."),
  ]);
  const idx = await HybridToolIndex.open(reg);
  const cat = idx.catalog();
  assert.equal(cat.length, 2);
  assert.ok(cat.some((e) => e.name === "web-fetch" && e.shortDescription.includes("Fetches")));
});

test("find ranks by token overlap and exact name match", async () => {
  const reg = new StubRegistry([
    mkTool("csv-parse", "Parses CSV strings."),
    mkTool("web-fetch", "Fetches a URL."),
    mkTool("json-extract", "Extracts values from JSON via JSONPath."),
  ]);
  const idx = await HybridToolIndex.open(reg);
  const results = await idx.find("parse csv");
  assert.equal(results[0]!.name, "csv-parse");
  assert.ok(results[0]!.score > (results[1]?.score ?? 0));
});

test("find is case-insensitive and tokenizes kebab-case names", async () => {
  const reg = new StubRegistry([ mkTool("csv-parse", "ignored") ]);
  const idx = await HybridToolIndex.open(reg);
  const results = await idx.find("CSV");
  assert.equal(results[0]!.name, "csv-parse");
});

test("find respects k limit", async () => {
  const reg = new StubRegistry([
    mkTool("a", "foo bar"),
    mkTool("b", "foo bar baz"),
    mkTool("c", "foo bar baz qux"),
  ]);
  const idx = await HybridToolIndex.open(reg);
  assert.equal((await idx.find("foo", { k: 2 })).length, 2);
});

test("catalog maxEntries truncates", async () => {
  const reg = new StubRegistry(
    Array.from({ length: 50 }, (_, i) => mkTool(`t${i}`, `desc ${i}`))
  );
  const idx = await HybridToolIndex.open(reg);
  assert.equal(idx.catalog({ maxEntries: 10 }).length, 10);
});
```

- **Step 3: Run test (expect failure)**

```bash
npm test -w @meta-agent/core
```

Expected: cannot resolve `./hybrid-index.ts`.

- **Step 4: Create `packages/core/src/index-store/hybrid-index.ts`**

```ts
import type { CatalogEntry, FindResult } from "../types.ts";
import type { ToolRegistry } from "../registry/interface.ts";
import type { ToolIndex } from "./interface.ts";

const TOKEN_RE = /[a-z0-9]+/gi;

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) out.push(m[0]);
  return out;
}

function firstSentence(desc: string, max: number): string {
  const s = desc.trim().split(/(?<=[.!?])\s/)[0] ?? desc.trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export class HybridToolIndex implements ToolIndex {
  private readonly registry: ToolRegistry;

  private constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  static async open(registry: ToolRegistry): Promise<HybridToolIndex> {
    return new HybridToolIndex(registry);
  }

  catalog(opts: { maxEntries?: number } = {}): CatalogEntry[] {
    const max = opts.maxEntries ?? 40;
    // list() is async on the interface, but FsToolRegistry's in-memory form
    // resolves synchronously; we snapshot via a helper exposed through the interface.
    // For correctness we use a sync mirror: registry.list() is guaranteed O(1).
    // We accept the `any` cast because the interface declares async to allow
    // alternative implementations; our default registry resolves immediately.
    const listAsync = this.registry.list();
    const list = (listAsync as unknown as { __entries?: unknown[] }).__entries as
      | { name: string; description: string; kind: "atomic" | "composite" }[]
      | undefined;
    if (list) return list.slice(0, max).map((s) => ({
      name: s.name,
      shortDescription: firstSentence(s.description, 80),
      kind: s.kind,
    }));
    // Fallback: block on a resolved promise via synchronous helper.
    throw new Error("catalog() requires a registry that exposes synchronous list; use FsToolRegistry or wrap with a sync adapter.");
  }

  async find(query: string, opts: { k?: number } = {}): Promise<FindResult[]> {
    const k = opts.k ?? 5;
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    const qSet = new Set(qTokens);
    const tools = await this.registry.list();

    const corpus = await Promise.all(tools.map(async (t) => {
      const full = await this.registry.get(t.name);
      const text = [t.name, t.description, full?.manifest.rationale ?? ""].join(" ");
      return { name: t.name, description: t.description, inputSchema: full?.manifest.inputSchema ?? {}, tokens: tokenize(text) };
    }));

    const df = new Map<string, number>();
    for (const doc of corpus) {
      const seen = new Set(doc.tokens);
      for (const tok of seen) df.set(tok, (df.get(tok) ?? 0) + 1);
    }
    const N = corpus.length || 1;

    const scored: FindResult[] = corpus.map((doc) => {
      let score = 0;
      const spans: string[] = [];

      const nameTokens = tokenize(doc.name);
      if (nameTokens.some((t) => qSet.has(t))) { score += 4; spans.push(doc.name); }
      if (doc.description.toLowerCase().includes(query.toLowerCase())) {
        score += 2; spans.push(doc.description);
      }

      const tf = new Map<string, number>();
      for (const tok of doc.tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
      for (const q of qTokens) {
        const t = tf.get(q) ?? 0;
        if (t === 0) continue;
        const idf = Math.log(1 + N / (df.get(q) ?? 1));
        score += t * idf;
      }

      const overlap = qTokens.filter((t) => doc.tokens.includes(t)).length / qTokens.length;
      score += overlap;

      return { name: doc.name, description: doc.description, inputSchema: doc.inputSchema as Record<string, unknown>, score, matchSpans: spans };
    });

    return scored.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }
}
```

Note: `catalog()` is synchronous by interface but registry `list()` is async. The implementation above throws if given a registry that isn't the FS one. To fix this cleanly, extend the registry interface to expose a synchronous snapshot.

- **Step 5: Extend `ToolRegistry` with `listSync` — modify `packages/core/src/registry/interface.ts`**

```ts
import type { ApprovalRecord, Tool, ToolSummary } from "../types.ts";

export interface ToolRegistry {
  list(): Promise<ToolSummary[]>;
  /** Synchronous snapshot; required for prompt rendering without await. */
  listSync(): ToolSummary[];
  get(name: string): Promise<Tool | null>;
  getApproval(name: string): Promise<ApprovalRecord | null>;
  save(tool: Tool, approval: ApprovalRecord): Promise<void>;
  delete(name: string, opts?: { cascade?: boolean }): Promise<void>;
  getDependents(name: string): Promise<string[]>;
  has(name: string): Promise<boolean>;
  rootDir(): string;
}
```

- **Step 6: Add `listSync` to `FsToolRegistry` — modify `packages/core/src/registry/fs-registry.ts`**

After the existing `list()` method, add:

```ts
  listSync(): ToolSummary[] {
    return Array.from(this.cache.values()).map(({ tool }) => ({
      name: tool.manifest.name,
      description: tool.manifest.description,
      hash: tool.manifest.hash,
      kind: tool.manifest.kind,
    }));
  }
```

- **Step 7: Update `StubRegistry` in test and rewrite `catalog()`**

In `packages/core/src/index-store/hybrid-index.test.ts`, add to the `StubRegistry` class:

```ts
  listSync(): ToolSummary[] {
    return this.tools.map((t) => ({
      name: t.manifest.name, description: t.manifest.description,
      hash: t.manifest.hash, kind: t.manifest.kind,
    }));
  }
```

Replace the `catalog()` method in `packages/core/src/index-store/hybrid-index.ts` with:

```ts
  catalog(opts: { maxEntries?: number } = {}): CatalogEntry[] {
    const max = opts.maxEntries ?? 40;
    return this.registry.listSync().slice(0, max).map((s) => ({
      name: s.name,
      shortDescription: firstSentence(s.description, 80),
      kind: s.kind,
    }));
  }
```

- **Step 8: Run tests (expect pass)**

```bash
npm test -w @meta-agent/core
```

Expected: all 5 index tests pass; previous tests still pass.

- **Step 9: Commit**

```bash
git add -A
git commit -m "Task 6: hybrid tool index (sync catalog + BM25-lite find), listSync on registry"
```

---

## Task 7: Tiered Approval Policy

**Files:**

- Create: `packages/core/src/approval/interface.ts`
- Create: `packages/core/src/approval/tiered-policy.ts`
- Create: `packages/core/src/approval/tiered-policy.test.ts`
- **Step 1: Create the interface — `packages/core/src/approval/interface.ts`**

```ts
import type { ApprovalRecord, ApprovalToken, Tool, ToolDraft, ToolResult } from "../types.ts";

export type Gate1Decision =
  | { decision: "approve"; alwaysApprove: boolean; notes?: string; editedDraft?: ToolDraft }
  | { decision: "reject"; reason: string };

export type ExecutionDecision =
  | { decision: "approve"; token: ApprovalToken; cacheForSession: boolean }
  | { decision: "reject"; reason: string };

export type RiskTier = "low" | "medium" | "elevated";

export interface ApprovalPrompter {
  promptGate1(draft: ToolDraft, smokeTest: ToolResult): Promise<Gate1Decision>;
  promptGate23(tool: Tool, args: unknown, tier: RiskTier): Promise<ExecutionDecision>;
}

export interface ApprovalPolicy {
  reviewDraft(draft: ToolDraft, smokeTest: ToolResult): Promise<Gate1Decision>;
  checkExecution(tool: Tool, args: unknown, approval: ApprovalRecord | null): Promise<ExecutionDecision>;
  readonly yolo: boolean;
}
```

- **Step 2: Write the failing test — `packages/core/src/approval/tiered-policy.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TieredApprovalPolicy, riskTier } from "./tiered-policy.ts";
import type { ApprovalRecord, Permissions, Tool } from "../types.ts";

function mkTool(perms: Partial<Permissions> = {}, hash = "sha256:" + "a".repeat(64)): Tool {
  return {
    code: "",
    manifest: {
      name: "t", description: "d", rationale: "r",
      inputSchema: { type: "object" }, outputShape: { type: "object" },
      permissions: {
        fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [],
        ...perms,
      },
      dependencies: [], limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
      hash, createdAt: "2026-04-21T00:00:00Z", kind: "atomic",
    },
  };
}

test("riskTier: empty permissions => low", () => {
  assert.equal(riskTier(mkTool().manifest.permissions, "/wkspc"), "low");
});

test("riskTier: fs-write inside workspace => medium", () => {
  assert.equal(riskTier(mkTool({ fsWrite: ["/wkspc/data"] }).manifest.permissions, "/wkspc"), "medium");
});

test("riskTier: fs-write outside workspace => elevated", () => {
  assert.equal(riskTier(mkTool({ fsWrite: ["/etc"] }).manifest.permissions, "/wkspc"), "elevated");
});

test("riskTier: any net allowlist => elevated", () => {
  assert.equal(riskTier(mkTool({ net: "allowlist", netAllowlist: ["api.example.com"] }).manifest.permissions, "/wkspc"), "elevated");
});

test("riskTier: env var matching SECRET pattern => elevated", () => {
  assert.equal(riskTier(mkTool({ env: ["OPENAI_API_KEY"] }).manifest.permissions, "/wkspc"), "elevated");
});

test("checkExecution auto-approves low with no prompt", async () => {
  const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no prompt expected"); } };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc" });
  const tool = mkTool();
  const approval: ApprovalRecord = { hash: tool.manifest.hash, approvedAt: "x", approvedBy: "u", alwaysApprove: false };
  const r = await policy.checkExecution(tool, {}, approval);
  assert.equal(r.decision, "approve");
});

test("checkExecution prompts on elevated; cached after alwaysApprove", async () => {
  const tool = mkTool({ net: "allowlist", netAllowlist: ["api.example.com"] });
  const approval: ApprovalRecord = { hash: tool.manifest.hash, approvedAt: "x", approvedBy: "u", alwaysApprove: true };
  let prompts = 0;
  const prompter = {
    promptGate1: async () => { throw new Error("no"); },
    promptGate23: async () => { prompts++; return { decision: "approve" as const, token: "tok", cacheForSession: true }; },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc" });
  // alwaysApprove on the record means no prompt
  const r = await policy.checkExecution(tool, {}, approval);
  assert.equal(r.decision, "approve");
  assert.equal(prompts, 0);
});

test("checkExecution rejects when approval hash mismatches", async () => {
  const tool = mkTool();
  const approval: ApprovalRecord = { hash: "sha256:" + "b".repeat(64), approvedAt: "x", approvedBy: "u", alwaysApprove: true };
  let reject = 0;
  const prompter = {
    promptGate1: async () => { throw new Error("no"); },
    promptGate23: async () => { reject++; return { decision: "reject" as const, reason: "user" }; },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc" });
  const r = await policy.checkExecution(tool, {}, approval);
  assert.equal(r.decision, "reject");
  assert.equal(reject, 1);
});

test("yolo mode auto-approves everything without prompting", async () => {
  const tool = mkTool({ net: "allowlist", netAllowlist: ["api.example.com"] });
  const prompter = {
    promptGate1: async () => { throw new Error("should not prompt"); },
    promptGate23: async () => { throw new Error("should not prompt"); },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc", yolo: true });
  const r = await policy.checkExecution(tool, {}, null);
  assert.equal(r.decision, "approve");
});
```

- **Step 3: Create `packages/core/src/approval/tiered-policy.ts`**

```ts
import type { ApprovalRecord, ApprovalToken, Permissions, Tool, ToolDraft, ToolResult } from "../types.ts";
import type { ApprovalPolicy, ApprovalPrompter, ExecutionDecision, Gate1Decision, RiskTier } from "./interface.ts";

const SECRET_PATTERN = /TOKEN|KEY|SECRET|PASS/i;

function pathOutsideWorkspace(path: string, workspace: string): boolean {
  const norm = path.replace(/\/+$/, "");
  const ws = workspace.replace(/\/+$/, "");
  return !(norm === ws || norm.startsWith(ws + "/"));
}

export function riskTier(perms: Permissions, workspace: string): RiskTier {
  if (perms.net !== "none") return "elevated";
  if (perms.fsWrite.some((p) => pathOutsideWorkspace(p, workspace))) return "elevated";
  if (perms.fsRead.some((p) => pathOutsideWorkspace(p, workspace))) return "elevated";
  if (perms.env.some((v) => SECRET_PATTERN.test(v))) return "elevated";
  if (perms.fsWrite.length > 0) return "medium";
  if (perms.env.length > 0) return "medium";
  return "low";
}

export type TieredOpts = {
  workspace: string;
  yolo?: boolean;
};

export class TieredApprovalPolicy implements ApprovalPolicy {
  readonly yolo: boolean;
  private readonly workspace: string;
  private readonly prompter: ApprovalPrompter;
  private readonly sessionCache = new Map<string, boolean>(); // key: hash, val: approved

  constructor(prompter: ApprovalPrompter, opts: TieredOpts) {
    this.prompter = prompter;
    this.workspace = opts.workspace;
    this.yolo = !!opts.yolo;
  }

  async reviewDraft(draft: ToolDraft, smokeTest: ToolResult): Promise<Gate1Decision> {
    if (this.yolo) {
      return { decision: "approve", alwaysApprove: true, notes: "yolo" };
    }
    return this.prompter.promptGate1(draft, smokeTest);
  }

  async checkExecution(tool: Tool, args: unknown, approval: ApprovalRecord | null): Promise<ExecutionDecision> {
    if (this.yolo) return { decision: "approve", token: newToken(), cacheForSession: false };

    if (approval && approval.hash !== tool.manifest.hash) {
      const r = await this.prompter.promptGate23(tool, args, riskTier(tool.manifest.permissions, this.workspace));
      return r;
    }

    const tier = riskTier(tool.manifest.permissions, this.workspace);
    const cacheKey = tool.manifest.hash;

    if (tier === "low") return { decision: "approve", token: newToken(), cacheForSession: false };

    if (approval?.alwaysApprove) return { decision: "approve", token: newToken(), cacheForSession: false };

    if (this.sessionCache.get(cacheKey)) return { decision: "approve", token: newToken(), cacheForSession: false };

    const r = await this.prompter.promptGate23(tool, args, tier);
    if (r.decision === "approve" && r.cacheForSession) this.sessionCache.set(cacheKey, true);
    return r;
  }
}

function newToken(): ApprovalToken {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
```

- **Step 4: Run tests (expect pass)**

```bash
npm test -w @meta-agent/core
```

Expected: all 8 approval tests pass.

- **Step 5: Commit**

```bash
git add -A
git commit -m "Task 7: tiered approval policy (risk tiering, session cache, yolo mode)"
```

---

## Task 8: LLM Provider (OpenAI SDK + Mock)

**Files:**

- Create: `packages/core/src/llm/interface.ts`
- Create: `packages/core/src/llm/openai-provider.ts`
- Create: `packages/core/src/llm/mock-provider.ts`
- Create: `packages/core/src/llm/mock-provider.test.ts`
- **Step 1: Create the interface — `packages/core/src/llm/interface.ts`**

```ts
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
};

export type ChatResponse = {
  message: Extract<ChatMessage, { role: "assistant" }>;
  usage?: { promptTokens: number; completionTokens: number };
};

export type StructuredRequest = {
  messages: ChatMessage[];
  schemaName: string;
  schema: Record<string, unknown>;
};

export interface LLMProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  generateStructured<T>(req: StructuredRequest): Promise<T>;
}
```

- **Step 2: Create `packages/core/src/llm/openai-provider.ts`**

```ts
import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider, StructuredRequest, ToolCall } from "./interface.ts";

export type OpenAIProviderOpts = {
  apiKey: string;
  baseURL?: string;
  model: string;
  requestTimeoutMs?: number;
};

export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts: OpenAIProviderOpts) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.requestTimeoutMs,
    });
    this.model = opts.model;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: req.messages as unknown as ChatCompletionCreateParamsNonStreaming["messages"],
      tool_choice: req.toolChoice ?? "auto",
      ...(req.tools ? { tools: req.tools } : {}),
    };
    const resp = await this.client.chat.completions.create(params);
    const choice = resp.choices[0];
    if (!choice) throw new Error("OpenAI response had no choices");
    const msg = choice.message;
    const toolCalls: ToolCall[] | undefined = msg.tool_calls?.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
    const assistantMsg: ChatMessage & { role: "assistant" } = {
      role: "assistant",
      content: msg.content ?? null,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    };
    return {
      message: assistantMsg,
      ...(resp.usage
        ? { usage: { promptTokens: resp.usage.prompt_tokens, completionTokens: resp.usage.completion_tokens } }
        : {}),
    };
  }

  async generateStructured<T>(req: StructuredRequest): Promise<T> {
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: req.messages as unknown as ChatCompletionCreateParamsNonStreaming["messages"],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: req.schemaName,
          schema: req.schema,
          strict: true,
        },
      },
    };
    const resp = await this.client.chat.completions.create(params);
    const content = resp.choices[0]?.message.content;
    if (!content) throw new Error("OpenAI structured response had no content");
    return JSON.parse(content) as T;
  }
}
```

Note: `ChatCompletionCreateParamsNonStreaming` is imported explicitly so `.choices`/`.usage` on the response aren't unioned away by the streaming-param branch. Under `exactOptionalPropertyTypes: true`, optional keys use conditional spreads rather than assigning `undefined`.

- **Step 3: Create `packages/core/src/llm/mock-provider.ts`**

```ts
import type { ChatRequest, ChatResponse, LLMProvider, StructuredRequest } from "./interface.ts";

export type ChatHandler = (req: ChatRequest, turn: number) => ChatResponse | Promise<ChatResponse>;
export type StructuredHandler<T = unknown> = (req: StructuredRequest, turn: number) => T | Promise<T>;

export class MockLLMProvider implements LLMProvider {
  private chatHandlers: ChatHandler[] = [];
  private structHandlers: StructuredHandler[] = [];
  private chatTurn = 0;
  private structTurn = 0;
  public calls: { chat: ChatRequest[]; structured: StructuredRequest[] } = { chat: [], structured: [] };

  onChat(handler: ChatHandler): this { this.chatHandlers.push(handler); return this; }
  onStructured<T>(handler: StructuredHandler<T>): this { this.structHandlers.push(handler as StructuredHandler); return this; }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.chat.push(req);
    const h = this.chatHandlers[this.chatTurn++];
    if (!h) throw new Error(`MockLLMProvider: no chat handler for turn ${this.chatTurn - 1}`);
    return await h(req, this.chatTurn - 1);
  }

  async generateStructured<T>(req: StructuredRequest): Promise<T> {
    this.calls.structured.push(req);
    const h = this.structHandlers[this.structTurn++];
    if (!h) throw new Error(`MockLLMProvider: no structured handler for turn ${this.structTurn - 1}`);
    return (await h(req, this.structTurn - 1)) as T;
  }
}
```

- **Step 4: Write the failing test — `packages/core/src/llm/mock-provider.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLLMProvider } from "./mock-provider.ts";

test("MockLLMProvider dispatches handlers in order", async () => {
  const m = new MockLLMProvider()
    .onChat(() => ({ message: { role: "assistant", content: "first" } }))
    .onChat(() => ({ message: { role: "assistant", content: "second" } }));

  assert.equal((await m.chat({ messages: [] })).message.content, "first");
  assert.equal((await m.chat({ messages: [] })).message.content, "second");
});

test("MockLLMProvider records requests", async () => {
  const m = new MockLLMProvider().onStructured<{ok: boolean}>(() => ({ ok: true }));
  await m.generateStructured<{ok: boolean}>({ messages: [], schemaName: "T", schema: {} });
  assert.equal(m.calls.structured.length, 1);
});

test("MockLLMProvider throws when out of handlers", async () => {
  const m = new MockLLMProvider();
  await assert.rejects(m.chat({ messages: [] }), /no chat handler/);
});
```

- **Step 5: Run tests (expect pass)**

```bash
npm test -w @meta-agent/core
```

Expected: 3 new mock tests pass.

- **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- **Step 7: Commit**

```bash
git add -A
git commit -m "Task 8: LLMProvider interface + OpenAIProvider (openai SDK) + MockLLMProvider"
```

---

## Task 9: Sandbox Runner (Child-Side Bootstrap)

The runner is a TypeScript entry point executed inside each sandboxed child process. It imports the target tool, reads args from stdin, writes a result to stdout, and handles `invokeTool` RPC messages.

**Files:**

- Create: `packages/core/src/sandbox/runner.ts`
- Create: `packages/core/src/sandbox/runner.test.ts`
- Create: `packages/core/src/sandbox/fixtures/ok-tool.ts` (test fixture)
- Create: `packages/core/src/sandbox/fixtures/throws-tool.ts` (test fixture)
- **Step 1: Create `packages/core/src/sandbox/runner.ts`**

```ts
import { pathToFileURL } from "node:url";

type RunFn = (input: unknown) => Promise<unknown> | unknown;

type StdinFrame =
  | { op: "args"; args: unknown }
  | { op: "invokeToolResult"; requestId: string; result: { ok: true; value: unknown } | { ok: false; error: unknown } };

type StdoutFrame =
  | { op: "invokeTool"; requestId: string; name: string; args: unknown }
  | { op: "result"; result: { ok: true; value: unknown } | { ok: false; error: unknown } };

const pendingInvokes = new Map<string, (r: { ok: true; value: unknown } | { ok: false; error: unknown }) => void>();

(globalThis as any).invokeTool = async function invokeTool(name: string, args: unknown) {
  const requestId = Math.random().toString(36).slice(2);
  const frame: StdoutFrame = { op: "invokeTool", requestId, name, args };
  process.stdout.write(JSON.stringify(frame) + "\n");
  return new Promise((resolve) => pendingInvokes.set(requestId, resolve));
};

function installNetShim(netAllowlist: string[]): void {
  if (netAllowlist.length === 0) return;
  const allow = new Set(netAllowlist.map((h) => h.toLowerCase()));
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: unknown, init?: unknown) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    const host = new URL(url).hostname.toLowerCase();
    if (!allow.has(host)) {
      throw new Error(`net-shim: host '${host}' not in allowlist`);
    }
    return origFetch(input as Parameters<typeof origFetch>[0], init as Parameters<typeof origFetch>[1]);
  };
}

async function main() {
  const toolPath = process.argv[2];
  const netAllowlistRaw = process.env.META_AGENT_NET_ALLOWLIST ?? "";
  const netAllowlist = netAllowlistRaw ? netAllowlistRaw.split(",").filter(Boolean) : [];
  if (!toolPath) {
    process.stdout.write(JSON.stringify({ op: "result", result: { ok: false, error: { kind: "runtime_error", message: "runner: missing tool path" } } }) + "\n");
    process.exit(0);
  }

  installNetShim(netAllowlist);

  let mod: { run: RunFn };
  try {
    mod = (await import(pathToFileURL(toolPath).href)) as { run: RunFn };
    if (typeof mod.run !== "function") throw new Error("tool does not export a `run` function");
  } catch (e) {
    const err = e as Error;
    const frame: StdoutFrame = { op: "result", result: { ok: false, error: { kind: "runtime_error", message: `import failed: ${err.message}` } } };
    process.stdout.write(JSON.stringify(frame) + "\n");
    process.exit(0);
  }

  let buffer = "";
  let argsResolver: ((a: unknown) => void) | null = null;
  const argsPromise = new Promise<unknown>((resolve) => { argsResolver = resolve; });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) {
        try {
          const frame = JSON.parse(line) as StdinFrame;
          if (frame.op === "args") argsResolver?.(frame.args);
          else if (frame.op === "invokeToolResult") {
            const cb = pendingInvokes.get(frame.requestId);
            pendingInvokes.delete(frame.requestId);
            cb?.(frame.result);
          }
        } catch { /* ignore malformed line */ }
      }
      idx = buffer.indexOf("\n");
    }
  });

  const args = await argsPromise;

  try {
    const value = await mod.run(args);
    const frame: StdoutFrame = { op: "result", result: { ok: true, value } };
    process.stdout.write(JSON.stringify(frame) + "\n");
  } catch (e) {
    const err = e as Error;
    const frame: StdoutFrame = { op: "result", result: { ok: false, error: { kind: "runtime_error", message: err.message, details: { stack: err.stack } } } };
    process.stdout.write(JSON.stringify(frame) + "\n");
  }
  process.exit(0);
}

main();
```

- **Step 2: Create fixture — `packages/core/src/sandbox/fixtures/ok-tool.ts`**

```ts
export async function run(input: { x: number }): Promise<{ doubled: number }> {
  return { doubled: input.x * 2 };
}
```

- **Step 3: Create fixture — `packages/core/src/sandbox/fixtures/throws-tool.ts`**

```ts
export async function run(_input: unknown): Promise<never> {
  throw new Error("kaboom");
}
```

- **Step 4: Write the failing test — `packages/core/src/sandbox/runner.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(__dirname, "runner.ts");

function runChild(toolPath: string, args: unknown): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "--experimental-transform-types",
      "--no-warnings",
      RUNNER,
      toolPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.write(JSON.stringify({ op: "args", args }) + "\n");
    child.stdin.end();
  });
}

const OK = join(__dirname, "fixtures/ok-tool.ts");
const THROWS = join(__dirname, "fixtures/throws-tool.ts");

test("runner returns successful result", async () => {
  const { stdout, code } = await runChild(OK, { x: 21 });
  assert.equal(code, 0);
  const last = stdout.trim().split("\n").pop()!;
  const frame = JSON.parse(last);
  assert.equal(frame.op, "result");
  assert.equal(frame.result.ok, true);
  assert.deepEqual(frame.result.value, { doubled: 42 });
});

test("runner surfaces thrown errors as runtime_error", async () => {
  const { stdout, code } = await runChild(THROWS, {});
  assert.equal(code, 0);
  const last = stdout.trim().split("\n").pop()!;
  const frame = JSON.parse(last);
  assert.equal(frame.result.ok, false);
  assert.equal(frame.result.error.kind, "runtime_error");
  assert.match(frame.result.error.message, /kaboom/);
});
```

- **Step 5: Run tests (expect pass)**

```bash
npm test -w @meta-agent/core
```

Expected: 2 runner tests pass.

- **Step 6: Commit**

```bash
git add -A
git commit -m "Task 9: sandbox runner (child-side bootstrap + invokeTool RPC + net shim)"
```

---

## Task 10: NodePermissionSandbox (Parent-Side)

**Files:**

- Create: `packages/core/src/sandbox/interface.ts`
- Create: `packages/core/src/sandbox/node-permission-sandbox.ts`
- Create: `packages/core/src/sandbox/node-permission-sandbox.test.ts`
- Create: `packages/core/src/sandbox/fixtures/write-tool.ts`
- Create: `packages/core/src/sandbox/fixtures/slow-tool.ts`
- **Step 1: Create the interface — `packages/core/src/sandbox/interface.ts`**

```ts
import type { ApprovalToken, Tool, ToolResult } from "../types.ts";

export type InvokeToolHandler = (name: string, args: unknown) => Promise<ToolResult>;

export type ExecuteOpts = {
  toolPath?: string;
  onInvokeTool?: InvokeToolHandler;
  depth?: number;
};

export interface Sandbox {
  execute(tool: Tool, args: unknown, approvalToken: ApprovalToken, opts?: ExecuteOpts): Promise<ToolResult>;
}
```

- **Step 2: Create fixture — `packages/core/src/sandbox/fixtures/write-tool.ts`**

```ts
import { writeFile } from "node:fs/promises";
export async function run(input: { path: string; content: string }): Promise<{ written: number }> {
  await writeFile(input.path, input.content, "utf8");
  return { written: input.content.length };
}
```

- **Step 3: Create fixture — `packages/core/src/sandbox/fixtures/slow-tool.ts`**

```ts
export async function run(_input: unknown): Promise<never> {
  await new Promise((r) => setTimeout(r, 10_000));
  throw new Error("should have timed out");
}
```

- **Step 4: Write the failing test — `packages/core/src/sandbox/node-permission-sandbox.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodePermissionSandbox } from "./node-permission-sandbox.ts";
import type { Tool } from "../types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

function mkTool(name: string, toolPath: string, perms: Partial<Tool["manifest"]["permissions"]> = {}, timeoutMs = 5000): { tool: Tool; toolPath: string } {
  return {
    toolPath,
    tool: {
      code: "", // unused when toolPath is supplied
      manifest: {
        name, description: "d", rationale: "r",
        inputSchema: { type: "object" }, outputShape: { type: "object" },
        permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [], ...perms },
        dependencies: [], limits: { timeoutMs, maxOldSpaceSizeMb: 256 },
        hash: "sha256:" + "a".repeat(64), createdAt: "x", kind: "atomic",
      },
    },
  };
}

test("sandbox returns success for ok-tool", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const { tool } = mkTool("ok", "unused", { fsRead: [FIXTURES] });
  const r = await sb.execute(tool, { x: 3 }, "token", { toolPath: join(FIXTURES, "ok-tool.ts") });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { doubled: 6 });
});

test("sandbox blocks fs-write when permission not granted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-"));
  try {
    const sb = new NodePermissionSandbox({ workspace: dir });
    const { tool } = mkTool("w", "unused", { fsRead: [FIXTURES] });
    const r = await sb.execute(tool, { path: join(dir, "out.txt"), content: "hi" }, "token", { toolPath: join(FIXTURES, "write-tool.ts") });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(["permission_denied", "runtime_error"].includes(r.error.kind));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sandbox allows fs-write when permission granted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-"));
  try {
    const sb = new NodePermissionSandbox({ workspace: dir });
    const { tool } = mkTool("w", "unused", { fsRead: [FIXTURES, dir], fsWrite: [dir] });
    const r = await sb.execute(tool, { path: join(dir, "out.txt"), content: "hi" }, "token", { toolPath: join(FIXTURES, "write-tool.ts") });
    assert.equal(r.ok, true);
    const body = await readFile(join(dir, "out.txt"), "utf8");
    assert.equal(body, "hi");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sandbox enforces timeout", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const { tool } = mkTool("slow", "unused", { fsRead: [FIXTURES] }, 300);
  const r = await sb.execute(tool, {}, "token", { toolPath: join(FIXTURES, "slow-tool.ts") });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "timeout");
});

test("sandbox enforces depth cap on invokeTool recursion", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES, maxDepth: 2 });
  const { tool } = mkTool("ok", "unused", { fsRead: [FIXTURES] });
  const r = await sb.execute(tool, { x: 1 }, "token", {
    toolPath: join(FIXTURES, "ok-tool.ts"),
    depth: 3,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "depth_exceeded");
});
```

- **Step 5: Create `packages/core/src/sandbox/node-permission-sandbox.ts`**

```ts
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool, ToolResult } from "../types.ts";
import { toolError } from "../errors.ts";
import type { ExecuteOpts, InvokeToolHandler, Sandbox } from "./interface.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(__dirname, "runner.ts");

export type SandboxOpts = {
  workspace: string;
  maxDepth?: number;
  maxOutputBytes?: number;
};

export class NodePermissionSandbox implements Sandbox {
  private readonly workspace: string;
  private readonly maxDepth: number;
  private readonly maxOutputBytes: number;

  constructor(opts: SandboxOpts) {
    this.workspace = opts.workspace;
    this.maxDepth = opts.maxDepth ?? 8;
    this.maxOutputBytes = opts.maxOutputBytes ?? 1_048_576;
  }

  async execute(tool: Tool, args: unknown, _approvalToken: string, opts: ExecuteOpts = {}): Promise<ToolResult> {
    if ((opts.depth ?? 0) > this.maxDepth) {
      return toolError("depth_exceeded", `composite recursion depth exceeded ${this.maxDepth}`);
    }

    let toolPath = opts.toolPath;
    let cleanupDir: string | null = null;
    if (!toolPath) {
      cleanupDir = await mkdtemp(join(tmpdir(), "meta-agent-sb-"));
      toolPath = join(cleanupDir, `${tool.manifest.name}.ts`);
      await writeFile(toolPath, tool.code, "utf8");
    }

    try {
      return await this.run(tool, args, toolPath, opts.onInvokeTool, opts.depth ?? 0);
    } finally {
      if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
    }
  }

  private run(tool: Tool, args: unknown, toolPath: string, onInvoke: InvokeToolHandler | undefined, depth: number): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const perms = tool.manifest.permissions;
      const flags: string[] = [
        "--permission",
        "--experimental-transform-types",
        "--no-warnings",
        "--no-addons",
        `--max-old-space-size=${tool.manifest.limits.maxOldSpaceSizeMb}`,
      ];
      const allowRead = [this.workspace, dirname(toolPath), ...perms.fsRead];
      const allowWrite = [...perms.fsWrite];
      flags.push(`--allow-fs-read=${allowRead.join(",")}`);
      if (allowWrite.length > 0) flags.push(`--allow-fs-write=${allowWrite.join(",")}`);
      if (perms.net !== "none") flags.push("--allow-net");

      const env: NodeJS.ProcessEnv = {};
      for (const name of perms.env) if (process.env[name] !== undefined) env[name] = process.env[name];
      if (perms.net === "allowlist") env.META_AGENT_NET_ALLOWLIST = perms.netAllowlist.join(",");
      env.PATH = process.env.PATH ?? "";

      const child = spawn(process.execPath, [...flags, RUNNER_PATH, toolPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });

      let stdoutBuf = "";
      let stderrBytes = 0;
      let resolved = false;
      const truncateAt = this.maxOutputBytes;

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        child.kill("SIGKILL");
        resolve(toolError("timeout", `exceeded timeout of ${tool.manifest.limits.timeoutMs}ms`));
      }, tool.manifest.limits.timeoutMs);

      const processLine = async (line: string): Promise<void> => {
        if (!line.trim()) return;
        let frame: { op: "invokeTool"; requestId: string; name: string; args: unknown } | { op: "result"; result: ToolResult };
        try { frame = JSON.parse(line); } catch { return; }
        if (frame.op === "invokeTool") {
          let result: ToolResult;
          try {
            result = onInvoke
              ? await onInvoke(frame.name, frame.args)
              : toolError("unknown_tool", "no invokeTool handler installed for composite");
          } catch (e) {
            result = toolError("runtime_error", (e as Error).message);
          }
          child.stdin.write(JSON.stringify({ op: "invokeToolResult", requestId: frame.requestId, result }) + "\n");
        } else if (frame.op === "result") {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          resolve(frame.result);
        }
      };

      child.stdout.on("data", (c: Buffer) => {
        stdoutBuf += c.toString();
        if (stdoutBuf.length > truncateAt) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            child.kill("SIGKILL");
            resolve(toolError("output_truncated", `stdout exceeded ${truncateAt} bytes`));
          }
          return;
        }
        let idx = stdoutBuf.indexOf("\n");
        while (idx >= 0) {
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          void processLine(line);
          idx = stdoutBuf.indexOf("\n");
        }
      });

      child.stderr.on("data", (c: Buffer) => {
        stderrBytes += c.length;
        if (stderrBytes > truncateAt && !resolved) {
          resolved = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve(toolError("output_truncated", `stderr exceeded ${truncateAt} bytes`));
        }
      });

      child.on("error", (e) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(toolError("runtime_error", `spawn failed: ${e.message}`));
      });

      child.on("close", (code, signal) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (signal) resolve(toolError("runtime_error", `child killed by signal ${signal}`));
        else resolve(toolError("runtime_error", `child exited with code ${code ?? "null"} without emitting a result frame`));
      });

      child.stdin.write(JSON.stringify({ op: "args", args }) + "\n");
      // Do not close stdin yet — keep it open so the parent can send invokeToolResult frames.
      // The runner process.exit after emitting its result frame; its stdin handle closes automatically.
      void depth; // unused at this layer; the caller propagates via opts.depth for recursion checks
    });
  }
}
```

- **Step 6: Run tests (expect pass)**

```bash
npm test -w @meta-agent/core
```

Expected: 5 sandbox tests pass. (If the fs-write blocking test is flaky across Node versions because `--permission` error surfacing varies, accept either `permission_denied` or `runtime_error` kind as the test already does.)

**Implementation notes from Task 10 execution (deviations from the plan above):**

1. **Per-path `--allow-fs-*` flags, not comma-separated.** Node 22.22.2 only honors the first path in a comma-joined value empirically (despite the docs). The implementation emits one `--allow-fs-read=<path>` / `--allow-fs-write=<path>` flag per path.
2. `**dirname(RUNNER_PATH)` is added to the read allowlist.** The child must be able to `import` the runner itself; the workspace/tool dirs usually do not contain it.
3. **Node's `--permission` denials surface as thrown `ERR_ACCESS_DENIED`**, which bubble up as `runtime_error` from the runner (not as a distinct `permission_denied` kind from the sandbox). The test already accepts either; downstream code should not rely on the `permission_denied` kind for sandbox-origin denials.

- **Step 7: Commit**

```bash
git add -A
git commit -m "Task 10: NodePermissionSandbox (child_process + --permission + invokeTool JSON-RPC)"
```

---

## Task 11: Static Validator (Imports + Deps/Calls Match)

**Files:**

- Create: `packages/core/src/factory/static-validator.ts`
- Create: `packages/core/src/factory/static-validator.test.ts`
- **Step 1: Write the failing test — `packages/core/src/factory/static-validator.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { staticValidateDraft } from "./static-validator.ts";
import type { ToolDraft } from "../types.ts";

function draft(overrides: Partial<ToolDraft> = {}): ToolDraft {
  return {
    name: "t",
    description: "d",
    rationale: "r",
    inputSchema: { type: "object" },
    outputShape: { type: "object" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    code: "export async function run(i){ return i; }",
    dependencies: [],
    smokeTestInput: {},
    kind: "atomic",
    ...overrides,
  };
}

test("passes a minimal atomic draft", () => {
  const r = staticValidateDraft(draft(), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, true);
});

test("rejects duplicate name", () => {
  const r = staticValidateDraft(draft(), { existingNames: new Set(["t"]), tombstoned: new Set() });
  assert.equal(r.ok, false);
});

test("rejects tombstoned name", () => {
  const r = staticValidateDraft(draft(), { existingNames: new Set(), tombstoned: new Set(["t"]) });
  assert.equal(r.ok, false);
});

test("rejects disallowed import (child_process)", () => {
  const r = staticValidateDraft(draft({
    code: `import { spawn } from "node:child_process";\nexport async function run(){}`,
  }), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, false);
});

test("rejects bare npm import (only node:* allowed)", () => {
  const r = staticValidateDraft(draft({
    code: `import lodash from "lodash";\nexport async function run(){}`,
  }), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, false);
});

test("rejects fs import when no fs permission declared", () => {
  const r = staticValidateDraft(draft({
    code: `import { readFile } from "node:fs/promises";\nexport async function run(){}`,
  }), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, false);
});

test("allows fs import when fsRead declared", () => {
  const r = staticValidateDraft(draft({
    permissions: { fsRead: ["/tmp"], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    code: `import { readFile } from "node:fs/promises";\nexport async function run(){}`,
  }), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, true);
});

test("composite: declared deps must match invokeTool call sites", () => {
  const r = staticValidateDraft(draft({
    kind: "composite",
    dependencies: ["alpha"],
    code: `export async function run(){ return await invokeTool("bravo",{}); }`,
  }), { existingNames: new Set(["alpha","bravo"]), tombstoned: new Set() });
  assert.equal(r.ok, false);
});

test("composite: deps matching invokeTool calls passes", () => {
  const r = staticValidateDraft(draft({
    kind: "composite",
    dependencies: ["alpha","bravo"],
    code: `export async function run(){ const a = await invokeTool("alpha",{}); return invokeTool("bravo",a); }`,
  }), { existingNames: new Set(["alpha","bravo"]), tombstoned: new Set() });
  assert.equal(r.ok, true);
});

test("rejects eval/Function use", () => {
  const r = staticValidateDraft(draft({
    code: `export async function run(){ return eval("1+1"); }`,
  }), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, false);
});

test("atomic tool must not contain invokeTool calls", () => {
  const r = staticValidateDraft(draft({
    code: `export async function run(){ return invokeTool("x",{}); }`,
  }), { existingNames: new Set(["x"]), tombstoned: new Set() });
  assert.equal(r.ok, false);
});
```

- **Step 2: Create `packages/core/src/factory/static-validator.ts`**

```ts
import type { ToolDraft } from "../types.ts";

const ALLOWED_NODE_MODULES = new Set([
  "node:path", "node:url", "node:util", "node:buffer",
  "node:crypto", "node:stream", "node:timers", "node:timers/promises",
  "node:string_decoder", "node:querystring", "node:assert",
]);

const FS_MODULES = new Set(["node:fs", "node:fs/promises"]);
const NET_MODULES = new Set(["node:http", "node:https", "undici"]);
const FORBIDDEN_MODULES = new Set([
  "node:child_process", "node:worker_threads", "node:vm",
  "node:inspector", "node:perf_hooks", "node:cluster",
  "node:dgram", "node:dns", "node:net", "node:tls",
  "node:repl", "node:readline", "node:module",
  "child_process", "worker_threads", "vm", "inspector",
]);

const IMPORT_RE = /\bimport\s+(?:[\s\S]*?)from\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport\s+['"]([^'"]+)['"]/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const INVOKE_TOOL_RE = /\binvokeTool\s*\(\s*['"]([^'"]+)['"]/g;
const EVAL_RE = /\b(?:eval|Function)\s*\(/;

export type ValidationContext = {
  existingNames: Set<string>;
  tombstoned: Set<string>;
};

export type ValidationOk = { ok: true };
export type ValidationFail = { ok: false; errors: string[] };
export type ValidationResult = ValidationOk | ValidationFail;

export function extractImports(code: string): string[] {
  const out = new Set<string>();
  for (const re of [IMPORT_RE, SIDE_EFFECT_IMPORT_RE, REQUIRE_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) out.add(m[1]!);
  }
  return Array.from(out);
}

export function extractInvokeToolCalls(code: string): string[] {
  const out = new Set<string>();
  INVOKE_TOOL_RE.lastIndex = 0;
  for (const m of code.matchAll(INVOKE_TOOL_RE)) out.add(m[1]!);
  return Array.from(out);
}

export function staticValidateDraft(draft: ToolDraft, ctx: ValidationContext): ValidationResult {
  const errs: string[] = [];

  if (!/^[a-z][a-z0-9-]{1,63}$/.test(draft.name)) errs.push(`invalid name '${draft.name}'`);
  if (ctx.existingNames.has(draft.name)) errs.push(`name '${draft.name}' already exists`);
  if (ctx.tombstoned.has(draft.name)) errs.push(`name '${draft.name}' is tombstoned`);

  if (EVAL_RE.test(draft.code)) errs.push("eval/Function() not permitted");

  const imports = extractImports(draft.code);
  for (const mod of imports) {
    if (FORBIDDEN_MODULES.has(mod)) { errs.push(`forbidden import '${mod}'`); continue; }
    if (FS_MODULES.has(mod)) {
      if (draft.permissions.fsRead.length === 0 && draft.permissions.fsWrite.length === 0) {
        errs.push(`import of '${mod}' requires fsRead/fsWrite permissions`);
      }
      continue;
    }
    if (NET_MODULES.has(mod) || mod === "node:fetch") {
      if (draft.permissions.net === "none") errs.push(`import of '${mod}' requires net permission`);
      continue;
    }
    if (ALLOWED_NODE_MODULES.has(mod)) continue;
    if (!mod.startsWith("node:")) errs.push(`non-node import '${mod}' not allowed (v1 allows only node:* modules)`);
    else errs.push(`node module '${mod}' not in allowlist`);
  }

  const calls = extractInvokeToolCalls(draft.code);
  if (draft.kind === "atomic" && calls.length > 0) {
    errs.push(`atomic tool must not call invokeTool (found: ${calls.join(",")})`);
  }
  if (draft.kind === "composite") {
    const declared = new Set(draft.dependencies);
    const actual = new Set(calls);
    for (const d of declared) if (!actual.has(d)) errs.push(`declared dep '${d}' has no invokeTool call site`);
    for (const a of actual) if (!declared.has(a)) errs.push(`invokeTool('${a}') has no declared dependency`);
    for (const d of declared) if (!ctx.existingNames.has(d)) errs.push(`dependency '${d}' does not exist in registry`);
  }

  if (draft.smokeTestInput === undefined || draft.smokeTestInput === null && typeof draft.smokeTestInput !== "object") {
    // allow null/object/primitive; only forbid undefined
  }

  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true };
}
```

- **Step 3: Run tests (expect pass)**

```bash
npm test -w @meta-agent/core
```

Expected: all 11 static-validator tests pass.

- **Step 4: Commit**

```bash
git add -A
git commit -m "Task 11: static validator (imports allowlist, deps/calls match, banned patterns)"
```

---

## Task 12: Tool Factory (Code-Gen → Validate → Smoke → Approval → Save)

**Files:**

- Create: `packages/core/src/factory/code-gen-prompts.ts`
- Create: `packages/core/src/factory/factory.ts`
- Create: `packages/core/src/factory/factory.test.ts`
- **Step 1: Create `packages/core/src/factory/code-gen-prompts.ts`**

```ts
import type { ToolSummary } from "../types.ts";
import { TOOL_DRAFT_SCHEMA } from "../schemas.ts";

export const DRAFT_SCHEMA = TOOL_DRAFT_SCHEMA;

export function atomicPrompt(req: { intent: string; rationale: string; existingToolsConsidered: string[]; catalog: ToolSummary[] }): string {
  const cat = req.catalog.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  return `You are authoring a single TypeScript tool for a meta-agent system.
Constraints:
- The tool file exports exactly one async function named \`run\` that takes a typed input and returns a JSON-serializable value.
- The tool runs in a sandboxed Node subprocess with a strict permission manifest you must declare accurately.
- Only \`node:*\` builtins are importable (no npm packages).
- Do not use eval or the Function constructor.
- Do not call invokeTool — this is an atomic tool, not a composite.
- Declare only the minimum fsRead/fsWrite/net/env permissions the tool actually needs.
- Provide a valid JSON Schema for input and output.
- Provide a smokeTestInput matching your inputSchema that the system can use to verify the tool works.
- Pick a kebab-case name that is unique (not in the existing tools listed below) and descriptive of the capability.

Existing tools (do not duplicate):
${cat || "(none)"}

Agent intent: ${req.intent}
Rationale: ${req.rationale}
Already considered: ${req.existingToolsConsidered.join(", ") || "(none)"}

Return a ToolDraft matching the provided JSON schema. kind must be "atomic".`;
}

export function compositePrompt(req: { name: string; intent: string; plannedSteps: Array<{ tool: string; argsTemplate: string }>; catalog: ToolSummary[] }): string {
  const cat = req.catalog.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const steps = req.plannedSteps.map((s, i) => `${i + 1}. ${s.tool}(${s.argsTemplate})`).join("\n");
  return `You are authoring a composite TypeScript tool that orchestrates existing tools via invokeTool.
Constraints:
- Export \`async function run(input)\`.
- Call existing tools via the global \`invokeTool(name, args)\`. Do NOT reimplement their logic.
- Keep the code to thin orchestration: validate input, call tools, pass outputs along.
- Only \`node:*\` builtins are importable; no other imports are needed for pure composition.
- The \`dependencies\` array must exactly match the set of tool names passed to invokeTool.
- Declare only permissions the composite itself needs outside of invokeTool calls (usually none).
- Return a ToolDraft with kind="composite".

Tools available:
${cat}

Name: ${req.name}
Intent: ${req.intent}
Planned steps:
${steps}
`;
}

export function reactivePrompt(req: { sliceDescription: string; intent: string; name: string; catalog: ToolSummary[] }): string {
  return `You are authoring a composite TypeScript tool that reproduces the following successful session slice as a single reusable tool.

${compositePrompt({ name: req.name, intent: req.intent, plannedSteps: [], catalog: req.catalog })}

Original session slice (for reference):
${req.sliceDescription}

Identify the variable parts of the slice's inputs and make them parameters of the new tool's inputSchema. Stable parts can be baked in as defaults.`;
}

export function repairPrompt(previousDraft: unknown, errors: string[]): string {
  return `Your previous ToolDraft failed validation with the following errors:
${errors.map((e) => `- ${e}`).join("\n")}

Previous draft:
${JSON.stringify(previousDraft, null, 2)}

Produce a corrected ToolDraft matching the schema.`;
}
```

- **Step 2: Create `packages/core/src/factory/factory.ts`**

```ts
import type { ApprovalPolicy } from "../approval/interface.ts";
import type { LLMProvider } from "../llm/interface.ts";
import type { Sandbox } from "../sandbox/interface.ts";
import type { ToolRegistry } from "../registry/interface.ts";
import type { ApprovalRecord, Tool, ToolDraft, ToolManifest, ToolResult } from "../types.ts";
import { hashTool } from "../hash.ts";
import { staticValidateDraft, type ValidationResult } from "./static-validator.ts";
import { atomicPrompt, compositePrompt, reactivePrompt, repairPrompt, DRAFT_SCHEMA } from "./code-gen-prompts.ts";
import type { Tracer } from "../tracer.ts";

export type CreateAtomicReq = {
  intent: string;
  rationale: string;
  existingToolsConsidered: string[];
};

export type CreateCompositeReq = {
  name: string;
  intent: string;
  plannedSteps: Array<{ tool: string; argsTemplate: string }>;
};

export type CreateReactiveReq = {
  name: string;
  intent: string;
  sliceDescription: string;
};

export type FactoryOpts = {
  llm: LLMProvider;
  registry: ToolRegistry;
  sandbox: Sandbox;
  approval: ApprovalPolicy;
  tracer: Tracer;
  tombstoned: Set<string>;
  maxRepairAttempts?: number;
  approvedBy?: string;
};

export type FactoryOutcome =
  | { ok: true; tool: Tool; approval: ApprovalRecord }
  | { ok: false; reason: string };

export class ToolFactory {
  private readonly maxRepair: number;
  private readonly approvedBy: string;

  constructor(private readonly opts: FactoryOpts) {
    this.maxRepair = opts.maxRepairAttempts ?? 2;
    this.approvedBy = opts.approvedBy ?? "user";
  }

  async createAtomic(req: CreateAtomicReq): Promise<FactoryOutcome> {
    const system = atomicPrompt({ ...req, catalog: this.opts.registry.listSync() });
    return this.createWithPrompt(system);
  }

  async createComposite(req: CreateCompositeReq): Promise<FactoryOutcome> {
    const system = compositePrompt({ ...req, catalog: this.opts.registry.listSync() });
    return this.createWithPrompt(system);
  }

  async createReactive(req: CreateReactiveReq): Promise<FactoryOutcome> {
    const system = reactivePrompt({ ...req, catalog: this.opts.registry.listSync() });
    return this.createWithPrompt(system);
  }

  private async createWithPrompt(systemPrompt: string): Promise<FactoryOutcome> {
    const existingNames = new Set(this.opts.registry.listSync().map((s) => s.name));
    let draft = await this.genDraft(systemPrompt);
    let validation: ValidationResult = staticValidateDraft(draft, { existingNames, tombstoned: this.opts.tombstoned });

    let attempts = 0;
    while (!validation.ok && attempts < this.maxRepair) {
      attempts++;
      draft = await this.repair(draft, validation.errors);
      validation = staticValidateDraft(draft, { existingNames, tombstoned: this.opts.tombstoned });
    }
    if (!validation.ok) {
      this.opts.tracer.log("tool-rejected", { name: draft.name, reason: `static: ${validation.errors.join("; ")}` });
      return { ok: false, reason: `static validation failed: ${validation.errors.join("; ")}` };
    }

    const smokeTool = this.draftToTool(draft);
    const smoke: ToolResult = await this.smokeTest(smokeTool, draft.smokeTestInput);

    if (!smoke.ok) {
      attempts = 0;
      while (attempts < this.maxRepair) {
        attempts++;
        draft = await this.repair(draft, [`smoke test failed: ${smoke.error.kind}: ${smoke.error.message}`]);
        const v = staticValidateDraft(draft, { existingNames, tombstoned: this.opts.tombstoned });
        if (!v.ok) continue;
        const retry = await this.smokeTest(this.draftToTool(draft), draft.smokeTestInput);
        if (retry.ok) { return this.presentAndSave(draft, retry); }
      }
      this.opts.tracer.log("tool-rejected", { name: draft.name, reason: `smoke: ${smoke.error.message}` });
      return { ok: false, reason: `smoke test failed: ${smoke.error.message}` };
    }

    return this.presentAndSave(draft, smoke);
  }

  /**
   * Runs the draft in the sandbox. For composites, we install an `onInvokeTool`
   * handler that resolves declared dependencies via the registry and executes
   * them in a fresh sandbox. During smoke test we bypass the ApprovalPolicy for
   * sub-calls because (a) each dep was already approved at its own Gate 1 and
   * (b) the composite's bubbled-up permissions are surfaced to the reviewer at
   * this draft's Gate 1 immediately after the smoke test returns.
   */
  private async smokeTest(tool: Tool, input: unknown): Promise<ToolResult> {
    if (tool.manifest.kind === "atomic") {
      return this.opts.sandbox.execute(tool, input, "factory-smoke");
    }
    const makeInvoker = (d: number) => async (name: string, args: unknown): Promise<ToolResult> => {
      const dep = await this.opts.registry.get(name);
      if (!dep) return { ok: false, error: { kind: "unknown_tool", message: `dependency '${name}' not in registry` } };
      return this.opts.sandbox.execute(dep, args, "factory-smoke-sub", {
        onInvokeTool: makeInvoker(d + 1),
        depth: d,
      });
    };
    return this.opts.sandbox.execute(tool, input, "factory-smoke", {
      onInvokeTool: makeInvoker(1),
      depth: 0,
    });
  }

  private async presentAndSave(draft: ToolDraft, smoke: ToolResult): Promise<FactoryOutcome> {
    const decision = await this.opts.approval.reviewDraft(draft, smoke);
    if (decision.decision === "reject") {
      this.opts.tracer.log("tool-rejected", { name: draft.name, reason: decision.reason });
      return { ok: false, reason: decision.reason };
    }
    const finalDraft = decision.editedDraft ?? draft;
    const tool = this.draftToTool(finalDraft);
    const approval: ApprovalRecord = {
      hash: tool.manifest.hash,
      approvedAt: new Date().toISOString(),
      approvedBy: this.approvedBy,
      alwaysApprove: decision.alwaysApprove,
      ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
    };
    await this.opts.registry.save(tool, approval);
    this.opts.tracer.log("tool-created", { name: tool.manifest.name, hash: tool.manifest.hash, approvedBy: this.approvedBy });
    return { ok: true, tool, approval };
  }

  private draftToTool(draft: ToolDraft): Tool {
    const manifestSansHash: Omit<ToolManifest, "hash"> = {
      name: draft.name,
      description: draft.description,
      rationale: draft.rationale,
      inputSchema: draft.inputSchema,
      outputShape: draft.outputShape,
      permissions: draft.permissions,
      dependencies: draft.dependencies,
      limits: { timeoutMs: draft.limits?.timeoutMs ?? 30000, maxOldSpaceSizeMb: draft.limits?.maxOldSpaceSizeMb ?? 256 },
      createdAt: new Date().toISOString(),
      kind: draft.kind,
    };
    const hash = hashTool(draft.code, manifestSansHash);
    return { manifest: { ...manifestSansHash, hash }, code: draft.code };
  }

  private async genDraft(systemPrompt: string): Promise<ToolDraft> {
    return this.opts.llm.generateStructured<ToolDraft>({
      messages: [{ role: "system", content: systemPrompt }],
      schemaName: "ToolDraft",
      schema: DRAFT_SCHEMA,
    });
  }

  private async repair(previous: ToolDraft, errors: string[]): Promise<ToolDraft> {
    return this.opts.llm.generateStructured<ToolDraft>({
      messages: [
        { role: "system", content: "Produce a corrected ToolDraft." },
        { role: "user", content: repairPrompt(previous, errors) },
      ],
      schemaName: "ToolDraft",
      schema: DRAFT_SCHEMA,
    });
  }
}
```

- **Step 3: Write the failing test — `packages/core/src/factory/factory.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolFactory } from "./factory.ts";
import { MockLLMProvider } from "../llm/mock-provider.ts";
import { FsToolRegistry } from "../registry/fs-registry.ts";
import { NodePermissionSandbox } from "../sandbox/node-permission-sandbox.ts";
import { TieredApprovalPolicy } from "../approval/tiered-policy.ts";
import { Tracer } from "../tracer.ts";
import type { ToolDraft } from "../types.ts";

const GOOD_DRAFT: ToolDraft = {
  name: "double-int",
  description: "Doubles an integer.",
  rationale: "Tests need doubling.",
  inputSchema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"] },
  outputShape: { type: "object", properties: { doubled: { type: "integer" } } },
  permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  code: "export async function run(i){return {doubled: i.x*2};}",
  dependencies: [],
  smokeTestInput: { x: 5 },
  kind: "atomic",
};

test("factory: happy path — static passes, smoke passes, approval auto-approves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fac-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider().onStructured<ToolDraft>(() => GOOD_DRAFT);
    const prompter = { promptGate1: async () => ({ decision: "approve" as const, alwaysApprove: false }), promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const out = await factory.createAtomic({ intent: "double ints", rationale: "need it", existingToolsConsidered: [] });
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.tool.manifest.name, "double-int");
    await tracer.close();
    assert.ok(await registry.has("double-int"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("factory: static failure triggers repair loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fac-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onStructured<ToolDraft>(() => ({ ...GOOD_DRAFT, name: "BadName" }))  // invalid name — static fails
      .onStructured<ToolDraft>(() => GOOD_DRAFT);                            // repair returns good draft
    const prompter = { promptGate1: async () => ({ decision: "approve" as const, alwaysApprove: false }), promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const out = await factory.createAtomic({ intent: "x", rationale: "y", existingToolsConsidered: [] });
    assert.equal(out.ok, true);
    assert.equal(llm.calls.structured.length, 2);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("factory: rejected by reviewer returns failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fac-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider().onStructured<ToolDraft>(() => GOOD_DRAFT);
    const prompter = { promptGate1: async () => ({ decision: "reject" as const, reason: "no thanks" }), promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const out = await factory.createAtomic({ intent: "x", rationale: "y", existingToolsConsidered: [] });
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.reason, /no thanks/);
    await tracer.close();
    assert.equal(await registry.has("double-int"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- **Step 4: Run tests (expect pass)**

```bash
npm test -w @meta-agent/core
```

Expected: 3 factory tests pass.

- **Step 5: Commit**

```bash
git add -A
git commit -m "Task 12: ToolFactory (code-gen sub-call → static → smoke → approval → save, with repair loop)"
```

---

## Task 13: Meta-Tools and System Prompt

**Files:**

- Create: `packages/core/src/agent/meta-tools.ts`
- Create: `packages/core/src/agent/system-prompt.ts`
- Create: `packages/core/src/agent/meta-tools.test.ts`
- **Step 1: Create `packages/core/src/agent/meta-tools.ts`**

```ts
import type { ToolDef } from "../llm/interface.ts";

export const META_TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "find_tool",
      description: "Search the tool registry by natural-language query. Returns ranked candidates.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          k: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tools",
      description: "Return the full catalog of tools (name + short description).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "invoke_tool",
      description: "Invoke an existing tool by name with the given args.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          args: {},
        },
        required: ["name", "args"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_new_tool",
      description: "Request authoring of a new atomic tool. Requires at least one prior find_tool call this task.",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string" },
          rationale: { type: "string" },
          existingToolsConsidered: { type: "array", items: { type: "string" }, default: [] },
        },
        required: ["intent", "rationale"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_composite_tool",
      description: "Request authoring of a new composite tool that chains existing tools via invokeTool.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          intent: { type: "string" },
          plannedSteps: {
            type: "array",
            items: {
              type: "object",
              properties: { tool: { type: "string" }, argsTemplate: { type: "string" } },
              required: ["tool", "argsTemplate"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "intent", "plannedSteps"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop",
      description: "Signal that the current task is complete.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
];

export const META_TOOL_NAMES = new Set(META_TOOL_DEFS.map((t) => t.function.name));
```

- **Step 2: Create `packages/core/src/agent/system-prompt.ts`**

```ts
import type { CatalogEntry } from "../types.ts";

export function renderSystemPrompt(opts: { catalog: CatalogEntry[]; maxCatalogShown?: number }): string {
  const max = opts.maxCatalogShown ?? 40;
  const shown = opts.catalog.slice(0, max);
  const list = shown.map((e) => `- ${e.kind === "composite" ? "∘ " : ""}${e.name}: ${e.shortDescription}`).join("\n");
  const elided = opts.catalog.length > max ? `\n(${opts.catalog.length - max} more — use \`find_tool\` to search)` : "";

  return `You are a meta-agent that completes tasks by calling tools.

You have access to these meta-tools (always available):
- find_tool(query, k?): semantic-ish search over the registry
- list_tools(): full catalog
- invoke_tool(name, args): run an existing tool
- propose_new_tool(intent, rationale, ...): author a new atomic tool. Only after you have called find_tool at least once for the current task.
- propose_composite_tool(name, intent, plannedSteps): author a new composite that chains existing tools
- stop(reason?): end the task

Workflow guidance:
1. If a catalog entry below clearly matches, call invoke_tool directly.
2. If nothing in the catalog fits, call find_tool to search deeper.
3. If find_tool returns nothing suitable, propose_new_tool or propose_composite_tool.

## Available tools (${opts.catalog.length})
${list || "(none yet)"}${elided}
`;
}
```

- **Step 3: Write the failing test — `packages/core/src/agent/meta-tools.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { META_TOOL_DEFS, META_TOOL_NAMES } from "./meta-tools.ts";
import { renderSystemPrompt } from "./system-prompt.ts";

test("meta-tool defs are well-formed", () => {
  for (const t of META_TOOL_DEFS) {
    assert.equal(t.type, "function");
    assert.ok(t.function.name);
    assert.ok(t.function.description);
    assert.equal(t.function.parameters.type, "object");
  }
});

test("META_TOOL_NAMES contains all expected names", () => {
  for (const name of ["find_tool", "list_tools", "invoke_tool", "propose_new_tool", "propose_composite_tool", "stop"]) {
    assert.ok(META_TOOL_NAMES.has(name), `missing ${name}`);
  }
});

test("renderSystemPrompt lists catalog entries with composite marker", () => {
  const prompt = renderSystemPrompt({
    catalog: [
      { name: "a", shortDescription: "Does a.", kind: "atomic" },
      { name: "b", shortDescription: "Composes.", kind: "composite" },
    ],
  });
  assert.match(prompt, /- a: Does a\./);
  assert.match(prompt, /- ∘ b: Composes\./);
});

test("renderSystemPrompt elides and hints when over maxCatalogShown", () => {
  const prompt = renderSystemPrompt({
    catalog: Array.from({ length: 50 }, (_, i) => ({ name: `t${i}`, shortDescription: "d", kind: "atomic" as const })),
    maxCatalogShown: 10,
  });
  assert.match(prompt, /\(40 more/);
});
```

- **Step 4: Run tests (expect pass)**

```bash
npm test -w @meta-agent/core
```

Expected: 4 new tests pass.

- **Step 5: Commit**

```bash
git add -A
git commit -m "Task 13: meta-tool definitions + system-prompt renderer"
```

---

## Task 14: Agent Loop

**Files:**

- Create: `packages/core/src/agent/agent-loop.ts`
- Create: `packages/core/src/agent/agent-loop.test.ts`
- Modify: `packages/core/src/index.ts` (export surface)
- **Step 1: Create `packages/core/src/agent/agent-loop.ts`**

```ts
import Ajv from "ajv";
import type { ApprovalPolicy } from "../approval/interface.ts";
import type { LLMProvider, ChatMessage, ToolDef } from "../llm/interface.ts";
import type { Sandbox } from "../sandbox/interface.ts";
import type { ToolRegistry } from "../registry/interface.ts";
import type { ToolIndex } from "../index-store/interface.ts";
import type { ToolResult } from "../types.ts";
import type { Tracer } from "../tracer.ts";
import { renderSystemPrompt } from "./system-prompt.ts";
import { META_TOOL_DEFS, META_TOOL_NAMES } from "./meta-tools.ts";
import { ToolFactory } from "../factory/factory.ts";
import { toolError } from "../errors.ts";

export type ToolInvokedEvent = { name: string; args: unknown; ok: boolean; durationMs: number };

export type AgentLoopOpts = {
  llm: LLMProvider;
  registry: ToolRegistry;
  index: ToolIndex;
  sandbox: Sandbox;
  approval: ApprovalPolicy;
  factory: ToolFactory;
  tracer: Tracer;
  maxTurns?: number;
  onToolInvoked?: (ev: ToolInvokedEvent) => void;
};

type Task = {
  findToolCalled: boolean;
  invokedThisSession: Set<string>;
};

export class AgentLoop {
  private readonly opts: AgentLoopOpts;
  private readonly maxTurns: number;
  private readonly ajv = new Ajv({ strict: false });

  constructor(opts: AgentLoopOpts) {
    this.opts = opts;
    this.maxTurns = opts.maxTurns ?? 20;
  }

  async run(userMessage: string): Promise<string> {
    const task: Task = { findToolCalled: false, invokedThisSession: new Set() };
    const messages: ChatMessage[] = [{ role: "user", content: userMessage }];

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const system = renderSystemPrompt({ catalog: this.makeCatalog() });
      const tools = await this.registeredToolsForTurn(task);
      const resp = await this.opts.llm.chat({
        messages: [{ role: "system", content: system }, ...messages],
        tools,
      });
      this.opts.tracer.log("llm-turn", { turn, usage: resp.usage ?? null });
      messages.push(resp.message);

      if (!resp.message.tool_calls || resp.message.tool_calls.length === 0) {
        if (resp.message.content) return resp.message.content;
        return "(agent returned no content)";
      }

      for (const call of resp.message.tool_calls) {
        const parsedArgs = safeParse(call.function.arguments);
        const result = await this.dispatch(call.function.name, parsedArgs, task, 0);
        this.opts.tracer.log("tool-call", { name: call.function.name, args: parsedArgs, ok: result.ok });
        if (call.function.name === "stop") {
          return (parsedArgs as { reason?: string })?.reason ?? "stopped";
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }
    return `(max turns ${this.maxTurns} reached)`;
  }

  private makeCatalog() {
    return this.opts.registry.listSync().map((s) => ({
      name: s.name,
      shortDescription: firstSentence(s.description, 80),
      kind: s.kind,
    }));
  }

  private async registeredToolsForTurn(task: Task): Promise<ToolDef[]> {
    const defs: ToolDef[] = [...META_TOOL_DEFS];
    for (const name of task.invokedThisSession) {
      const t = await this.opts.registry.get(name);
      if (!t) continue;
      defs.push({
        type: "function",
        function: {
          name: t.manifest.name,
          description: t.manifest.description,
          parameters: t.manifest.inputSchema as Record<string, unknown>,
        },
      });
    }
    return defs;
  }

  private async dispatch(name: string, args: unknown, task: Task, depth: number): Promise<ToolResult> {
    if (META_TOOL_NAMES.has(name)) return this.dispatchMeta(name, args, task, depth);
    return this.dispatchTool(name, args, task, depth);
  }

  private async dispatchMeta(name: string, rawArgs: unknown, task: Task, depth: number): Promise<ToolResult> {
    const args = rawArgs as Record<string, unknown>;
    switch (name) {
      case "find_tool": {
        task.findToolCalled = true;
        const results = await this.opts.index.find(String(args.query ?? ""), { k: Number(args.k ?? 5) });
        return { ok: true, value: results };
      }
      case "list_tools": {
        return { ok: true, value: this.makeCatalog() };
      }
      case "invoke_tool": {
        return this.dispatchTool(String(args.name), args.args, task, depth);
      }
      case "propose_new_tool": {
        if (!task.findToolCalled) return toolError("rejected_by_user", "call find_tool at least once before proposing a new tool");
        const out = await this.opts.factory.createAtomic({
          intent: String(args.intent ?? ""),
          rationale: String(args.rationale ?? ""),
          existingToolsConsidered: (args.existingToolsConsidered as string[] | undefined) ?? [],
        });
        if (!out.ok) return toolError("rejected_by_user", out.reason);
        return { ok: true, value: { name: out.tool.manifest.name, description: out.tool.manifest.description } };
      }
      case "propose_composite_tool": {
        const out = await this.opts.factory.createComposite({
          name: String(args.name ?? ""),
          intent: String(args.intent ?? ""),
          plannedSteps: (args.plannedSteps as Array<{ tool: string; argsTemplate: string }> | undefined) ?? [],
        });
        if (!out.ok) return toolError("rejected_by_user", out.reason);
        return { ok: true, value: { name: out.tool.manifest.name, description: out.tool.manifest.description } };
      }
      case "stop":
        return { ok: true, value: null };
      default:
        return toolError("unknown_tool", `unknown meta-tool '${name}'`);
    }
  }

  private async dispatchTool(name: string, args: unknown, task: Task, depth: number): Promise<ToolResult> {
    const tool = await this.opts.registry.get(name);
    if (!tool) return toolError("unknown_tool", `no tool named '${name}'`);

    const valid = this.ajv.validate(tool.manifest.inputSchema, args);
    if (!valid) return toolError("schema_violation", `input does not match schema: ${this.ajv.errorsText()}`);

    const approval = await this.opts.registry.getApproval(name);
    const decision = await this.opts.approval.checkExecution(tool, args, approval);
    if (decision.decision === "reject") {
      this.opts.tracer.log("execution-denied", { name, reason: decision.reason });
      return toolError("rejected_by_user", decision.reason);
    }

    const started = Date.now();
    const result = await this.opts.sandbox.execute(tool, args, decision.token, {
      depth,
      onInvokeTool: (subName, subArgs) => this.dispatchTool(subName, subArgs, task, depth + 1),
    });
    const durationMs = Date.now() - started;
    this.opts.tracer.log("tool-invoked", { name, duration: durationMs, ok: result.ok });
    this.opts.onToolInvoked?.({ name, args, ok: result.ok, durationMs });
    if (result.ok) task.invokedThisSession.add(name);
    return result;
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}

function firstSentence(desc: string, max: number): string {
  const s = desc.trim().split(/(?<=[.!?])\s/)[0] ?? desc.trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
```

**Notes on the fixes applied above (vs. naive versions):**

- `registeredToolsForTurn` is async and uses the public `registry.get()` — no reaching into private caches.
- `depth` is threaded from the top-level `run` into every `dispatchTool`, and incremented when `onInvokeTool` recurses, so the sandbox's `maxDepth` check is meaningful for composite recursion initiated from the agent.
- `onToolInvoked` callback lets external observers (e.g., the CLI's `/compose` tracker) see tool invocations without wrapping the `Tracer` class.
- **Step 2: Update `packages/core/src/index.ts` to export the public surface**

```ts
export const version = "0.1.0";
export * from "./types.ts";
export * from "./schemas.ts";
export * from "./hash.ts";
export * from "./errors.ts";
export { Tracer } from "./tracer.ts";
export type { ToolRegistry } from "./registry/interface.ts";
export { FsToolRegistry } from "./registry/fs-registry.ts";
export type { ToolIndex } from "./index-store/interface.ts";
export { HybridToolIndex } from "./index-store/hybrid-index.ts";
export type { ApprovalPolicy, ApprovalPrompter, Gate1Decision, ExecutionDecision, RiskTier } from "./approval/interface.ts";
export { TieredApprovalPolicy, riskTier } from "./approval/tiered-policy.ts";
export type { LLMProvider, ChatRequest, ChatResponse, ChatMessage, ToolDef, ToolCall, StructuredRequest } from "./llm/interface.ts";
export { OpenAIProvider } from "./llm/openai-provider.ts";
export { MockLLMProvider } from "./llm/mock-provider.ts";
export type { Sandbox, InvokeToolHandler, ExecuteOpts } from "./sandbox/interface.ts";
export { NodePermissionSandbox } from "./sandbox/node-permission-sandbox.ts";
export { staticValidateDraft, extractImports, extractInvokeToolCalls } from "./factory/static-validator.ts";
export { ToolFactory } from "./factory/factory.ts";
export { META_TOOL_DEFS, META_TOOL_NAMES } from "./agent/meta-tools.ts";
export { renderSystemPrompt } from "./agent/system-prompt.ts";
export { AgentLoop } from "./agent/agent-loop.ts";
```

- **Step 3: Write the failing test — `packages/core/src/agent/agent-loop.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./agent-loop.ts";
import { MockLLMProvider } from "../llm/mock-provider.ts";
import { FsToolRegistry } from "../registry/fs-registry.ts";
import { HybridToolIndex } from "../index-store/hybrid-index.ts";
import { NodePermissionSandbox } from "../sandbox/node-permission-sandbox.ts";
import { TieredApprovalPolicy } from "../approval/tiered-policy.ts";
import { Tracer } from "../tracer.ts";
import { ToolFactory } from "../factory/factory.ts";
import type { ChatResponse } from "../llm/interface.ts";

function asst(content: string | null, toolCalls?: Array<{ id: string; name: string; args: unknown }>): ChatResponse {
  return {
    message: {
      role: "assistant",
      content,
      ...(toolCalls
        ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
        : {}),
    },
  };
}

test("agent: plain chat turn returns content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider().onChat(() => asst("hello!"));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("hi");
    assert.equal(out, "hello!");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: find_tool then stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "1", name: "find_tool", args: { query: "doesn't matter" } }]))
      .onChat(() => asst(null, [{ id: "2", name: "stop", args: { reason: "done" } }]));
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("search something");
    assert.equal(out, "done");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent: propose_new_tool requires find_tool first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "1", name: "propose_new_tool", args: { intent: "i", rationale: "r" } }]))
      .onChat(() => asst("I was told to find first."));
    const prompter = { promptGate1: async () => { throw new Error("no prompt expected"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("do it");
    assert.match(out, /find first/);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- **Step 4: Run tests (expect pass)**

```bash
npm test -w @meta-agent/core
```

Expected: 3 new agent-loop tests pass.

- **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- **Step 6: Commit**

```bash
git add -A
git commit -m "Task 14: AgentLoop with meta-tool dispatch + registry-backed tool calls + composite recursion"
```

---

## Task 15: CLI Config Loader and Approval TUI

**Files:**

- Create: `packages/cli/src/config.ts`
- Create: `packages/cli/src/approval-tui.ts`
- Create: `packages/cli/src/config.test.ts`
- Create: `config/meta-agent.example.json`
- **Step 1: Create `config/meta-agent.example.json`**

```json
{
  "$schema": "./meta-agent.schema.json",
  "llm": {
    "baseURL": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "workspace": "./workspace",
  "toolsDir": "./tools",
  "tracesDir": "./traces",
  "yolo": false,
  "maxTurns": 20,
  "sandbox": {
    "maxDepth": 8,
    "maxOutputBytes": 1048576
  }
}
```

- **Step 2: Create `packages/cli/src/config.ts`**

```ts
import { readFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";

export type Config = {
  llm: { baseURL?: string; model: string; apiKeyEnv: string };
  workspace: string;
  toolsDir: string;
  tracesDir: string;
  yolo: boolean;
  maxTurns: number;
  sandbox: { maxDepth: number; maxOutputBytes: number };
};

export async function loadConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<Config>;
  const base = dirname(path);

  const llm = parsed.llm ?? { model: "gpt-4o-mini", apiKeyEnv: "OPENAI_API_KEY" };
  if (!llm.model) throw new Error("config.llm.model is required");
  if (!llm.apiKeyEnv) throw new Error("config.llm.apiKeyEnv is required");

  return {
    llm,
    workspace: abs(parsed.workspace ?? "./workspace", base),
    toolsDir: abs(parsed.toolsDir ?? "./tools", base),
    tracesDir: abs(parsed.tracesDir ?? "./traces", base),
    yolo: parsed.yolo ?? false,
    maxTurns: parsed.maxTurns ?? 20,
    sandbox: { maxDepth: parsed.sandbox?.maxDepth ?? 8, maxOutputBytes: parsed.sandbox?.maxOutputBytes ?? 1_048_576 },
  };
}

function abs(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}
```

- **Step 3: Create `packages/cli/src/approval-tui.ts`**

```ts
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ApprovalPrompter, ExecutionDecision, Gate1Decision, RiskTier } from "@meta-agent/core";
import type { Tool, ToolDraft, ToolResult } from "@meta-agent/core";

export class CliApprovalPrompter implements ApprovalPrompter {
  async promptGate1(draft: ToolDraft, smokeTest: ToolResult): Promise<Gate1Decision> {
    const rl = readline.createInterface({ input, output });
    try {
      console.log("\n=== GATE 1: Review new tool ===");
      console.log(`Name:         ${draft.name}`);
      console.log(`Kind:         ${draft.kind}`);
      console.log(`Description:  ${draft.description}`);
      console.log(`Rationale:    ${draft.rationale}`);
      console.log("Input schema: " + JSON.stringify(draft.inputSchema));
      console.log("Output shape: " + JSON.stringify(draft.outputShape));
      console.log("Permissions:");
      console.log(`  fsRead:       [${draft.permissions.fsRead.join(", ")}]`);
      console.log(`  fsWrite:      [${draft.permissions.fsWrite.join(", ")}]`);
      console.log(`  net:          ${draft.permissions.net}`);
      console.log(`  netAllowlist: [${draft.permissions.netAllowlist.join(", ")}]`);
      console.log(`  env:          [${draft.permissions.env.join(", ")}]`);
      if (draft.dependencies.length) console.log(`Dependencies: ${draft.dependencies.join(", ")}`);
      console.log("\n--- CODE ---");
      console.log(draft.code);
      console.log("--- /CODE ---");
      console.log("\nSmoke test input:  " + JSON.stringify(draft.smokeTestInput));
      console.log("Smoke test result: " + JSON.stringify(smokeTest));

      const answer = (await rl.question("\n[a]pprove / [A]lways-approve / [r]eject? ")).trim();
      if (answer === "r" || answer === "R" || answer === "reject") {
        const reason = (await rl.question("Reason: ")).trim() || "rejected";
        return { decision: "reject", reason };
      }
      const always = answer === "A" || answer === "always-approve";
      return { decision: "approve", alwaysApprove: always };
    } finally {
      rl.close();
    }
  }

  async promptGate23(tool: Tool, args: unknown, tier: RiskTier): Promise<ExecutionDecision> {
    const rl = readline.createInterface({ input, output });
    try {
      console.log(`\n=== GATE 2/3: ${tool.manifest.name} (risk: ${tier}) ===`);
      console.log(`Args: ${JSON.stringify(args)}`);
      console.log(`Permissions: ${JSON.stringify(tool.manifest.permissions)}`);
      const answer = (await rl.question("[a]pprove-once / [s]ession-approve / [r]eject? ")).trim();
      if (answer === "r" || answer === "R") return { decision: "reject", reason: "user rejected" };
      const cache = answer === "s" || answer === "S";
      return { decision: "approve", token: Math.random().toString(36).slice(2), cacheForSession: cache };
    } finally {
      rl.close();
    }
  }
}
```

- **Step 4: Write the failing test — `packages/cli/src/config.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

test("loadConfig resolves relative paths against config dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfg-"));
  try {
    await writeFile(join(dir, "c.json"), JSON.stringify({
      llm: { model: "m", apiKeyEnv: "K" },
      workspace: "./w",
    }));
    const c = await loadConfig(join(dir, "c.json"));
    assert.equal(c.workspace, join(dir, "w"));
    assert.equal(c.llm.model, "m");
    assert.equal(c.yolo, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig fails on missing llm.model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfg-"));
  try {
    await writeFile(join(dir, "c.json"), JSON.stringify({ llm: { apiKeyEnv: "K" } }));
    await assert.rejects(loadConfig(join(dir, "c.json")), /llm\.model/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- **Step 5: Run tests (expect pass)**

```bash
npm test -w @meta-agent/cli
```

Expected: 2 config tests pass.

- **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- **Step 7: Commit**

```bash
git add -A
git commit -m "Task 15: CLI config loader + approval TUI prompter"
```

---

## Task 16: CLI REPL, /compose, and Bin Entry

**Files:**

- Create: `packages/cli/src/compose.ts`
- Create: `packages/cli/src/repl.ts`
- Modify: `packages/cli/src/bin.ts`
- **Step 1: Create `packages/cli/src/compose.ts`**

Minimal reactive-compose CLI path. Tracks tool invocations during a session and, on `/compose`, prompts the user to describe a new composite and hands off to the factory.

```ts
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ToolFactory } from "@meta-agent/core";

export type InvocationRecord = { name: string; args: unknown; ok: boolean };

export async function runComposeInteraction(
  factory: ToolFactory,
  invocations: InvocationRecord[],
): Promise<void> {
  if (invocations.length === 0) {
    console.log("(no tool invocations in this session)");
    return;
  }
  console.log("\nTool calls in this session:");
  invocations.forEach((inv, i) => {
    console.log(`  [${i + 1}] ${inv.name}(${JSON.stringify(inv.args)}) → ${inv.ok ? "ok" : "err"}`);
  });
  const rl = readline.createInterface({ input, output });
  try {
    const range = (await rl.question("Select a contiguous slice as 'a-b' (or blank to cancel): ")).trim();
    if (!range) return;
    const m = /^(\d+)-(\d+)$/.exec(range);
    if (!m) { console.log("invalid range"); return; }
    const a = parseInt(m[1]!, 10), b = parseInt(m[2]!, 10);
    if (a < 1 || b > invocations.length || a > b) { console.log("out of bounds"); return; }
    const slice = invocations.slice(a - 1, b);
    const name = (await rl.question("Name for the new composite: ")).trim();
    if (!name) { console.log("cancelled"); return; }
    const intent = (await rl.question("Intent (1-2 sentences): ")).trim();
    const sliceDescription = slice.map((s, i) => `${i + 1}. ${s.name}(${JSON.stringify(s.args)})`).join("\n");
    const out = await factory.createReactive({ name, intent, sliceDescription });
    console.log(out.ok ? `created composite '${out.tool.manifest.name}'` : `rejected: ${out.reason}`);
  } finally {
    rl.close();
  }
}
```

- **Step 2: Create `packages/cli/src/repl.ts`**

```ts
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  AgentLoop, FsToolRegistry, HybridToolIndex, NodePermissionSandbox,
  OpenAIProvider, TieredApprovalPolicy, ToolFactory, Tracer,
} from "@meta-agent/core";
import { mkdir } from "node:fs/promises";
import { CliApprovalPrompter } from "./approval-tui.ts";
import { runComposeInteraction, type InvocationRecord } from "./compose.ts";
import type { Config } from "./config.ts";

export async function runRepl(config: Config): Promise<void> {
  const apiKey = process.env[config.llm.apiKeyEnv];
  if (!apiKey) throw new Error(`API key env var ${config.llm.apiKeyEnv} is not set`);

  await mkdir(config.workspace, { recursive: true });
  await mkdir(config.toolsDir, { recursive: true });
  await mkdir(config.tracesDir, { recursive: true });

  const registry = await FsToolRegistry.open(config.toolsDir);
  const index = await HybridToolIndex.open(registry);
  const sandbox = new NodePermissionSandbox({
    workspace: config.workspace,
    maxDepth: config.sandbox.maxDepth,
    maxOutputBytes: config.sandbox.maxOutputBytes,
  });
  const prompter = new CliApprovalPrompter();
  const approval = new TieredApprovalPolicy(prompter, { workspace: config.workspace, yolo: config.yolo });
  const llm = new OpenAIProvider({
    apiKey,
    ...(config.llm.baseURL !== undefined ? { baseURL: config.llm.baseURL } : {}),
    model: config.llm.model,
  });

  const sessionId = Date.now().toString(36);
  const tracer = await Tracer.open(config.tracesDir, sessionId);
  const invocations: InvocationRecord[] = [];

  const factory = new ToolFactory({
    llm, registry, sandbox, approval, tracer, tombstoned: new Set(),
  });
  const agent = new AgentLoop({
    llm, registry, index, sandbox, approval, factory, tracer,
    maxTurns: config.maxTurns,
    onToolInvoked: (ev) => invocations.push({ name: ev.name, args: ev.args, ok: ev.ok }),
  });

  const rl = readline.createInterface({ input, output });
  console.log("meta-agent REPL. Commands: /compose, /tools, /exit. Any other line = task for the agent.\n");
  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) continue;
      if (line === "/exit") break;
      if (line === "/tools") { console.log(JSON.stringify(registry.listSync(), null, 2)); continue; }
      if (line === "/compose") { await runComposeInteraction(factory, invocations); continue; }
      const out = await agent.run(line);
      console.log(out);
    }
  } finally {
    rl.close();
    await tracer.close();
  }
}
```

- **Step 3: Replace `packages/cli/src/bin.ts`**

```ts
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { runRepl } from "./repl.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c", default: "./config/meta-agent.json" },
      yolo:   { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const cfg = await loadConfig(resolve(values.config!));
  if (values.yolo) cfg.yolo = true;
  await runRepl(cfg);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- **Step 5: Smoke-run the bin (with yolo and a mock model, no real API call)**

This step is a manual sanity check; we do not assert specific output. Create a minimal config and start the REPL, type `/tools` to confirm it lists nothing, then `/exit`.

```bash
mkdir -p config workspace tools traces
cp packages/cli/../../config/meta-agent.example.json config/meta-agent.json || cp config/meta-agent.example.json config/meta-agent.json
OPENAI_API_KEY=unused-for-this-smoke node --experimental-transform-types --no-warnings packages/cli/src/bin.ts --yolo --config ./config/meta-agent.json <<EOF
/tools
/exit
EOF
```

Expected: you see `[]` printed after `/tools` and the REPL exits. If the OpenAI SDK complains about a bad key before we issue any request, that's fine — we haven't called it.

- **Step 6: Commit**

```bash
git add -A
git commit -m "Task 16: CLI REPL, /compose handler, and bin entry with config loading"
```

---

## Task 17: End-to-End Smoke Test with Mocked LLM

This task verifies the entire pipeline: tool creation through the factory, execution through the sandbox, and composite orchestration — all with a fully mocked LLM, so no network or API key is required in CI.

**Files:**

- Create: `packages/core/src/e2e.test.ts`
- **Step 1: Write the failing test — `packages/core/src/e2e.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentLoop, FsToolRegistry, HybridToolIndex, NodePermissionSandbox,
  TieredApprovalPolicy, ToolFactory, Tracer, MockLLMProvider,
} from "./index.ts";
import type { ChatResponse, ToolDraft } from "./index.ts";

function asst(content: string | null, calls: Array<{ id: string; name: string; args: unknown }> = []): ChatResponse {
  return {
    message: {
      role: "assistant",
      content,
      ...(calls.length
        ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
        : {}),
    },
  };
}

const DOUBLE_DRAFT: ToolDraft = {
  name: "double-int",
  description: "Doubles an integer.",
  rationale: "Testing atomic tool creation.",
  inputSchema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false },
  outputShape: { type: "object", properties: { doubled: { type: "integer" } }, required: ["doubled"], additionalProperties: false },
  permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  code: "export async function run(i){return {doubled: i.x*2};}",
  dependencies: [],
  smokeTestInput: { x: 3 },
  kind: "atomic",
};

const PLUS_ONE_THEN_DOUBLE_DRAFT: ToolDraft = {
  name: "plus-one-then-double",
  description: "Adds 1 to the input then doubles it via double-int.",
  rationale: "Reactive composite example.",
  inputSchema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false },
  outputShape: { type: "object", properties: { doubled: { type: "integer" } }, required: ["doubled"], additionalProperties: false },
  permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  code: `export async function run(i){
  const r = await invokeTool("double-int", { x: i.x + 1 });
  if (!r.ok) throw new Error("inner failed");
  return r.value;
}`,
  dependencies: ["double-int"],
  smokeTestInput: { x: 4 },
  kind: "composite",
};

test("E2E: agent finds-nothing, proposes tool, then invokes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider();

    llm
      .onChat(() => asst(null, [{ id: "1", name: "find_tool", args: { query: "double integer" } }]))
      .onChat(() => asst(null, [{ id: "2", name: "propose_new_tool", args: { intent: "double an integer", rationale: "user asked" } }]))
      .onStructured<ToolDraft>(() => DOUBLE_DRAFT)
      .onChat(() => asst(null, [{ id: "3", name: "invoke_tool", args: { name: "double-int", args: { x: 7 } } }]))
      .onChat(() => asst("result: 14"));

    const prompter = { promptGate1: async () => ({ decision: "approve" as const, alwaysApprove: true }), promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir, yolo: false });
    const tracer = await Tracer.open(join(dir, "traces"), "e2e");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });
    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });

    const out = await loop.run("please double 7");
    assert.match(out, /14/);
    assert.ok(await registry.has("double-int"));
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("E2E: composite invokeTool runs with no ambient authority (depth 1 inner call)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const llm = new MockLLMProvider();

    llm
      .onStructured<ToolDraft>(() => DOUBLE_DRAFT)
      .onStructured<ToolDraft>(() => PLUS_ONE_THEN_DOUBLE_DRAFT);

    const prompter = { promptGate1: async () => ({ decision: "approve" as const, alwaysApprove: true }), promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir, yolo: false });
    const tracer = await Tracer.open(join(dir, "traces"), "e2e2");
    const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });

    const a = await factory.createAtomic({ intent: "double", rationale: "base", existingToolsConsidered: [] });
    assert.equal(a.ok, true);
    const c = await factory.createComposite({ name: "plus-one-then-double", intent: "+1 then double", plannedSteps: [{ tool: "double-int", argsTemplate: "{x+1}" }] });
    assert.equal(c.ok, true);

    // Now exercise the composite directly through a fresh agent-driven path to ensure invokeTool recursion works.
    llm
      .onChat(() => asst(null, [{ id: "x", name: "invoke_tool", args: { name: "plus-one-then-double", args: { x: 10 } } }]))
      .onChat(() => asst("22"));

    const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
    const out = await loop.run("compute");
    assert.match(out, /22/);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- **Step 2: Run tests (expect pass)**

```bash
npm test -w @meta-agent/core
```

Expected: 2 E2E tests pass. Because they spawn real subprocesses, they will be slower than the unit tests.

- **Step 3: Run the full test suite across workspaces**

```bash
npm test
npm run typecheck
```

Expected: all tests pass, no type errors.

- **Step 4: Commit**

```bash
git add -A
git commit -m "Task 17: E2E tests — agent creates tool, invokes it, composite recursion"
```

---

## Post-Implementation: README

After all 17 tasks are complete, write a minimal README at the repo root describing:

- Prerequisites (Node ≥ 22.6, OpenAI-compatible API key).
- Setup (`npm install`, copy example config, export API key env var).
- Running the REPL (`npm run cli`).
- Example interactions (ask the agent to do something simple; `/tools`, `/compose`, `/exit`).
- Pointers to `docs/meta-tool-design.md` for architecture.

This is NOT a TDD task; the README is documentation. It can be a separate commit: `docs: add root README with setup and usage`.

---

## Self-Review Checklist

Before handing this plan off for execution, verify:

**Spec coverage (each spec section → which task covers it):**

- Goals & non-goals (spec §1): covered by the overall architecture in Tasks 1–17; non-goals explicitly not implemented.
- Deliverable form (spec §2): Task 1 sets up monorepo with `core` ↔ `cli` separation.
- Architecture overview (spec §3): Tasks 5–14 implement the five components and AgentLoop; Task 16 wires cli.
- Tool creation flow (spec §4): Task 12 (factory). Gate 1 prompt in Task 15.
- Execution flow (spec §5): Task 10 (sandbox + `invokeTool` JSON-RPC), Task 7 (approval), Task 14 (dispatch with no-ambient-authority via `onInvokeTool`).
- Registry & lookup (spec §6): Tasks 5 (registry), 6 (hybrid index).
- Composition (spec §7): Task 12 (`createComposite`, `createReactive`); Task 11 (declared-deps-match-calls); Task 10 (depth cap, no ambient authority).
- Agent loop & prompting (spec §8): Tasks 13 (meta-tools + system prompt), 14 (loop + OpenAI SDK via provider).
- Data shapes (spec §9): Tasks 2, 4, 5 establish on-disk and trace-event shapes.
- Validation & error handling (spec §10): Tasks 11 (static), 12 (smoke test + repair), 14 (schema validation at dispatch, structured `ToolResult` everywhere).
- Decisions (spec §11): no direct task — they drove the chosen implementations.
- Future extensions (spec §12): explicitly deferred.
- Open questions (spec §13): POC defaults adopted.

**Type consistency check:**

- `ToolDraft`, `ToolManifest`, `ApprovalRecord`, `ToolResult`, `CatalogEntry`, `FindResult`, `ToolSummary` are defined once in Task 2 and referenced throughout.
- `ToolRegistry` interface gets `listSync` added in Task 6 and is honored by `FsToolRegistry` and the test stub.
- `ApprovalPrompter.promptGate1`/`promptGate23` signatures match `CliApprovalPrompter` in Task 15.
- `InvokeToolHandler` type from Task 10 matches `onInvokeTool` usage in Task 14 (`async (name, args) => dispatchTool(name, args, task)`).
- `LLMProvider.generateStructured` signature matches usage in `ToolFactory` (Task 12) and `MockLLMProvider` (Task 8).

