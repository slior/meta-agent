# Tool Discriminated Union & Explicit Registry API — Design Spec

**Status:** Approved, ready for implementation planning
**Date:** 2026-08-01
**Addresses:** Design review issue M1 — `Tool` overloads `code` for workflow IR
**Related:** ADR 004 (registry integrity), ADR 005 (workflow Gate 1; existing `Gate1ReviewPayload` union)
**Review:** High, medium, and low issues from
`docs/superpowers/specs/reviews/2026-08-01-tool-discriminated-union-design_review.md`
addressed in this revision. Follow-up re-review gaps also addressed: package-internal
`hashToolBody`, execution-boundary Link A re-verify, `INTEGRITY_STATUS.invalid` for parse
failures, `parseWorkflow` on `saveWorkflow`, and `CodeKind` owned in `types.ts`.

---

## Problem

`Tool` is defined as `{ manifest, code }` for every tool kind. Atomic and composite tools store
TypeScript source in `code`. Workflow creation serializes workflow IR into `code` temporarily;
`FsToolRegistry.save` parses `tool.code` to write `workflow.json`, then stores workflow tools in
memory with `code: ""` plus a separate `workflows` map.

Consequences:

1. Generic code cannot safely reason about `Tool.code` without checking `manifest.kind`.
2. Workflow hash computation depends on an ad-hoc serialization convention at call sites
   (`JSON.stringify` into `code` before save).
3. In-memory representation lies (`code: ""`) while the real body lives in a parallel map.
4. Future tool kinds will add more special cases on the same overloaded field.

Gate 1 already uses a discriminated union (`CodeGate1Payload | WorkflowGate1Payload` per ADR 005).
The registered-tool model should match that explicitness.

---

## Goals

1. Make `Tool` a discriminated union: `CodeTool | WorkflowTool`, with workflow IR as a typed
   `workflow` field — never a string in `code`, never an empty placeholder.
2. Make the registry read/write API kind-explicit: `getCode` / `getWorkflow` / `saveCode` /
   `saveWorkflow`, plus `getKind` / `getManifest` for kind-agnostic metadata. No polymorphic
   `get` / `save`.
3. Make hashing kind-explicit: `hashCodeTool` / `hashWorkflowTool`, with a single owned
   `serializeWorkflowBody` used when creating **new** workflow body bytes for hash and disk write.
4. Preserve ADR 004 Link A/B semantics and the existing on-disk layout
   (`tool.ts` / `workflow.json` / `manifest.json` / `approval.json`).
5. Preserve Link A for **any** existing on-disk body whose `manifest.hash` was computed from those
   exact bytes (pretty-printed, minified, or other formatting). New saves use
   `serializeWorkflowBody`; that format is **not** a claim about the legacy corpus.
6. Structurally parse workflow JSON on rehydrate via `parseWorkflow` (after Link A), with the IR
   JSON schema first updated to accept ADR 003 `SymRef.path`.
7. Narrow `ToolDraft.kind` to `CodeKind` through types, Gate 1 code payloads, factory helpers,
   JSON schemas, and static validation.
8. Update all production and test call sites (see migration checklist), docs, and add ADR 009.
9. Keep ADR 004 diagnostics: `integrityReport()` remains on the public registry contract.
10. Re-verify Link A for code tools at the sandbox boundary (`permission_denied` on mismatch);
    bind workflow approval and execution to one `getWorkflow` snapshot (no approve/run split fetch).
11. Reject structurally invalid workflows on `saveWorkflow` via `parseWorkflow` before write.
12. Record rehydrate structural-parse failures under `INTEGRITY_STATUS.invalid` (not Link-A
    `quarantined`).

---

## Non-Goals

- Manifest TypeScript ↔ `MANIFEST_SCHEMA` drift for registry validation (design-review issue M2 in
  `tmp/design_review_gpt55.md`) — follow-up; distinct from narrowing `ToolDraft` in this spec.
- Atomic registry writes (design-review M3) — follow-up. Stale-body cleanup on kind-changing save
  is in scope and does not require atomic rename.
- Changing on-disk directory layout or introducing a new tool kind.
- Changing the preferred new-save pretty-print format.
- Splitting into dual registries (`CodeToolRegistry` + `WorkflowToolRegistry`).
- Soft-migration / deprecation aliases for removed public exports (`hashTool`, polymorphic
  `get`/`save`, string-bodied `verifyToolIntegrity`).
- Exporting `hashToolBody` from the public package barrel (it is package-internal only).
- Git commits as part of design or implementation of this work (explicit operator preference).

---

## Decisions

