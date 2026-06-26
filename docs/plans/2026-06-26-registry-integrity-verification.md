# Registry Integrity Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tool registry verify tool content/approval hashes at the persistence boundary so the system can never execute code that was never approved under its recorded hash (design review issue H1).

**Architecture:** A standalone, I/O-free integrity module (`registry/integrity.ts`) computes a per-tool status (`ok` / `needs_review` / `quarantined`) from raw body bytes + manifest + approval. `FsToolRegistry` calls it on load (quarantine tampered tools, mark unbound-approval tools as needs-review, record + log every issue) and on save (throw before writing an inconsistent entry). `TieredApprovalPolicy` is tightened so a tool with no binding approval can never be silently executed. The CLI prints any integrity issues at startup.

**Tech Stack:** TypeScript run directly on Node ≥25 (`--experimental-transform-types`), `node:test`/`node:assert`, `node:crypto` (existing `hashTool`). No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-06-26-registry-integrity-verification-design.md`](../specs/2026-06-26-registry-integrity-verification-design.md)

---

## File Structure

**New files:**
- `packages/core/src/registry/integrity.ts` — pure verification core: `INTEGRITY_STATUS`, `IntegrityStatus`, `IntegrityResult`, `IntegrityIssue`, `INTEGRITY_REASON`, `verifyToolIntegrity`, `RegistryIntegrityError`. Depends only on `hash.ts` + `types.ts`.
- `packages/core/src/registry/integrity.test.ts` — unit tests for `verifyToolIntegrity`.
- `packages/core/src/testing/tool-fixtures.ts` — shared test helpers `makeConsistentTool` / `makeConsistentApproval` (compute a real hash so saved/reloaded fixtures pass verification).
- `packages/core/src/testing/tool-fixtures.test.ts` — sanity test that the helper produces `ok` tools.
- `packages/cli/src/integrity-format.ts` — pure `formatIntegrityIssues(issues)` renderer for startup output.
- `packages/cli/src/integrity-format.test.ts` — unit tests for the renderer.

**Modified files:**
- `packages/core/src/registry/fs-registry.ts` — verify on load + save; track + expose `integrityReport()`.
- `packages/core/src/registry/fs-registry.test.ts` — migrate fixtures; add quarantine / needs-review / save-throw tests.
- `packages/core/src/approval/tiered-policy.ts` — null-approval always prompts.
- `packages/core/src/approval/tiered-policy.test.ts` — add null-approval-prompts tests.
- `packages/core/src/index.ts` — export the integrity module symbols.
- `packages/cli/src/repl.ts` — print integrity issues at startup.
- Test fixtures across the suite that `save` placeholder hashes (migrated in Task 3).
- `docs/meta-tool-design.md`, `docs/repo_structure.md` — documentation.

**Note on commits:** Each task ends with a commit step (frequent commits). These run *during execution*; do not commit before execution begins.

---

## Task 1: Standalone integrity module

**Files:**
- Create: `packages/core/src/registry/integrity.ts`
- Test: `packages/core/src/registry/integrity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/registry/integrity.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTool } from "../hash.ts";
import type { ApprovalRecord, ToolManifest } from "../types.ts";
import { INTEGRITY_STATUS, RegistryIntegrityError, verifyToolIntegrity } from "./integrity.ts";

const BODY = "export async function run(i){return i;}";

