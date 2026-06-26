# Registry Integrity Verification — Design Spec

**Status:** Draft for implementation planning
**Date:** 2026-06-26
**Addresses:** Design review issue **H1** — "Registry trusts stored hashes instead of verifying tool contents" (`tmp/design_review_gpt55.md`).
**Scope:** `packages/core` registry, hashing, and approval policy. CLI startup surfacing.

---

## 1. Problem

The approval model rests on a content hash:

```
hash = sha256(code ⧺ "\n---manifest---\n" ⧺ canonicalJson(manifestSansHash))
```

(see [`packages/core/src/hash.ts`](../../../packages/core/src/hash.ts)).

For an on-disk tool to be trustworthy, two integrity links must hold:

- **Link A — manifest ⇄ body.** `manifest.hash` must equal `hashTool(body, manifestSansHash)`, where `body` is `tool.ts` (atomic/composite) or `workflow.json` (workflow).
- **Link B — approval ⇄ manifest.** `approval.hash` must equal `manifest.hash`, binding a reviewer decision to exact content.

Today the registry verifies **neither at the persistence boundary**:

- `FsToolRegistry.rehydrateOneEntry`, `loadCodeTool`, and `loadWorkflowTool` parse `manifest.json` / `approval.json` / `tool.ts` / `workflow.json` and trust `manifest.hash` as-is. They never recompute Link A.
- `TieredApprovalPolicy.checkExecution` compares `approval.hash` to `manifest.hash` (Link B), but both values are blindly trusted from disk, so the comparison is self-referential. Worse, for `low`-tier tools `checkExecution` returns approve before that comparison matters, and when `approval` is `null` it never runs the Link B check at all.

**Consequence:** Hand-editing `tool.ts` / `workflow.json` (or any manifest field) while leaving the stale `manifest.hash` and `approval.json` in place lets the system execute code that was never approved under the recorded hash. The approval model is inspectable on disk but not trustworthy.

## 2. Goals and Non-Goals

### Goals

1. Recompute and verify Link A and Link B at the boundary where durable state enters memory (registry load) and where it leaves memory (registry save).
2. React safely to violations: tampered/corrupt entries are quarantined; authentic-but-unapproved entries are forced through review.
3. Close the related hole where a `low`-tier tool with no binding approval runs with zero prompts.
4. Keep the integrity logic in a standalone, I/O-free module so it is independently testable and can later be reused by other registry backends.
5. Surface violations to the operator without adding TTY dependencies to `core`.

### Non-Goals

- **Durable re-approval.** A needs-review tool re-prompts on every execution until properly re-approved; persisting a fresh `approval.json` at execution time is the separate **L9** issue and is out of scope.
- **Manifest/approval JSON-schema shape validation** at the boundary (the separate **M2** issue). This spec verifies hashes, not schema shape.
- **Atomic registry writes** (the separate **M3** issue).
- Changing the hash scheme itself.

## 3. Chosen Approach and Decision Record

**Chosen: Approach 1 — verification inside `FsToolRegistry`, backed by a standalone integrity module.**

A pure helper module (`registry/integrity.ts`) computes integrity status from bytes; `FsToolRegistry` orchestrates it on load and save; `TieredApprovalPolicy` refuses to auto-approve entries without a binding approval.

**Why (explicit simplicity choice for the POC):** it matches the decisions driving this work (quarantine-at-load, enforce at load + save), keeps the change small and centralized, reuses the existing `approval === null` seam instead of inventing new policy surface, and fixes the low-tier hole as a side effect. Keeping the verification logic in its own module (rather than inline in `FsToolRegistry`) costs almost nothing now and preserves the upgrade path below.

**Considered:**

- **Approach 2 — `VerifyingToolRegistry` decorator** wrapping any `ToolRegistry`. Makes integrity a reusable, swappable concern protecting any backend (SQLite, remote) for free, and honors the "every seam is an interface" ethos. Rejected for now because the cache and quarantine-at-load semantics live where files are read, so a decorator would either double-read files or require the inner registry to expose raw bytes — more indirection than this POC needs. **Recorded as the longer-term direction** (Section 9): because the integrity logic is isolated in `registry/integrity.ts`, lifting it into a decorator later requires no change to the verification core.
- **Approach 3 — lazy verify-at-read.** No startup pass; verify in `get`/`getApproval`. Rejected: conflicts with "quarantine removes the tool from the usable cache" (`list`/catalog would still surface tampered tools), and repeats hashing on every read.