| Topic | Choice |
| ----- | ------ |
| Scope | Typed union **and** explicit registry methods |
| Module ownership | `tool.ts` owns `CodeTool` / `WorkflowTool` / `Tool` / guards |
| `CodeKind` | Defined in `types.ts` beside `ToolKind` (avoids `types` ↔ `tool` cycle) |
| Reads | `getCode` / `getWorkflow` / `getKind` / `getManifest` — no polymorphic `get` |
| `getWorkflow` return type | `WorkflowTool \| null` (breaking; callers use `.workflow`) |
| Metadata-only lookup | `getManifest(name)` (preferred when body not needed) |
| Hashing | Public `hashCodeTool` / `hashWorkflowTool`; package-internal `hashToolBody` for raw bytes |
| Load integrity | Always hash **raw file bytes** (never parse→reserialize→hash) |
| Load structure | After Link A, `parseWorkflow` before caching; parse fail → `invalid` |
| Save structure | `saveWorkflow` runs `parseWorkflow` before integrity verify / write |
| Schema prerequisite | Extend workflow JSON schema for optional `SymRef.path` (and return `source.path`) |
| `ToolDraft` | `kind: CodeKind` only |
| Kind-changing save | Allowed; delete the alternate body file (`tool.ts` ↔ `workflow.json`) |
| Cache safety | Deep clone on save into cache; deep clone on get; optional deep-freeze of returned values |
| Execution safety | Code: Link A re-verify in sandbox → `permission_denied`. Workflow: single fetch for validate/approve/run |
| Parse-failure status | New `INTEGRITY_STATUS.invalid` (distinct from Link-A `quarantined`) |
| Public breaks | Hard cut — no deprecation aliases |
| Legacy compat proof | Checked-in pre-change registry fixture (incl. minified workflow) |
| Approach | Single registry, shared name space, explicit API |

---

## Design

### 1. Type model and module ownership

#### 1.1 `CodeKind` in `types.ts`; registered tools in `tool.ts`

**`CodeKind` (fixed ownership):** define beside `ToolKind` in `packages/core/src/types.ts` so
`ToolDraft` can reference it with no `types.ts` ↔ `tool.ts` cycle:

```ts
// types.ts (next to TOOL_KIND / ToolKind)
export type CodeKind = typeof TOOL_KIND.ATOMIC | typeof TOOL_KIND.COMPOSITE;
```

**`packages/core/src/tool.ts`:** owns the registered-tool union and guards only. Imports
`CodeKind` / `ToolManifest` from `types.ts` and `Workflow` from `workflow/types.ts` (one-way;
`types.ts` never imports `tool.ts` or workflow).

```ts
// tool.ts
import { TOOL_KIND, type CodeKind, type ToolManifest } from "./types.ts";
import type { Workflow } from "./workflow/types.ts";

export type CodeTool = {
  manifest: ToolManifest & { kind: CodeKind };
  code: string;
};

export type WorkflowTool = {
  manifest: ToolManifest & { kind: typeof TOOL_KIND.WORKFLOW };
  workflow: Workflow;
};

export type Tool = CodeTool | WorkflowTool;

export function isCodeTool(t: Tool): t is CodeTool { /* ... */ }
export function isWorkflowTool(t: Tool): t is WorkflowTool { /* ... */ }
```

Barrel (`index.ts`) re-exports `CodeKind` from `types.ts` and `CodeTool` / `WorkflowTool` / `Tool` /
guards from `tool.ts`. Remove any flat `Tool = { manifest, code }` from `types.ts`.

#### 1.2 `ToolDraft` narrowed to code kinds (M2)

In `types.ts` (and everywhere it flows):

```ts
kind: CodeKind;  // not ToolKind — workflow tools are never drafts with `code`
```

Propagate through:

- `CodeGate1Payload.draft` / edited drafts in `CodeGate1Decision`
- `ToolFactory` draft/repair/present paths and `draftToTool`
- `TOOL_DRAFT_SCHEMA` (already enum-limited to atomic/composite — keep aligned)
- `staticValidateDraft` and any helpers that accept `ToolDraft`

Workflow creation continues via `createWorkflow` + `WorkflowGate1Payload` only.

#### 1.3 Rules

- `CodeTool.code` is TypeScript source only.
- `WorkflowTool.workflow` is the typed IR — never JSON-in-string, never `code: ""`.
- `Tool` union is for `FactoryOutcome`, type guards, approval prompts that only need `manifest`,
  and lift snapshots (`toolsByName: Record<string, Tool>`).
- Sandbox and smoke-test paths accept `CodeTool` only (see §4.1).

### 2. Registry API (`packages/core/src/registry/tool-registry.ts`, `fs-registry.ts`)

On-disk layout unchanged: `./tools/<name>/{manifest.json, approval.json, tool.ts|workflow.json}`.
At most one of `tool.ts` / `workflow.json` exists for a given entry after a successful save.