function manifestFor(body: string): ToolManifest {
  const sansHash: Omit<ToolManifest, "hash"> = {
    name: "t",
    description: "d",
    rationale: "r",
    inputSchema: { type: "object" },
    outputShape: { type: "object" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "atomic",
  };
  return { ...sansHash, hash: hashTool(body, sansHash) };
}

function approvalFor(manifest: ToolManifest): ApprovalRecord {
  return { hash: manifest.hash, approvedAt: "x", approvedBy: "u", alwaysApprove: false };
}

test("verifyToolIntegrity: consistent tool+approval => ok", () => {
  const m = manifestFor(BODY);
  assert.equal(verifyToolIntegrity(BODY, m, approvalFor(m)).status, INTEGRITY_STATUS.ok);
});

test("verifyToolIntegrity: edited body (manifest hash mismatch) => quarantined", () => {
  const m = manifestFor(BODY);
  const r = verifyToolIntegrity(BODY + " // tampered", m, approvalFor(m));
  assert.equal(r.status, INTEGRITY_STATUS.quarantined);
});

test("verifyToolIntegrity: missing approval => needs_review", () => {
  const m = manifestFor(BODY);
  assert.equal(verifyToolIntegrity(BODY, m, null).status, INTEGRITY_STATUS.needsReview);
});

test("verifyToolIntegrity: approval hash != manifest hash => needs_review", () => {
  const m = manifestFor(BODY);
  const stale: ApprovalRecord = { hash: "sha256:" + "b".repeat(64), approvedAt: "x", approvedBy: "u", alwaysApprove: true };
  assert.equal(verifyToolIntegrity(BODY, m, stale).status, INTEGRITY_STATUS.needsReview);
});

test("verifyToolIntegrity: works for workflow JSON bodies", () => {
  const workflowBody = JSON.stringify({ version: 1, steps: [] }, null, 2);
  const m = manifestFor(workflowBody);
  assert.equal(verifyToolIntegrity(workflowBody, m, approvalFor(m)).status, INTEGRITY_STATUS.ok);
});

test("RegistryIntegrityError carries status and tool name", () => {
  const err = new RegistryIntegrityError("foo", { status: INTEGRITY_STATUS.quarantined, reason: "bad" });
  assert.equal(err.status, INTEGRITY_STATUS.quarantined);
  assert.equal(err.toolName, "foo");
  assert.match(err.message, /foo/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-transform-types --no-warnings packages/core/src/registry/integrity.test.ts`
Expected: FAIL — cannot find module `./integrity.ts`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/registry/integrity.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-transform-types --no-warnings packages/core/src/registry/integrity.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Export from the package index**

In `packages/core/src/index.ts`, after line 15 (`export { FsToolRegistry } ...`), add:

```ts
export {
  INTEGRITY_STATUS,
  INTEGRITY_REASON,
  RegistryIntegrityError,
  verifyToolIntegrity,
} from "./registry/integrity.ts";
export type { IntegrityStatus, IntegrityResult, IntegrityIssue } from "./registry/integrity.ts";
```

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add packages/core/src/registry/integrity.ts packages/core/src/registry/integrity.test.ts packages/core/src/index.ts
git commit -m "feat(registry): add standalone tool integrity verification module"
```

---

## Task 2: Shared test fixture helper

**Files:**
- Create: `packages/core/src/testing/tool-fixtures.ts`
- Test: `packages/core/src/testing/tool-fixtures.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/testing/tool-fixtures.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { INTEGRITY_STATUS, verifyToolIntegrity } from "../registry/integrity.ts";
import { makeConsistentApproval, makeConsistentTool } from "./tool-fixtures.ts";

const SANS_HASH = {
  name: "alpha",
  description: "d",
  rationale: "r",
  inputSchema: { type: "object" as const },
  outputShape: { type: "object" as const },
  permissions: { fsRead: [], fsWrite: [], net: "none" as const, netAllowlist: [], env: [] },
  dependencies: [] as string[],
  limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
  createdAt: "2026-01-01T00:00:00.000Z",
  kind: "atomic" as const,
};

test("makeConsistentTool + makeConsistentApproval produce an ok tool", () => {
  const tool = makeConsistentTool(SANS_HASH, "export async function run(i){return i;}");
  const approval = makeConsistentApproval(tool);
  assert.equal(verifyToolIntegrity(tool.code, tool.manifest, approval).status, INTEGRITY_STATUS.ok);
  assert.equal(approval.hash, tool.manifest.hash);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-transform-types --no-warnings packages/core/src/testing/tool-fixtures.test.ts`
Expected: FAIL — cannot find module `./tool-fixtures.ts`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/testing/tool-fixtures.ts`:

```ts
import { hashTool } from "../hash.ts";
import type { ApprovalRecord, Tool, ToolManifest } from "../types.ts";

/**
 * Builds a self-consistent {@link Tool} (manifest.hash == hashTool(body, manifestSansHash)).
 * For workflow tools pass the serialized workflow JSON as `body`.
 */
export function makeConsistentTool(manifestSansHash: Omit<ToolManifest, "hash">, body: string): Tool {
  const hash = hashTool(body, manifestSansHash);
  return { manifest: { ...manifestSansHash, hash }, code: body };
}

/** Builds an {@link ApprovalRecord} bound to `tool` (approval.hash == tool.manifest.hash). */
export function makeConsistentApproval(tool: Tool, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    hash: tool.manifest.hash,
    approvedAt: "2026-01-01T00:00:00.000Z",
    approvedBy: "test",
    alwaysApprove: false,
    ...overrides,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-transform-types --no-warnings packages/core/src/testing/tool-fixtures.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/testing/tool-fixtures.ts packages/core/src/testing/tool-fixtures.test.ts
git commit -m "test(core): add self-consistent tool/approval fixture helpers"
```

---

## Task 3: Migrate existing fixtures to consistent hashes (before enforcement)

This task is behavior-neutral (the registry does not verify yet), so the full suite must stay green throughout. Doing it before Tasks 4–6 means enforcement won't break existing tests.

**Files (modify):** every test that `save`s a tool with a placeholder hash, or reopens a populated registry. Known offenders:
- `packages/core/src/registry/fs-registry.test.ts`
- `packages/core/src/factory/factory.test.ts`
- `packages/core/src/agent/agent-loop.test.ts`
- `packages/core/src/workflow/e2e-lift.test.ts`
- `packages/core/src/e2e.test.ts`
- `packages/core/src/agent/reference-flow.test.ts`
- `packages/core/src/workflow/reference-lift.e2e.test.ts`
- `packages/core/src/workflow/llm-step.e2e.test.ts`

- [ ] **Step 1: Enumerate every placeholder-hash fixture and save site**

Run: `node --test` is not needed here; instead inventory the offenders.
Use Grep (not shell) for: pattern `hash: "sha256:` (type `ts`, glob `**/*.test.ts`) and pattern `\.save\(` (glob `**/*.test.ts`).
Expected: a list of fixtures whose `hash` is a placeholder (e.g. `"sha256:" + "a".repeat(64)`, `"sha256:double"`, `"sha256:approval"`, `"sha256:test-hash"`) and the tests that persist them.

- [ ] **Step 2: Canonical transformation (apply to each offender)**

Replace inline tool literals + placeholder hashes with `makeConsistentTool`, and approvals with `makeConsistentApproval`.

Example — `packages/core/src/registry/fs-registry.test.ts`. Replace the `sample()` factory and `approval` constant:

```ts
import { makeConsistentApproval, makeConsistentTool } from "../testing/tool-fixtures.ts";

const sample = (name: string, deps: string[] = []) =>
  makeConsistentTool(
    {
      name,
      description: `desc of ${name}`,
      rationale: "r",
      inputSchema: { type: "object" },
      outputShape: { type: "object" },
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: deps,
      limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
      createdAt: "2026-04-21T00:00:00Z",
      kind: deps.length ? "composite" : "atomic",
    },
    "export async function run(i){return i;}",
  );
```

Then change `save` calls that used the shared `approval` constant to bind per-tool, e.g.:

```ts
const t = sample("alpha");
await reg.save(t, makeConsistentApproval(t));
```

Apply the same shape everywhere a tool is saved: build the tool via `makeConsistentTool(manifestSansHash, body)`, then save with `makeConsistentApproval(tool, { alwaysApprove: true })` where the old fixture set `alwaysApprove: true`.

For the **workflow tool** in `packages/core/src/workflow/e2e-lift.test.ts` (the block currently doing `manifest: { ...manifest, hash: "" }` then `workflowTool.manifest.hash = "sha256:" + "test-hash"`), replace with:

```ts
const workflowBody = JSON.stringify(workflow, null, 2);
const { hash: _drop, ...manifestSansHash } = manifest;
const workflowTool = makeConsistentTool(manifestSansHash, workflowBody);
await registry.save(workflowTool, makeConsistentApproval(workflowTool));
```

- [ ] **Step 3: Run the full core suite after each file**

Run: `npm test -w @meta-agent/core`
Expected: PASS (same set of tests as before this task; behavior unchanged).

- [ ] **Step 4: Confirm no placeholder hashes remain in persisted-tool tests**

Use Grep for `hash: "sha256:` in `**/*.test.ts`. Remaining matches are allowed ONLY in tests that never call `registry.save`/reopen (e.g. `approval/tiered-policy.test.ts`, which calls the policy directly). Verify each remaining match is in such a test.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add packages/core/src
git commit -m "test(core): build self-consistent tool fixtures via helper"
```

---

## Task 4: Verify on load (quarantine / needs-review + integrityReport)

**Files:**
- Modify: `packages/core/src/registry/fs-registry.ts`
- Test: `packages/core/src/registry/fs-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/registry/fs-registry.test.ts` (add imports at top: `import { writeFile } from "node:fs/promises";`, `import { join } from "node:path";`, `import { INTEGRITY_STATUS } from "./integrity.ts";`, plus the fixture helpers if not already imported):

```ts
test("load quarantines a tool whose code was edited after approval", async () => {
  const dir = await tmp();
  try {
    let reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    await reg.save(t, makeConsistentApproval(t));
    // Tamper with the body on disk, leaving manifest.json/approval.json intact.
    await writeFile(join(dir, "alpha", "tool.ts"), "export async function run(i){return 'evil';}", "utf8");
    reg = await FsToolRegistry.open(dir);
    assert.equal(await reg.get("alpha"), null);
    assert.equal((await reg.list()).length, 0);
    const report = reg.integrityReport();
    assert.equal(report.length, 1);
    assert.equal(report[0].name, "alpha");
    assert.equal(report[0].status, INTEGRITY_STATUS.quarantined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load marks needs-review when approval hash no longer matches manifest", async () => {
  const dir = await tmp();
  try {
    let reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    await reg.save(t, makeConsistentApproval(t));
    // Replace approval.json with a stale (non-matching) hash; body+manifest stay consistent.
    const stale = { hash: "sha256:" + "c".repeat(64), approvedAt: "x", approvedBy: "u", alwaysApprove: true };
    await writeFile(join(dir, "alpha", "approval.json"), JSON.stringify(stale, null, 2), "utf8");
    reg = await FsToolRegistry.open(dir);
    assert.ok(await reg.get("alpha")); // still discoverable
    assert.equal(await reg.getApproval("alpha"), null); // approval not bound
    const report = reg.integrityReport();
    assert.equal(report.length, 1);
    assert.equal(report[0].status, INTEGRITY_STATUS.needsReview);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load logs a warning for each integrity issue", async () => {
  const dir = await tmp();
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    captured += s;
    return true;
  };
  try {
    let reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    await reg.save(t, makeConsistentApproval(t));
    await writeFile(join(dir, "alpha", "tool.ts"), "export async function run(i){return 0;}", "utf8");
    reg = await FsToolRegistry.open(dir);
    assert.match(captured, /warn:/);
    assert.match(captured, /alpha/);
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --experimental-transform-types --no-warnings packages/core/src/registry/fs-registry.test.ts`
Expected: FAIL — `integrityReport` is not a function; quarantined tool is still returned by `get`.

- [ ] **Step 3: Implement load verification in `fs-registry.ts`**

Add imports at the top of `packages/core/src/registry/fs-registry.ts`:

```ts
import { type IntegrityIssue, INTEGRITY_STATUS, verifyToolIntegrity } from "./integrity.ts";
```

Add the issues field next to the existing caches (after the `workflows` map, ~line 38):

```ts
  /** Integrity problems found during the most recent rehydrate (and on failed saves). */
  private integrityIssues: IntegrityIssue[] = [];
```

In `rehydrate()`, clear it alongside the other caches (top of the method):

```ts
    this.cache.clear();
    this.workflows.clear();
    this.integrityIssues = [];
```

Add a private recorder + public reporter (place near `rootDir()`):

```ts
  /** Records an integrity issue and logs a warning. Both recorded (queryable) and logged (stderr). */
  private recordIntegrityIssue(issue: IntegrityIssue): void {
    this.integrityIssues.push(issue);
    registryLogWarn(`tool '${issue.name}' ${issue.status}: ${issue.reason} (${issue.path})`);
  }

  /** Integrity problems found at load (and on failed saves) since the last rehydrate. */
  integrityReport(): IntegrityIssue[] {
    return [...this.integrityIssues];
  }
```

Rewrite `loadCodeTool` to verify before caching:

```ts
  private async loadCodeTool(
    entryName: string,
    codePath: string,
    manifest: ToolManifest,
    approval: ApprovalRecord | null,
  ): Promise<void> {
    let code: string;
    try {
      code = await readFile(codePath, "utf8");
    } catch (err) {
      registryLogDebug(`entry '${entryName}': missing or unreadable tool.ts`, err);
      return;
    }
    const result = verifyToolIntegrity(code, manifest, approval);
    if (result.status === INTEGRITY_STATUS.quarantined) {
      this.recordIntegrityIssue({ name: manifest.name, path: codePath, status: result.status, reason: result.reason });
      return;
    }
    if (result.status === INTEGRITY_STATUS.needsReview) {
      this.recordIntegrityIssue({ name: manifest.name, path: codePath, status: result.status, reason: result.reason });
      this.cache.set(manifest.name, { tool: { manifest, code }, approval: null, needsReview: true });
      return;
    }
    this.cache.set(manifest.name, { tool: { manifest, code }, approval });
  }
```

Rewrite `loadWorkflowTool` symmetrically (the raw `workflow.json` string is the body):

```ts
  private async loadWorkflowTool(
    entryName: string,
    workflowPath: string,
    manifest: ToolManifest,
    approval: ApprovalRecord | null,
  ): Promise<void> {
    let wRaw: string;
    try {
      wRaw = await readFile(workflowPath, "utf8");
    } catch (err) {
      registryLogDebug(`entry '${entryName}': missing or corrupt workflow.json`, err);
      return;
    }
    let workflow: Workflow;
    try {
      workflow = JSON.parse(wRaw) as Workflow;
    } catch (err) {
      registryLogDebug(`entry '${entryName}': missing or corrupt workflow.json`, err);
      return;
    }
    const result = verifyToolIntegrity(wRaw, manifest, approval);
    if (result.status === INTEGRITY_STATUS.quarantined) {
      this.recordIntegrityIssue({ name: manifest.name, path: workflowPath, status: result.status, reason: result.reason });
      return;
    }
    const needsReview = result.status === INTEGRITY_STATUS.needsReview;
    if (needsReview) {
      this.recordIntegrityIssue({ name: manifest.name, path: workflowPath, status: result.status, reason: result.reason });
    }
    this.workflows.set(manifest.name, workflow);
    this.cache.set(manifest.name, {
      tool: { manifest, code: "" },
      approval: needsReview ? null : approval,
      ...(needsReview ? { needsReview: true } : {}),
    });
  }
```

Update the `cache` field type to carry the flag (line ~34):

```ts
  private cache = new Map<string, { tool: Tool; approval: ApprovalRecord | null; needsReview?: boolean }>();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --experimental-transform-types --no-warnings packages/core/src/registry/fs-registry.test.ts`
Expected: PASS (original + 3 new tests).

- [ ] **Step 5: Run full core suite (catch fixture stragglers)**

Run: `npm test -w @meta-agent/core`
Expected: PASS. If any test now fails because it reopens a registry with a placeholder hash, migrate that fixture per Task 3's canonical transformation, then re-run.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add packages/core/src/registry/fs-registry.ts packages/core/src/registry/fs-registry.test.ts
git commit -m "feat(registry): verify tool integrity on load; quarantine tampered, flag unapproved"
```

---

## Task 5: Assert integrity on save

**Files:**
- Modify: `packages/core/src/registry/fs-registry.ts`
- Test: `packages/core/src/registry/fs-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/registry/fs-registry.test.ts` (add `import { RegistryIntegrityError } from "./integrity.ts";`):

```ts
test("save throws when manifest hash does not match the body", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    const broken = { ...t, manifest: { ...t.manifest, hash: "sha256:" + "d".repeat(64) } };
    await assert.rejects(reg.save(broken, makeConsistentApproval(t)), RegistryIntegrityError);
    // Nothing persisted.
    const reopened = await FsToolRegistry.open(dir);
    assert.equal(await reopened.get("alpha"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("save throws when approval hash does not bind to the manifest", async () => {
  const dir = await tmp();
  try {
    const reg = await FsToolRegistry.open(dir);
    const t = sample("alpha");
    const badApproval = { hash: "sha256:" + "e".repeat(64), approvedAt: "x", approvedBy: "u", alwaysApprove: false };
    await assert.rejects(reg.save(t, badApproval), RegistryIntegrityError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --experimental-transform-types --no-warnings packages/core/src/registry/fs-registry.test.ts`
Expected: FAIL — `save` does not throw; the broken tool is persisted.

- [ ] **Step 3: Implement the save assertion**

In `save()` (top of the method, before `mkdir`), add:

```ts
    const verdict = verifyToolIntegrity(tool.code, tool.manifest, approval);
    if (verdict.status !== INTEGRITY_STATUS.ok) {
      this.recordIntegrityIssue({
        name: tool.manifest.name,
        path: join(this.dir, tool.manifest.name),
        status: verdict.status,
        reason: verdict.reason,
      });
      throw new RegistryIntegrityError(tool.manifest.name, verdict);
    }
```

Add `RegistryIntegrityError` to the existing integrity import at the top of the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --experimental-transform-types --no-warnings packages/core/src/registry/fs-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full core suite**

Run: `npm test -w @meta-agent/core`
Expected: PASS. Migrate any straggler fixture that saves an inconsistent tool (Task 3 transformation) if a failure appears.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add packages/core/src/registry/fs-registry.ts packages/core/src/registry/fs-registry.test.ts
git commit -m "feat(registry): reject self-inconsistent tools at save time"
```

---

## Task 6: Tighten approval policy for unbound approvals

**Files:**
- Modify: `packages/core/src/approval/tiered-policy.ts`
- Test: `packages/core/src/approval/tiered-policy.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/approval/tiered-policy.test.ts`:

```ts
test("checkExecution prompts (no auto-approve) when approval is null, even for low tier", async () => {
  const tool = mkTool(); // low tier
  let prompts = 0;
  const prompter = {
    promptGate1: async () => { throw new Error("no"); },
    promptGate23: async () => {
      prompts++;
      return { decision: APPROVAL_DECISION.approve, token: "tok", cacheForSession: false };
    },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc" });
  const r = await policy.checkExecution(tool, {}, null);
  assert.equal(r.decision, APPROVAL_DECISION.approve);
  assert.equal(prompts, 1);
});

test("checkExecution can reject a needs-review (null-approval) tool", async () => {
  const tool = mkTool();
  const prompter = {
    promptGate1: async () => { throw new Error("no"); },
    promptGate23: async () => ({ decision: APPROVAL_DECISION.reject, reason: "no" }),
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/wkspc" });
  const r = await policy.checkExecution(tool, {}, null);
  assert.equal(r.decision, APPROVAL_DECISION.reject);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --experimental-transform-types --no-warnings packages/core/src/approval/tiered-policy.test.ts`
Expected: FAIL — the first test sees `prompts === 0` because low tier auto-approves a null-approval tool today.

- [ ] **Step 3: Implement the change**

In `packages/core/src/approval/tiered-policy.ts`, inside `checkExecution`, add a null-approval branch immediately after the `yolo` short-circuit (before the existing `if (approval && approval.hash !== ...)` check):

```ts
    if (this.yolo) return { decision: APPROVAL_DECISION.approve, token: newToken(), cacheForSession: false };

    // No binding approval (needs-review on load, or never approved): always prompt.
    // No low-tier fast path, session cache, or alwaysApprove — re-prompt until durably re-approved.
    if (approval === null) {
      return this.prompter.promptGate23(tool, args, riskTier(tool.manifest.permissions, this.workspace));
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --experimental-transform-types --no-warnings packages/core/src/approval/tiered-policy.test.ts`
Expected: PASS (existing tests still pass: the low-tier auto-approve test uses a non-null matching approval; the yolo test still short-circuits).

- [ ] **Step 5: Run full core suite**

Run: `npm test -w @meta-agent/core`
Expected: PASS. If an agent-loop/e2e test now prompts unexpectedly, it means a saved fixture's approval doesn't bind — fix that fixture via Task 3's transformation.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add packages/core/src/approval/tiered-policy.ts packages/core/src/approval/tiered-policy.test.ts
git commit -m "feat(approval): never auto-approve a tool without a binding approval record"
```

---

## Task 7: Surface integrity issues at CLI startup

**Files:**
- Create: `packages/cli/src/integrity-format.ts`
- Test: `packages/cli/src/integrity-format.test.ts`
- Modify: `packages/cli/src/repl.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/integrity-format.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-transform-types --no-warnings packages/cli/src/integrity-format.test.ts`
Expected: FAIL — cannot find module `./integrity-format.ts`.

- [ ] **Step 3: Write the implementation**

Create `packages/cli/src/integrity-format.ts`:

```ts
import { INTEGRITY_STATUS, type IntegrityIssue, type IntegrityStatus } from "@meta-agent/core";

const STATUS_LABEL: Record<IntegrityStatus, string> = {
  [INTEGRITY_STATUS.ok]: "ok",
  [INTEGRITY_STATUS.needsReview]: "needs review",
  [INTEGRITY_STATUS.quarantined]: "quarantined",
};

/**
 * Renders a startup summary of registry integrity issues, or null when there are none.
 * @param issues The registry's integrityReport().
 */
export function formatIntegrityIssues(issues: IntegrityIssue[]): string | null {
  if (issues.length === 0) return null;
  const lines = issues.map((i) => `  - ${i.name}: ${STATUS_LABEL[i.status]} (${i.reason})`);
  return `⚠ ${issues.length} tool(s) failed integrity checks:\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-transform-types --no-warnings packages/cli/src/integrity-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `repl.ts`**

In `packages/cli/src/repl.ts`, add the import near the other CLI imports:

```ts
import { formatIntegrityIssues } from "./integrity-format.ts";
```

In `createReplSession`, replace the first two lines of the body:

```ts
  const registry = await FsToolRegistry.open(config.toolsDir);
  await seedBuiltins(registry);
```

with:

```ts
  const registry = await FsToolRegistry.open(config.toolsDir);
  const integritySummary = formatIntegrityIssues(registry.integrityReport());
  if (integritySummary) process.stderr.write(`${integritySummary}\n`);
  await seedBuiltins(registry);
```

- [ ] **Step 6: Run CLI suite + typecheck**

Run: `npm test -w @meta-agent/cli`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/integrity-format.ts packages/cli/src/integrity-format.test.ts packages/cli/src/repl.ts
git commit -m "feat(cli): surface registry integrity issues at startup"
```

---

## Task 8: Documentation

**Files:**
- Modify: `docs/meta-tool-design.md`
- Modify: `docs/repo_structure.md`

- [ ] **Step 1: Add the persistence integrity boundary to `meta-tool-design.md`**

In `docs/meta-tool-design.md`, add a new subsection after §4.7 (On-disk result), titled **"4.7a Persistence integrity boundary"**, with this content:

```markdown
### 4.7a Persistence integrity boundary

The approval hash only means something if the registry re-derives it from disk. On load and save, `FsToolRegistry` calls `verifyToolIntegrity(body, manifest, approval)` (see `packages/core/src/registry/integrity.ts`), which checks two links:

- **Link A — manifest ⇄ body:** `manifest.hash` must equal `hashTool(body, manifestSansHash)`, where `body` is `tool.ts` (atomic/composite) or `workflow.json` (workflow).
- **Link B — approval ⇄ manifest:** an approval record must exist with `approval.hash === manifest.hash`.

Reactions:

- **Link A fails → quarantine.** The entry is not loaded into the usable cache (undiscoverable, unexecutable). The manifest is untrustworthy, so its declared risk tier is not trusted either. This applies even under `yolo`, because it happens at load before the cache exists.
- **Link B fails → needs review.** The content is authentic but unapproved; the entry loads but its approval is treated as `null`, so `checkExecution` must prompt before any execution and can never auto-approve it via the low tier, session cache, or always-approve. This also closes the hole where a low-tier tool with no `approval.json` ran with zero prompts. Under `yolo`, needs-review tools still run (yolo accepts running unapproved authentic code; it does not accept running corrupted tools).
- **save** throws `RegistryIntegrityError` before writing if the tool it is asked to persist is not self-consistent, so the registry can never write a broken entry.

Every quarantine/needs-review event is both recorded (queryable via `registry.integrityReport()`) and logged to stderr (`registryLogWarn`); the CLI prints a summary at startup.

Out of scope here: durable re-approval of a needs-review tool (it re-prompts every execution until properly re-approved) and JSON-schema shape validation of manifests/approvals.
```

Also add a cross-reference in §10.1 (validation layers): after the "Runtime (every invocation)" bullet, add:

```markdown
4. **Persistence (registry load/save):** recompute the content hash and verify the approval binding when durable state enters or leaves memory (see §4.7a).
```

- [ ] **Step 2: Record the decision in §11**

Add a new subsection **"11.13 Registry integrity verification"** to `docs/meta-tool-design.md`:

```markdown
### 11.13 Registry integrity verification

**Chosen:** Verify content/approval hashes inside `FsToolRegistry` (on load and save), backed by a standalone, I/O-free `registry/integrity.ts` module. Quarantine tampered entries; treat unbound-approval entries as needs-review; throw on inconsistent saves.

**Considered:**

- *A `VerifyingToolRegistry` decorator* wrapping any `ToolRegistry` — makes integrity reusable across registry backends (SQLite, remote). Deferred because the cache and quarantine-at-load semantics live where files are read, so a decorator would double-read files or require the inner registry to expose raw bytes. See §12.
- *Lazy verify-at-read* — rejected: conflicts with quarantine-removes-from-cache and repeats hashing on every read.

**Why chosen:** smallest change that closes the H1 gap, centralizes the check where disk state enters memory, and reuses the existing `approval === null` seam. Keeping the verification core in its own module means the decorator upgrade (§12) is a cheap lift later — POC simplicity now, clean evolution path preserved.
```

- [ ] **Step 3: Add the longer-term path to §12 (Future Extensions)**

Append to the numbered list in §12 of `docs/meta-tool-design.md`:

```markdown
10. **`VerifyingToolRegistry` decorator.** Lift the integrity core (`registry/integrity.ts`) into a registry decorator that wraps any `ToolRegistry` implementation, so content/approval verification, quarantine, and needs-review handling apply uniformly to filesystem, SQLite, or remote backends without per-implementation reimplementation. The verification function is already backend-agnostic; the decorator only needs raw-body access from the wrapped registry.
```

- [ ] **Step 4: Update `repo_structure.md`**

In `docs/repo_structure.md`, in the registry module description, add a sentence noting the new module:

```markdown
- `registry/integrity.ts` — pure content/approval hash verification used at the registry's load/save boundary; depends only on `hash.ts` and `types.ts` (no I/O, no TTY).
```

- [ ] **Step 5: Commit**

```bash
git add docs/meta-tool-design.md docs/repo_structure.md
git commit -m "docs: document registry integrity boundary and decision record"
```

---

## Task 9: Final verification

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS across `@meta-agent/core` and `@meta-agent/cli`.

- [ ] **Step 3: Targeted e2e (sandbox/workflow paths touched by fixture migration)**

Run: `npm run test:e2e -w @meta-agent/core`
Expected: PASS.

- [ ] **Step 4: Lint the files you touched**

Use the editor lint/ReadLints on the created/modified files; fix any introduced lints.

- [ ] **Step 5: Final commit (if Step 4 changed anything)**

```bash
git add -A
git commit -m "chore: lint fixes for registry integrity verification"
```

---

## Self-Review Notes

- **Spec coverage:** integrity module (Task 1) ↔ spec §4; registry load (Task 4) ↔ §5.2/§5.4; registry save (Task 5) ↔ §5.3; policy change (Task 6) ↔ §6; yolo boundary documented (Task 8) ↔ §6.1; warning logged+recorded (Tasks 4, 7) ↔ §5.4/§4.7a and the user's emphasis; testing/fixtures (Tasks 2, 3) ↔ §8; docs (Task 8) ↔ §9. Non-goals (durable re-approval, schema-shape validation, atomic writes) are explicitly out of scope and noted in docs.
- **Warnings logged + recorded:** every non-ok outcome on load and every rejected save calls `recordIntegrityIssue`, which both pushes to `integrityIssues` (recorded; queryable via `integrityReport()`) and emits `registryLogWarn` (logged to stderr, always on). The CLI additionally prints the report at startup. A dedicated test (Task 4, Step 1, third test) asserts the stderr warning fires.
- **Type consistency:** `verifyToolIntegrity(body, manifest, approval)`, `IntegrityResult`, `IntegrityIssue`, `INTEGRITY_STATUS`, `RegistryIntegrityError(toolName, result)`, `makeConsistentTool(manifestSansHash, body)`, `makeConsistentApproval(tool, overrides?)`, `integrityReport()`, and `formatIntegrityIssues(issues)` are used identically across every task that references them.
- **Ordering safety:** fixtures are migrated (Task 3) before enforcement is enabled (Tasks 4–6), so the suite stays green at every commit.
```