## 4. The Integrity Module (`packages/core/src/registry/integrity.ts`)

Pure, no I/O, no TTY. Independent of `FsToolRegistry` so it can later be reused by a decorator unchanged.

```ts
export const INTEGRITY_STATUS = {
  ok: "ok",
  needsReview: "needs_review",
  quarantined: "quarantined",
} as const;
export type IntegrityStatus = (typeof INTEGRITY_STATUS)[keyof typeof INTEGRITY_STATUS];

export type IntegrityResult =
  | { status: "ok" }
  | { status: "needs_review"; reason: string }
  | { status: "quarantined"; reason: string };

/**
 * Verify a tool's content/approval integrity.
 * @param body     Raw tool body bytes: tool.ts (atomic/composite) or workflow.json (workflow).
 * @param manifest Parsed manifest (its `hash` field is the claimed Link-A hash).
 * @param approval Parsed approval record, or null when absent.
 */
export function verifyToolIntegrity(
  body: string,
  manifest: ToolManifest,
  approval: ApprovalRecord | null,
): IntegrityResult;
```

Logic, in order:

1. **Link A:** recompute `hashTool(body, manifestSansHash)`. If it does not equal `manifest.hash` → `quarantined` (the manifest is untrustworthy; we do not even trust its declared risk tier).
2. **Link B:** if `approval` is `null` or `approval.hash !== manifest.hash` → `needs_review`.
3. Otherwise → `ok`.

Notes:

- The function hashes the **raw body bytes**, never a re-serialization, so it is symmetric with how the factory computes the hash at creation (`hashTool` updates the digest with `code` verbatim). The manifest side is canonicalized by `hashTool`, so manifest key reordering/formatting on disk does not cause false Link-A failures; actual field-content changes do.
- It is kind-agnostic: the caller supplies the correct `body`. For workflow tools the on-disk `workflow.json` is byte-stable with the string that was hashed at creation (`JSON.stringify(workflow, null, 2)` round-trips), so re-reading the file and hashing it reproduces `manifest.hash`.

## 5. `FsToolRegistry` Integration

### 5.1 Cache entry shape

The in-memory cache entry gains an optional flag:

```ts
private cache = new Map<string, { tool: Tool; approval: ApprovalRecord | null; needsReview?: boolean }>();
```

### 5.2 On load

`loadCodeTool` and `loadWorkflowTool`, after reading the body (`tool.ts` or `workflow.json`), call `verifyToolIntegrity(body, manifest, approval)`:

- **`quarantined`** → do **not** insert into `cache`/`workflows`. Record an issue and `registryLogWarn`. The tool is undiscoverable (`list`, `get`, catalog) and unexecutable.
- **`needs_review`** → insert into cache as today, but with `approval: null` and `needsReview: true`. Record an issue and `registryLogWarn`.
- **`ok`** → unchanged.

`getApproval` returns `null` for needs-review entries (it already reads `cache.get(name)?.approval`, which is now `null`), so the existing dispatch path naturally sees "no binding approval".

### 5.3 On save

`save` calls `verifyToolIntegrity(tool.code, tool.manifest, approval)` **before writing anything**. For workflow tools `tool.code` holds the serialized IR, which is the body that gets hashed and written, so the same call applies. If the result is not `ok`, throw a structured `RegistryIntegrityError` (new error type) describing which link failed. This guarantees the registry can never persist a self-inconsistent entry.

### 5.4 Integrity report

`FsToolRegistry` accumulates issues during `rehydrate`:

```ts
export type IntegrityIssue = { name: string; path: string; status: IntegrityStatus; reason: string };
integrityReport(): IntegrityIssue[];
```

Core only exposes structured data and logs via `registryLogWarn`; it does no printing.

## 6. Approval Policy Change

`TieredApprovalPolicy.checkExecution` is tightened so a **missing binding approval is never silently executed**:

- When `approval === null` (needs-review, or a genuinely unapproved entry), always `promptGate23` and never take the `low`-tier fast path, the session cache, or `alwaysApprove`.
- All other branches are unchanged.