```ts
interface ToolRegistry {
  list(): Promise<ToolSummary[]>;
  listSync(): ToolSummary[];
  has(name: string): Promise<boolean>;
  getKind(name: string): Promise<ToolKind | null>;
  getManifest(name: string): Promise<ToolManifest | null>;
  getCode(name: string): Promise<CodeTool | null>;
  getWorkflow(name: string): Promise<WorkflowTool | null>;
  getApproval(name: string): Promise<ApprovalRecord | null>;
  saveCode(tool: CodeTool, approval: ApprovalRecord): Promise<void>;
  saveWorkflow(tool: WorkflowTool, approval: ApprovalRecord): Promise<void>;
  delete(name: string, opts?: { cascade?: boolean }): Promise<void>;
  getDependents(name: string): Promise<string[]>;
  rootDir(): string;
  /** Load/save diagnostics: quarantined / needs-review / invalid since last rehydrate (and failed saves). */
  integrityReport(): IntegrityIssue[];
}
```

Behavior:

- `getCode` / `getWorkflow` return `null` if the name is missing **or** the stored kind does not
  match (no throw on kind mismatch).
- `getManifest` returns the cached manifest (defensive clone) or `null` if missing. Prefer this
  when only metadata is needed (validator callee checks, index corpus, CLI catalog, factory
  permission union). Body getters remain kind-explicit.
- `getKind` remains a thin kind lookup (equivalent to `getManifest` then `.kind`, but without
  requiring callers to ignore unused fields).
- `saveCode` / `saveWorkflow` verify integrity for that kind, write the matching body file, update
  the cache. Mismatched `manifest.kind` is a programmer error → throw.
- **`saveWorkflow` structural gate:** before integrity verify / write, run `parseWorkflow` on the
  serialized body (or equivalently parse the object round-trip through `serializeWorkflowBody` →
  `JSON.parse` → `parseWorkflow`). On failure, throw (do not write, do not update cache). This
  prevents persisting a malformed runtime object that would become unloadable after restart.
- **Kind-changing save (M6):** Overwriting an existing name with a different kind is allowed.
  After writing the new body, **delete** the alternate body file if present (`saveCode` removes
  `workflow.json`; `saveWorkflow` removes `tool.ts`). Best-effort unlink is enough for this
  change; full atomic multi-file rename remains a non-goal.
- In-memory: one entry map keyed by name; each entry holds a `CodeTool` or `WorkflowTool` plus
  approval metadata. **Remove** the parallel `workflows` map and the `code: ""` placeholder.
- Rehydrate: see §3.2 / §3.5.
- `integrityReport()` stays on `ToolRegistry`. Stubs may return `[]`.

**Cache immutability:** Callers must not mutate **registry state** via returned objects.

- On `saveCode` / `saveWorkflow`, store a **deep clone** of the tool (and approval) in the cache.
- On `getCode` / `getWorkflow` / `getManifest` / `getApproval`, return a **deep clone**.
- Optional defense-in-depth: deep-freeze the returned clone (recursive `Object.freeze`) so
  accidental mutation throws in strict mode. Freeze alone is **not** the trust boundary.
- Tests must assert mutations to returned values do not affect subsequent gets or cached state.

**Execution-boundary integrity (primary mutation / TOCTOU defense):** Clones stop cache poisoning;
they do **not** stop a caller from mutating their clone (or constructing a `Tool` with a matching
`manifest.hash` and different body) and passing it to execution. Chosen rules:

1. **Code path:** Before spawning, `NodePermissionSandbox` recomputes Link A over `tool.code`
   via `hashToolBody` and refuses to run if it does not equal `tool.manifest.hash`. Failure kind
   is **`permission_denied`** (stable; content is not the approved body). Applies to agent
   dispatch and factory smoke tests.
2. **Workflow path — single snapshot for approve + run:** Do **not** re-hash via
   `serializeWorkflowBody` at execute time (false-denies legacy minified bodies), and do **not**
   re-fetch between approval and execution (a concurrent `saveWorkflow` could then approve hash H1
   and run hash H2).
   - Registry cache may retain the raw body string that passed Link A (private; not on
     `WorkflowTool`).
   - `getWorkflow` returns a deep clone of `{ manifest, workflow }` only.
   - In `dispatchTool`, once the kind is known to be workflow, **`getWorkflow(name)` once** and
     use that **same** `WorkflowTool` for input-schema validation, Gate 2/3 approval
     (`checkExecution` / `runWithApproval`), and `executor.run(tool.workflow, …)`. No second
     fetch on that path.
   - A concurrent save after this fetch does not change what this invocation runs: execution uses
     the snapshot that was approved. The next invocation will see the new entry.
