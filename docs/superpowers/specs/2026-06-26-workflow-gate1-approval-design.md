# Workflow Gate 1 Approval — Design Spec

**Status:** Approved, ready for implementation planning
**Date:** 2026-06-26
**Addresses:** Design review issue H2 — Workflow creation bypasses Gate 1 approval

---

## Problem

`ToolFactory.createWorkflow` lifts a workflow IR from an invocation trace, validates it, then writes a
synthetic `ApprovalRecord` and calls `registry.save` directly — bypassing `ApprovalPolicy.reviewDraft`
entirely. Atomic and composite tools both call `presentAndSave` → `approval.reviewDraft` → human sees
code, permissions, smoke output. Workflow tools skip all of this.

This is a security and governance gap: workflow tools carry bubbled permissions from all their step
dependencies and become persistent, reusable registry entries — exactly the context where human review
is most important.

---

## Goals

1. Route `createWorkflow` through `ApprovalPolicy.reviewDraft` — all tool kinds go through Gate 1.
2. Give the reviewer a meaningful workflow-specific payload (IR rendering, effective permissions, input schema).
3. Allow lightweight editing of name and description at approval time.
4. No change to the atomic/composite approval flow beyond the updated signature.
5. Move the `console.log` presentation out of `ToolFactory` (core) and into the CLI prompter.

---

## Non-Goals

- Editing the workflow IR or step wiring at Gate 1 (too complex; reject and re-compose instead).
- Smoke-testing workflows at Gate 1 (workflow execution is deterministic over pre-approved steps; no new code is generated).
- Gate 2/3 changes for workflow execution (separate issue H3).

---

## Design

### 1. New types in `packages/core/src/approval/interface.ts`

#### `Gate1ReviewPayload` — discriminated union input to `reviewDraft`

```ts
import type { Permissions, ToolDraft, ToolManifest, ToolResult } from "../types.ts";
import type { Workflow } from "../workflow/types.ts";

export type CodeGate1Payload = {
  kind: "code";
  draft: ToolDraft;
  smoke: ToolResult;
};

export type WorkflowGate1Payload = {
  kind: "workflow";
  workflow: Workflow;
  manifest: ToolManifest;            // name, description, inputSchema, hash, permissions
  effectivePermissions: Permissions; // union of all step deps' permissions
  literateRendering: string;         // output of renderLiterate(workflow)
};

export type Gate1ReviewPayload = CodeGate1Payload | WorkflowGate1Payload;
```

#### `Gate1Decision` — fully discriminated by kind

```ts
export type CodeGate1Decision =
  | { kind: "code"; decision: "approve"; alwaysApprove: boolean;
      notes?: string; editedDraft?: ToolDraft }
  | { kind: "code"; decision: "reject"; reason: string };

export type WorkflowGate1Decision =
  | { kind: "workflow"; decision: "approve"; alwaysApprove: boolean;
      notes?: string; editedName?: string; editedDescription?: string }
  | { kind: "workflow"; decision: "reject"; reason: string };

export type Gate1Decision = CodeGate1Decision | WorkflowGate1Decision;
```

The `kind` discriminator enables exhaustive TypeScript switch statements at every call site —
factory, tiered-policy, and CLI prompter all switch on `payload.kind` or `decision.kind`.

#### Updated signatures

```ts
export interface ApprovalPrompter {
  promptGate1(payload: Gate1ReviewPayload): Promise<Gate1Decision>;
  promptGate23(tool: Tool, args: unknown, tier: RiskTier): Promise<ExecutionDecision>;
}

export interface ApprovalPolicy {
  reviewDraft(payload: Gate1ReviewPayload): Promise<Gate1Decision>;
  checkExecution(tool: Tool, args: unknown, approval: ApprovalRecord | null): Promise<ExecutionDecision>;
  readonly yolo: boolean;
}
```

---

### 2. New helper: `unionPermissions` in `packages/core/src/permissions-normalize.ts`

```ts
export function unionPermissions(perms: Permissions[]): Permissions {
  // net: "allowlist" wins over "none"
  // netAllowlist: deduplicated union
  // fsRead, fsWrite, env: deduplicated union of all paths/vars
}
```

Unit-tested independently. Used by `createWorkflow` to compute `effectivePermissions` by calling
`unionPermissions` over the manifests of all step tools referenced in `workflow.steps`. The factory
already loads these tools into `toolsByName` during `liftSlice`; `createWorkflow` reuses that map
to collect the permission sets before building the review payload.

---

### 3. Factory changes (`packages/core/src/factory/factory.ts`)

#### `createWorkflow` — add Gate 1 review before save

```
lift → parameterize → validate
  → compute effectivePermissions (unionPermissions over all step dep manifests)
  → build WorkflowGate1Payload { kind: 'workflow', workflow, manifest, effectivePermissions, literateRendering }
  → approval.reviewDraft(payload)                 ← NEW: blocks for human input
  → on reject: log tool-rejected, return { ok: false }
  → on approve: apply editedName / editedDescription if present, recompute hash
  → registry.save(tool, approval)
  → log tool-created
```

The `console.log` calls that currently print the workflow IR and literal fallbacks are removed from
`createWorkflow`. That presentation moves to `ApprovalTui.promptGate1` in the CLI.

#### `presentAndSave` (code tool path) — wrap into `CodeGate1Payload`

```ts
// Before:
const decision = await this.opts.approval.reviewDraft(draft, smoke);

// After:
const decision = await this.opts.approval.reviewDraft({ kind: "code", draft, smoke });
// decision narrowed to CodeGate1Decision inside the switch
```

No other logic changes in `presentAndSave`.

---