Because `seedBuiltins` and the factory always write a matching `approval.json`, this only fires for tampered/hand-edited entries — and it simultaneously closes the standalone hole where a `low`-tier tool with no `approval.json` runs with zero prompts.

### 6.1 Deliberate `yolo` boundary

`yolo` still auto-approves **execution** (its first-line short-circuit in `checkExecution` is unchanged), consistent with the documented model that `yolo` relaxes only execution gates. However:

- **Quarantine (Link A) applies even under `yolo`**, because it happens at load, before the cache exists — a tampered/corrupt tool never becomes runnable regardless of mode.
- **Needs-review (Link B)** entries still run under `yolo` (authentic content, unapproved). This is consistent: `yolo` means "I accept running unapproved authentic code"; it does not mean "I accept running corrupted tools."

## 7. Data Flow Summary

```
load:  read body ─▶ verifyToolIntegrity(body, manifest, approval)
                      ├─ quarantined  ─▶ skip cache + record issue + warn
                      ├─ needs_review ─▶ cache{approval:null, needsReview} + record issue + warn
                      └─ ok           ─▶ cache normally

dispatch: registry.get / getApproval ─▶ approval (null for needs-review)
          checkExecution: approval===null ─▶ always prompt (no low/cache/always fast paths)

save:  verifyToolIntegrity(tool.code, manifest, approval)
          └─ not ok ─▶ throw RegistryIntegrityError (write nothing)

cli startup: registry.integrityReport() ─▶ print summary
```

## 8. Testing

- **`integrity.test.ts`** (new): `ok`; Link A fail → `quarantined`; Link B fail via missing approval and via mismatched approval → `needs_review`; covers code and workflow bodies.
- **`fs-registry.test.ts`**: tampered `tool.ts` → quarantined (absent from `list`/`get`, present in `integrityReport`); mismatched `approval.json` → loads but `getApproval` is `null` and entry is needs-review; `save` throws `RegistryIntegrityError` on an inconsistent tool.
- **`tiered-policy.test.ts`**: update the existing low-tier auto-approve expectation — with `approval === null` it now prompts; add a needs-review-cannot-be-auto-approved case; confirm `yolo` still auto-approves execution.
- **Fixture churn:** add a test helper `makeConsistentTool(manifestSansHash, code)` (computes the hash via `hashTool`) plus a matching approval builder. Migrate fixtures that currently save placeholder hashes — notably `workflow/e2e-lift.test.ts` (`"sha256:test-hash"`), and saved-tool fixtures in `factory.test.ts` and `agent/agent-loop.test.ts`. Audit all `registry.save(...)` call sites.
- **Verification:** full `npm run typecheck` + `npm test`.

## 9. Documentation Updates (implementation tasks)

- **`docs/meta-tool-design.md`**: add a "Persistence integrity boundary" subsection near §4.6 (approval caching key) / §4.7 (on-disk result) and referenced from §10.1 (validation layers), describing Link A / Link B, quarantine vs needs-review, the save assertion, and the `yolo` boundary.
- **§11 (Design Decisions and Trade-offs):** record choosing Approach 1 (in-registry verification + standalone `integrity.ts`) explicitly for POC simplicity.
- **§12 (Future Extensions):** add Approach 2 (`VerifyingToolRegistry` decorator) as the longer-term path that brings integrity to any registry backend without per-implementation reimplementation, noting the integrity core already lives in a standalone module to make that lift cheap.
- **`docs/repo_structure.md`**: note the new `registry/integrity.ts` module and its ownership/dependency direction (pure, depends only on `hash.ts` + `types.ts`).

## 10. Risks and Mitigations

- **Test fixture breakage** from the save assertion is the largest surface. Mitigation: the `makeConsistentTool` helper plus a focused audit of `registry.save` call sites.
- **Body byte-stability for workflows.** The hash is over raw body bytes, so any reformatting of `workflow.json`/`tool.ts` on disk invalidates Link A (intended: any edit invalidates approval). Documented as expected behavior.
- **Behavior change visibility.** The `checkExecution` null-approval change alters a previously-silent path; covered by updated policy tests and the design doc.