3. **Optional:** deep-freeze getter results as defense-in-depth against accidental mutation of the
   in-hand snapshot during `await` gaps.

**Metadata-only call sites (M3):**

```ts
const manifest = await registry.getManifest(name);
if (!manifest) { /* unknown */ }
// use manifest.kind / inputSchema / permissions / rationale — no body fetch
```

**Body call sites** still branch explicitly:

```ts
const kind = await registry.getKind(name); // or manifest.kind from getManifest
if (kind === TOOL_KIND.WORKFLOW) {
  const tool = await registry.getWorkflow(name);
  // use tool.workflow, tool.manifest
} else if (kind !== null) {
  const tool = await registry.getCode(name);
  // use tool.code, tool.manifest
}
```

A **package-private** helper that loads a full `Tool` union for rare callers (e.g. lift snapshot)
is allowed; it must not reappear as polymorphic `get` on the public interface.

### 3. Hashing and integrity (`hash.ts`, `registry/integrity.ts`)

Keep ADR 004 Link A/B: hash binds **body bytes** to the manifest; approval binds to `manifest.hash`.

#### 3.1 Hash API layers

```ts
/** Package-internal raw-body digest (same algorithm as today's hashTool). NOT in public barrel. */
function hashToolBody(
  body: string,
  manifestSansHash: Omit<ToolManifest, "hash">,
): string;

/** Public */
function hashCodeTool(
  code: string,
  manifestSansHash: Omit<ToolManifest, "hash">,
): string; // = hashToolBody(code, manifestSansHash)

function hashWorkflowTool(
  workflow: Workflow,
  manifestSansHash: Omit<ToolManifest, "hash">,
): string; // = hashToolBody(serializeWorkflowBody(workflow), manifestSansHash)

/** Encoding for *new* workflow bodies (factory / saveWorkflow). Not the legacy-load contract. */
function serializeWorkflowBody(workflow: Workflow): string;
```

- `hashToolBody` is exported from `hash.ts` for use by `registry/integrity.ts`,
  `NodePermissionSandbox` (execution Link A), and the kind-specific wrappers. It is **not**
  re-exported from `packages/core/src/index.ts`.
- `serializeWorkflowBody` = `JSON.stringify(workflow, null, 2)` for **new** writes only.
- `saveWorkflow` sequence:
  1. `const raw = serializeWorkflowBody(tool.workflow)`
  2. `parseWorkflow(JSON.parse(raw))` — throw on structural failure
  3. `verifyToolIntegrity({ kind: "workflow", raw }, tool.manifest, approval)`
  4. write `raw`; delete alternate `tool.ts` if present; clone into cache (retain raw privately)

#### 3.2 Load vs save integrity (H1, M7)

| Path | Body input to Link A | After verify |
| ---- | -------------------- | ------------ |
| **Rehydrate / load** | Exact `tool.ts` or `workflow.json` file bytes as read from disk | Code: cache `CodeTool`. Workflow: `parseWorkflow` then cache `WorkflowTool` (+ retain raw) |
| **Save (create/update)** | For code: `tool.code`. For workflow: `serializeWorkflowBody` after parse gate | Write those exact bytes; remove alternate body file if kind changed |

**Compatibility (M7):** Any on-disk body whose bytes still match `manifest.hash` must load, regardless
of pretty-print vs minified vs other formatting. Do **not** document or test compatibility as
“existing bodies equal `JSON.stringify(..., null, 2)`.”

**Forbidden on load:** parse → reserialize → hash. Load Link A uses `hashToolBody(rawFileBytes, …)`.

#### 3.3 `verifyToolIntegrity` — kind-tied overloads (H2)

Integrity always consumes **raw body strings** and calls `hashToolBody` (never
`hashWorkflowTool`, which would reserialize):

```ts
type CodeIntegrityBody = { kind: "code"; code: string };
type WorkflowIntegrityBody = { kind: "workflow"; raw: string };

function verifyToolIntegrity(
  body: CodeIntegrityBody,
  manifest: ToolManifest & { kind: CodeKind },
  approval: ApprovalRecord | null,
): IntegrityResult;

function verifyToolIntegrity(
  body: WorkflowIntegrityBody,
  manifest: ToolManifest & { kind: typeof TOOL_KIND.WORKFLOW },
  approval: ApprovalRecord | null,
): IntegrityResult;
```

Runtime kind-mismatch (body vs manifest) → `quarantined` / save throws; do not hash mismatched pairs.

#### 3.4 Integrity statuses (parse failures)

Extend ADR 004 statuses:

```ts
export const INTEGRITY_STATUS = {
  ok: "ok",
  needsReview: "needs_review",
  /** Link A failure: body bytes do not match manifest.hash */
  quarantined: "quarantined",
  /**
   * Link A passed (or was not the failure mode), but the body is structurally unusable.
   * Used when workflow.json parses as JSON and matches its hash but fails parseWorkflow.
   */
  invalid: "invalid",
} as const;
```

- `quarantined` semantics **unchanged**: hash mismatch / untrustworthy manifest↔body binding.
- `invalid`: structural/schema failure after Link A (or analogous “body present but not a usable
  tool”). Same discoverability as quarantine: not cached, not runnable, surfaced via
  `integrityReport()`.
- Document the distinction in ADR 009 and in a short note amending ADR 004’s status list (or in
  ADR 009 only if we prefer not to edit 004 — prefer a one-line “extended by ADR 009” note in 004).
- Add `INTEGRITY_REASON.workflowParseFailed` (stable string).

#### 3.5 Public API removals (H5) and `getWorkflow` break (M4)

Hard cut — no deprecation aliases.

| Removed / changed | Replacement |
| ----------------- | ----------- |
| `hashTool(code, manifestSansHash)` | `hashCodeTool` / `hashWorkflowTool` (raw digest: internal `hashToolBody`) |
| `verifyToolIntegrity(body: string, ...)` | Overloaded `verifyToolIntegrity(IntegrityBody, narrowed manifest, ...)` |
| `ToolRegistry.get` / `save` | `getCode` / `getWorkflow` / `getKind` / `getManifest` / `saveCode` / `saveWorkflow` |
| `ToolRegistry.getWorkflow(): Promise<Workflow \| null>` | `getWorkflow(): Promise<WorkflowTool \| null>` |
| Flat `Tool` in `types.ts` | `Tool` union from `tool.ts` |

**`getWorkflow` migration (M4):** Every caller that today treats the return value as a `Workflow`
must switch to `.workflow`:

```ts
// before
const wf = await registry.getWorkflow(name);
await this.executor.run(wf, ...);

// after
const tool = await registry.getWorkflow(name);
if (!tool) return toolError("unknown_tool", ...);
await this.executor.run(tool.workflow, ...);
```

Update agent-loop dispatch, e2e tests that assert on the loaded IR, and every `StubRegistry` /
partial mock that implemented `getWorkflow(): Workflow | null`.

Public barrel exports: `CodeKind` (from types), `CodeTool`, `WorkflowTool`, `Tool`, guards,
`hashCodeTool`, `hashWorkflowTool`, `serializeWorkflowBody`, updated `verifyToolIntegrity` /
`ToolRegistry`, `INTEGRITY_STATUS` (incl. `invalid`). Do **not** export `hashToolBody`.

#### 3.6 Rehydrate structural parse + schema prerequisite (M1)

After Link A succeeds on raw `workflow.json` bytes:

1. `JSON.parse` the bytes to `unknown`.
2. Run `parseWorkflow` (Ajv against `WORKFLOW_SCHEMA`).
3. On parse failure: do **not** cache; record `IntegrityIssue` with
   `status: INTEGRITY_STATUS.invalid` and `INTEGRITY_REASON.workflowParseFailed`; continue.
4. On success: cache `WorkflowTool` with the parsed `Workflow`, and retain the raw body string
   privately for the cache entry.

**Prerequisite (same change set, before requiring parse on load):** align `workflow/schema.ts` with
ADR 003 / `SymRef` TypeScript:

- Symref arm of `ARGUMENT_SCHEMA`: allow optional `path` (`type: "string", minLength: 1`).
- `WORKFLOW_RETURN_SCHEMA` `source` object: same optional `path`.
- Keep `additionalProperties: false` otherwise.
- Add/extend parser tests for symrefs with and without `path`.

Without this, `parseWorkflow` would reject valid lifted workflows that project fields (e.g.
`{ kind: "symref", ref: "...", path: "text" }`), and rehydrate would mark them `invalid`.

Higher-level `validate(workflow, registry)` (scope, unknown tools, etc.) stays a create-time /
compose-time check — not required at rehydrate beyond structural parse.

### 4. Call-site migration

#### 4.1 Sandbox call graph — `CodeTool` end-to-end (H7) + Link A

| Symbol | Change |
| ------ | ------ |
| `Sandbox.execute` | `(tool: CodeTool, args, opts?)` |
| `NodePermissionSandbox.execute` | same; **re-verify Link A** on `tool.code` via `hashToolBody` before spawn |
| `PolicyEnforcedSandbox.execute` | `(tool: CodeTool, ...)`; inner execute receives `CodeTool` |
| `ToolFactory.smokeTest` | `(tool: CodeTool, input)` |
| `ToolFactory.draftToTool` / code builder | return `CodeTool` |
| Agent-loop code dispatch | `getCode` once → sandbox (sandbox re-verifies Link A → `permission_denied`) |
| Agent-loop workflow dispatch | `getWorkflow` **once**; same instance for validate → approve → `executor.run(.workflow)` |
| Sandbox tests | `CodeTool` fixtures; Link A mismatch → `permission_denied` |