### 4. Policy changes (`packages/core/src/approval/tiered-policy.ts`)

`TieredApprovalPolicy.reviewDraft` switches on `payload.kind`:

```ts
async reviewDraft(payload: Gate1ReviewPayload): Promise<Gate1Decision> {
  if (this.yolo) {
    if (payload.kind === "code") {
      return { kind: "code", decision: "approve", alwaysApprove: true, notes: "yolo" };
    }
    return { kind: "workflow", decision: "approve", alwaysApprove: false, notes: "yolo" };
  }
  return this.prompter.promptGate1(payload);
}
```

`alwaysApprove: false` for yolo workflow approvals — workflow tools typically don't benefit from session
caching (they execute through `WorkflowExecutor`, not the sandbox, so Gate 2/3 semantics differ).

---

### 5. CLI changes (`packages/cli/src/approval-tui.ts`)

`ApprovalTui.promptGate1(payload: Gate1ReviewPayload): Promise<Gate1Decision>` branches on `payload.kind`:

**`kind === "code"`** — unchanged from today:
renders name, description, rationale, permissions (elevated items highlighted), full TypeScript code,
smoke test input and output. Actions: approve / reject / edit-and-approve.

**`kind === "workflow"`** — new:
```
=== Workflow Review: <name> ===
Description: <manifest.description>

--- Effective Permissions ---
<effectivePermissions rendered with risk-tier highlights, same style as code tool permissions>

--- Input Schema ---
<manifest.inputSchema rendered as parameter list>

--- Workflow Steps ---
<literateRendering — multiline step-by-step description>

Actions: [a]pprove  [r]eject  [e]dit name/description
```

On edit: prompt for new name (blank = keep current), new description (blank = keep current).
Return `{ kind: "workflow", decision: "approve", alwaysApprove, editedName?, editedDescription? }`.

---

### 6. Compose command changes (`packages/cli/src/compose.ts`)

No structural changes needed. The `console.log` calls that print the lifted workflow IR and the
remaining literal fallbacks live inside `factory.ts/createWorkflow` (not in compose.ts) and are
removed as part of Section 3. The literal fallback display that already exists in `compose.ts`
(from `previewWorkflow`, before parameterization) is kept — it is part of the parameterization UX
and happens before approval.

The flow stays:

1. Collect slice / name / intent / description (readline — unchanged).
2. `previewWorkflow` → show literal fallbacks, collect promotions (unchanged — this preview remains useful
   for the parameterization step before approval).
3. `createWorkflow` → factory handles lift, validate, approval, save, trace.
4. Report `out.ok ? "created workflow '<name>'" : "rejected: <reason>"`.

The composition UX is preserved; the approval prompt now appears between step 3 and step 4.

---

### 7. Data flow diagram

```
runComposeInteraction (CLI)
  │
  ├─ previewWorkflow(req) → { workflow, literalFallbacks }
  │    [shows fallbacks, collects promotions]
  │
  └─ createWorkflow(req)
       │
       ├─ liftSlice + parameterize + validateWorkflow
       ├─ unionPermissions(deps) → effectivePermissions
       ├─ renderLiterate(workflow) → literateRendering
       ├─ approval.reviewDraft({ kind: 'workflow', ... })  ← Gate 1 (NEW)
       │    ├─ yolo → auto-approve
       │    └─ non-yolo → ApprovalTui.promptGate1(payload)
       │         └─ user: approve / reject / edit name+desc
       ├─ apply editedName/editedDescription if any, recompute hash
       ├─ registry.save(tool, approvalRecord)
       └─ tracer.log(tool-created)
```

---

## Call site impact

| File | Change |
|---|---|
| `approval/interface.ts` | New types; updated `reviewDraft`/`promptGate1` signatures |
| `approval/tiered-policy.ts` | `reviewDraft` switches on `payload.kind`; yolo returns correct kind |
| `permissions-normalize.ts` | New `unionPermissions` helper |
| `factory/factory.ts` | `createWorkflow` calls `reviewDraft`; `presentAndSave` wraps into `CodeGate1Payload` |
| `cli/approval-tui.ts` | `promptGate1` branches on `payload.kind`; new workflow rendering |
| `cli/compose.ts` | No changes needed |

---

## Testing

### Unit — `factory.test.ts`

- `createWorkflow` with approve mock → assert `reviewDraft` called with `{ kind: 'workflow', effectivePermissions, literateRendering }`.
- `createWorkflow` with reject mock → assert `{ ok: false }` returned and `tool-rejected` logged.
- `createWorkflow` approve with `editedName` → assert saved manifest uses edited name and hash is recomputed.
- Existing atomic/composite tests → mock `reviewDraft` receives `{ kind: 'code', draft, smoke }`; update assertions.

### Unit — `tiered-policy.test.ts`

- Non-yolo `reviewDraft({ kind: 'workflow', ... })` → delegates to `prompter.promptGate1`.
- Yolo `reviewDraft({ kind: 'workflow', ... })` → returns `{ kind: 'workflow', decision: 'approve' }` without calling prompter.
- Yolo `reviewDraft({ kind: 'code', ... })` → returns `{ kind: 'code', decision: 'approve', alwaysApprove: true }`.

### Unit — `permissions-normalize.test.ts`

- `unionPermissions`: net `none` + `allowlist` → `allowlist`.
- `unionPermissions`: env var deduplication.
- `unionPermissions`: fsRead/fsWrite path deduplication.

### Integration

Existing e2e fixtures use mocked approval; update mock signatures to pass `Gate1ReviewPayload` and return discriminated `Gate1Decision`.

---

## Open questions

None — all decisions resolved during brainstorming.