Workflow tools never enter `Sandbox.execute`.

#### 4.2 Complete migration checklist (H4 + mediums + re-review)

**Prerequisite**

- [ ] `workflow/schema.ts` (+ parser tests) — optional `SymRef.path` / return `source.path`

**Production — core**

- [ ] `types.ts` — add `CodeKind`; remove flat `Tool`; narrow `ToolDraft.kind` to `CodeKind`
- [ ] `tool.ts` — new module: union types + guards (import `CodeKind` from `types.ts`)
- [ ] `hash.ts` — `hashToolBody` (package-internal), `hashCodeTool`, `hashWorkflowTool`,
      `serializeWorkflowBody`; remove `hashTool`
- [ ] `registry/integrity.ts` — kind-tied overloads using `hashToolBody`; `INTEGRITY_STATUS.invalid`;
      kind-mismatch runtime check
- [ ] `registry/tool-registry.ts` — new interface including `getManifest`, `integrityReport`
- [ ] `registry/fs-registry.ts` — explicit get/save; raw-byte Link A via `hashToolBody`;
      `parseWorkflow` after verify (load) and before write (save); retain workflow raw privately;
      drop `workflows` map; defensive clones; delete alternate body on kind-changing save
- [ ] `factory/factory.ts` — `liftSlice` snapshot, `createWorkflow` → `WorkflowTool` + `saveWorkflow`,
      `presentAndSave` → `saveCode`, `smokeTest` (`CodeTool`), `computeEffectivePermissions` via
      `getManifest` (or getKind+get*), draft paths under `CodeKind`
- [ ] `agent/agent-loop.ts` — workflow: single `getWorkflow` for validate/approve/run (`.workflow`);
      code: `getCode` → sandbox; `registeredToolsForTurn` via `getManifest` or body getters
- [ ] `agent/builtins.ts` — `hashCodeTool` + `saveCode`
- [ ] `sandbox/sandbox.ts`, `node-permission-sandbox.ts`, `policy-enforced-sandbox.ts` — `CodeTool`;
      Link A re-verify → `permission_denied`
- [ ] `approval/interface.ts`, `approval/tiered-policy.ts` — `Tool` from `tool.ts`; Gate 1 code
      drafts stay `ToolDraft` with `CodeKind`
- [ ] `workflow/validator.ts` — prefer `getManifest` for callee schema/capabilities
- [ ] `workflow/lift.ts` — `toolsByName: Record<string, Tool>` from `tool.ts`
- [ ] `index-store/hybrid-index.ts` — corpus via `getManifest` (rationale / inputSchema)
- [ ] `testing/tool-fixtures.ts` — see §4.3 fixture/mock migration
- [ ] `schemas.ts` — keep `TOOL_DRAFT_SCHEMA.kind` as atomic/composite only
- [ ] `index.ts` barrel — export public replacements; **omit** `hashToolBody`

**Production — CLI**

- [ ] `cli/src/tools-table.ts` — `loadCatalogRows` via `getManifest` (and approval)
- [ ] `cli/src/repl.ts` — `integrityReport()`; display/handle `invalid` status if formatted
- [ ] Any other CLI registry usage / catalog loading

**Tests / doubles**

- [ ] Schema/parser tests for `path` on symrefs
- [ ] Legacy registry fixture test (L1) — see §4.3 / Testing
- [ ] `registry/fs-registry.test.ts` — minified workflow load; kind-changing save; clone safety;
      `getManifest`; `getWorkflow` → `WorkflowTool`; save rejects unparsable workflow; load marks
      `invalid` (not `quarantined`) when hash ok but schema fails
- [ ] `registry/integrity.test.ts`, `hash.test.ts` — `hashToolBody` used by integrity; not in barrel
- [ ] Sandbox Link A reject when `code` mutated after consistent hash
- [ ] Fixture helpers + all stubs/mocks — see §4.3
- [ ] Remaining suite files listed in §4.3

#### 4.3 Fixture, mock, and legacy-corpus migration (L1, L3)

**Shared test helpers (`packages/core/src/testing/tool-fixtures.ts`)**

- [ ] Replace `makeConsistentTool(manifestSansHash, body: string): Tool` with:
  - `makeConsistentCodeTool(manifestSansHash, code: string): CodeTool` — uses `hashCodeTool`
  - `makeConsistentWorkflowTool(manifestSansHash, workflow: Workflow): WorkflowTool` — uses
    `hashWorkflowTool` / typed IR (never stuff JSON into `code`)
- [ ] Update `makeConsistentApproval(tool: Tool, ...)` to accept the `Tool` union (hash from
      `tool.manifest.hash` only — no `.code` access)
- [ ] Update `testing/tool-fixtures.test.ts` for both helpers + approval pairing with
      `verifyToolIntegrity` overloads
- [ ] Remove or stop exporting `makeConsistentTool`

**Call sites that currently build workflow tools via `code: JSON.stringify(...)` / string body**

- [ ] `agent/agent-loop.test.ts` — `CLOSED_WF_TOOL` and any workflow `makeConsistentTool(..., workflowJson)`
- [ ] `workflow/e2e-lift.test.ts` — `workflowTool = makeConsistentTool(manifest, workflowBody)`;
      `saveWithApproval` / `toolsByName` types; `getWorkflow` → `.workflow`
- [ ] Any other test that passes workflow JSON as the second argument to `makeConsistentTool`

**Call sites that only need code tools** (switch to `makeConsistentCodeTool` + `saveCode`)

- [ ] `agent/agent-loop.test.ts`, `agent/reference-flow.test.ts`, `factory/factory.test.ts`,
      `registry/fs-registry.test.ts`, `e2e.test.ts`, and remaining `makeConsistentTool` imports

**Handwritten `ToolRegistry` stubs / partial mocks** — implement the full new interface
(`getKind`, `getManifest`, `getCode`, `getWorkflow` → `WorkflowTool | null`, `saveCode`,
`saveWorkflow`, `integrityReport`, drop `get`/`save`):

- [ ] `workflow/validator.test.ts` — `fakeRegistry`
- [ ] `workflow/lift.test.ts` — inline registry stub
- [ ] `workflow/reference-lift.e2e.test.ts` — `{ get: ... } as never` partial mock
- [ ] `index-store/hybrid-index.test.ts` — `StubRegistry`
- [ ] `sandbox/policy-enforced-sandbox.test.ts` — inline registry stub
- [ ] `cli/src/repl-tools.test.ts` — `StubRegistry`
- [ ] `cli/src/tools-table.test.ts` — `StubRegistry`
- [ ] `approval/tiered-policy.test.ts` — `mkTool` → real `CodeTool` (not `{ code: "" }` placeholders
      with wrong shapes)

**Other suite files** (compile + behavior under new types/API)

- [ ] `factory/factory.test.ts`, `factory/static-validator.test.ts`
- [ ] `agent/builtins.test.ts`, `agent/meta-tools.test.ts`
- [ ] `sandbox/node-permission-sandbox.test.ts` — Link A re-verify cases
- [ ] `workflow/llm-step.e2e.test.ts`
- [ ] `e2e.test.ts`

**Fixed legacy registry fixture (L1)**

Checked-in directory produced by the **pre-change** on-disk layout (not generated by a new
save/reopen round trip), including at least:

- one atomic/composite entry (`manifest.json` + `tool.ts` + `approval.json`)
- one workflow entry with a **minified** `workflow.json` (single-line / no pretty-print) whose
  `manifest.hash` matches those exact bytes, plus matching `approval.json`

Suggested path: `packages/core/src/registry/fixtures/legacy-registry/` (or equivalent under
`packages/core` test fixtures).

Test requirements:

- [ ] `FsToolRegistry.open(fixtureDir)` loads both entries without quarantine or invalid
- [ ] `integrityReport()` has no quarantined/invalid issues for those names
- [ ] `getWorkflow(name)` returns a `WorkflowTool` whose `.workflow` matches the parsed IR
- [ ] Fixture files are committed as static bytes and not rewritten by the test

### 5. Errors

| Case | Behavior |
| ---- | -------- |
| `getCode` / `getWorkflow` / `getManifest` missing or wrong kind (body getters) | `null` |
| `saveCode` / `saveWorkflow` with mismatched `manifest.kind` | throw |
| `saveWorkflow` fails `parseWorkflow` | throw (no write) |
| `verifyToolIntegrity` body kind vs manifest kind mismatch | `quarantined` / save throws |
| Integrity failure on save (Link A/B) | `RegistryIntegrityError` |
| Rehydrate: Link A fail | `quarantined` (no cache), as today |
| Rehydrate: Link A ok, `parseWorkflow` fail | `invalid` (no cache); report via `integrityReport()` |
| Sandbox Link A re-verify fail | `ToolResult` with `kind: "permission_denied"`; do not spawn |
| Missing tool on dispatch | `unknown_tool` `ToolResult` |

### 6. Documentation

- Update `docs/repo_structure.md` and `docs/meta-tool-design.md` for `tool.ts`, `CodeKind` in
  `types.ts`, the union, explicit registry API, `getManifest`, raw-byte load vs new-save
  serialization, execution Link A, and `invalid` status.
- Add ADR `docs/adrs/009-tool-discriminated-union.md` covering the above plus public API breaks
  (`getWorkflow` → `WorkflowTool`, `hashTool` removal, internal `hashToolBody`). Assumes ADR 003,
  004, 005.
- Note in ADR 004 (brief) that ADR 009 extends integrity statuses with `invalid`.

---

## Testing

**Unit / focused**

- `hashCodeTool` / `hashWorkflowTool` / `hashToolBody`; `serializeWorkflowBody` for new saves;
  exact-byte write on `saveWorkflow`.
- `hashToolBody` importable from `hash.ts` inside the package; absent from public barrel exports.
- Load: **minified** and pretty-printed workflow bodies with matching hashes both load; parse→
  reserialize must not be used for Link A.
- **Legacy fixture (L1):** open the checked-in pre-change registry directory; workflow + code
  entries load without quarantine/invalid.
- Rehydrate: structurally invalid workflow JSON → `invalid` (not `quarantined`) when Link A would
  pass; after schema fix, valid `path` symrefs load.
- `saveWorkflow` rejects objects that fail `parseWorkflow`.
- Integrity overloads + kind mismatch; Link B unchanged.
- Registry: `getManifest`; cross-kind get → `null`; kind-changing save leaves only one body file;
  `integrityReport`; defensive clones; `getWorkflow` returns `WorkflowTool` with `.workflow`.
- Sandbox: mutating `code` on a consistent `CodeTool` before `execute` → `permission_denied`.
- Workflow dispatch: one `getWorkflow` feeds approval and execution (same `manifest.hash` / IR);
  no second fetch between them.
- `ToolDraft` / Gate 1 / static validation reject workflow-kind drafts.
- Fixture helpers per §4.3; no `code: JSON.stringify(workflow)`.

**Regression**

- Full §4.2 / §4.3 checklist; agent-loop workflow path uses `.workflow`; sandbox `CodeTool` graph
  green; all stubs implement the new registry surface.

**Verification**

```bash
npm run typecheck
npm test
```

---

## Success criteria

1. No production path treats workflow IR as `tool.code`.
2. Public `ToolRegistry` has no polymorphic `get` / `save`; includes `getManifest` and
   `integrityReport()`.
3. Public hashing is kind-specific; `hashTool` removed; `hashToolBody` exists package-internally
   and is not barrel-exported.
4. In-memory workflow entries hold `workflow: Workflow`, not `code: ""`.
5. Load-time Link A uses raw file bytes for any previously hashed formatting; new saves use
   `serializeWorkflowBody`.
6. Rehydrate runs `parseWorkflow` after Link A; schema accepts `SymRef.path`; parse failures use
   `INTEGRITY_STATUS.invalid`.
7. `saveWorkflow` rejects workflows that fail `parseWorkflow`.
8. `ToolDraft.kind` is `CodeKind` end-to-end; `CodeKind` is defined in `types.ts`.
9. Kind-changing save removes the alternate body file.
10. Registry getters are cache-safe (clones); code execution re-verifies Link A as
    `permission_denied`; workflow dispatch uses one `WorkflowTool` for validate/approve/run.
11. `getWorkflow` callers use `WorkflowTool.workflow`.
12. `tool.ts` owns the registered-tool union; barrel exports updated.
13. Checked-in legacy registry fixture (including minified workflow body) opens without
    quarantine/invalid.
14. `docs/repo_structure.md` and `docs/meta-tool-design.md` updated for the new model/API.
15. ADR `docs/adrs/009-tool-discriminated-union.md` written; ADR 004 notes `invalid` extension.
16. Fixture/mock migration in §4.3 complete (`makeConsistentApproval`, workflow fixtures, all stubs).
17. `npm run typecheck` and `npm test` pass.

---

## Implementation notes

- Order: schema `path` fix → `CodeKind` in `types.ts` + `tool.ts` → `hashToolBody` / public hash
  helpers / integrity statuses → registry → sandbox Link A (`permission_denied`) + single-fetch
  workflow dispatch → call sites/tests (§4.3) → docs/ADR.
- Capture the L1 legacy fixture from the **current** implementation (or hand-author bytes that match
  today's `hashTool` digest) **before** switching save paths, so the corpus is genuinely pre-change.
- Prefer the §4.2 / §4.3 checklists over discovering work solely via compile errors.
- Do not commit during this work unless the operator explicitly asks later.
