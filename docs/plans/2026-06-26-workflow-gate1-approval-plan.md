# Workflow Gate 1 Approval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route `ToolFactory.createWorkflow` through `ApprovalPolicy.reviewDraft` so workflow tools require the same human Gate 1 review as atomic/composite tools, using a discriminated `Gate1ReviewPayload` union.

**Architecture:** Add a `Gate1ReviewPayload = CodeGate1Payload | WorkflowGate1Payload` union and a matching `Gate1Decision = CodeGate1Decision | WorkflowGate1Decision` union to `approval/interface.ts`. Update `TieredApprovalPolicy.reviewDraft` and `CliApprovalPrompter.promptGate1` to branch on `payload.kind`. In `createWorkflow`, compute `effectivePermissions` by unioning all step-dependency permissions and call `reviewDraft` before saving.

**Tech Stack:** Node.js ≥ 25, TypeScript with `--experimental-transform-types`, `node:test` + `node:assert/strict` for tests. Run tests with `npm test -w @meta-agent/core` and `npm test -w @meta-agent/cli`.

**Spec:** `docs/superpowers/specs/2026-06-26-workflow-gate1-approval-design.md`

> **Note on commits:** Do not commit automatically — commits are done manually by the repo owner.

---

## File Map

| File | Change |
|---|---|
| `packages/core/src/permissions-normalize.ts` | Add `unionPermissions` export |
| `packages/core/src/permissions-normalize.test.ts` | Add `unionPermissions` tests |
| `packages/core/src/workflow/lift.ts` | Replace private `unionPermissions`+`unionStrings` with import of shared export |
| `packages/core/src/approval/interface.ts` | New payload/decision union types; updated `reviewDraft`/`promptGate1` signatures |
| `packages/core/src/index.ts` | Export new approval payload/decision types consumed by CLI |
| `packages/core/src/approval/tiered-policy.ts` | `reviewDraft` switches on `payload.kind` |
| `packages/core/src/approval/tiered-policy.test.ts` | Add `reviewDraft` behavior tests |
| `packages/core/src/factory/factory.ts` | `presentAndSave` wraps into `CodeGate1Payload`; `createWorkflow` calls `reviewDraft`, removes `console.log` |
| `packages/core/src/factory/factory.test.ts` | Update prompter mocks; add workflow approval tests |
| `packages/core/src/e2e.test.ts` | Update two `promptGate1` mocks to return `{ kind: "code", ... }` |
| `packages/cli/src/approval-display.ts` | Add `formatWorkflowInputSchema` |
| `packages/cli/src/approval-display.test.ts` | Add test for `formatWorkflowInputSchema` |
| `packages/cli/src/approval-format.ts` | Add `editMeta` key, `formatGate1WorkflowHeader`, `formatGate1WorkflowChoicePrompt` |
| `packages/cli/src/approval-format.test.ts` | Add tests for new format functions |
| `packages/cli/src/approval-tui.ts` | `promptGate1` branches on `payload.kind`; new `promptGate1Workflow` private method |
| `packages/cli/src/approval-tui.test.ts` | New file — behavior tests for `promptGate1` workflow flows |

---

## Task 1: `unionPermissions` helper

**Files:**
- Modify: `packages/core/src/permissions-normalize.ts`
- Modify: `packages/core/src/permissions-normalize.test.ts`

- [ ] **Step 1: Write failing tests**

Add to the bottom of `packages/core/src/permissions-normalize.test.ts` (the `import` at the top of the file already imports `normalizePermissions`; add `unionPermissions` to that same import line):

```ts
import { normalizePermissions, unionPermissions } from "./permissions-normalize.ts";
```

Then append these tests at the bottom of the file:

```ts
test("unionPermissions: empty array returns deny-all defaults", () => {
  assert.deepEqual(unionPermissions([]), {
    fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [],
  });
});

test("unionPermissions: allowlist net wins over none", () => {
  const result = unionPermissions([
    { fsRead: [], fsWrite: [], net: "none",      netAllowlist: [],                  env: [] },
    { fsRead: [], fsWrite: [], net: "allowlist", netAllowlist: ["api.example.com"], env: [] },
  ]);
  assert.equal(result.net, "allowlist");
  assert.deepEqual(result.netAllowlist, ["api.example.com"]);
});

test("unionPermissions: deduplicates fsRead paths", () => {
  const result = unionPermissions([
    { fsRead: ["/a", "/b"], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    { fsRead: ["/b", "/c"], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  ]);
  assert.deepEqual([...result.fsRead].sort(), ["/a", "/b", "/c"]);
});

test("unionPermissions: deduplicates fsWrite paths", () => {
  const result = unionPermissions([
    { fsRead: [], fsWrite: ["/tmp"], net: "none", netAllowlist: [], env: [] },
    { fsRead: [], fsWrite: ["/tmp"], net: "none", netAllowlist: [], env: [] },
  ]);
  assert.deepEqual(result.fsWrite, ["/tmp"]);
});

test("unionPermissions: deduplicates env vars across inputs", () => {
  const result = unionPermissions([
    { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: ["VAR_A", "VAR_B"] },
    { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: ["VAR_B", "VAR_C"] },
  ]);
  assert.deepEqual([...result.env].sort(), ["VAR_A", "VAR_B", "VAR_C"]);
});

test("unionPermissions: two allowlist inputs dedup netAllowlist hosts", () => {
  const result = unionPermissions([
    { fsRead: [], fsWrite: [], net: "allowlist", netAllowlist: ["a.com", "b.com"], env: [] },
    { fsRead: [], fsWrite: [], net: "allowlist", netAllowlist: ["b.com", "c.com"], env: [] },
  ]);
  assert.deepEqual([...result.netAllowlist].sort(), ["a.com", "b.com", "c.com"]);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -w @meta-agent/core -- --test-name-pattern "unionPermissions"
```

Expected: `ReferenceError: unionPermissions is not defined` (or similar import error).

- [ ] **Step 3: Implement `unionPermissions`**

Add to the bottom of `packages/core/src/permissions-normalize.ts`:

```ts
/**
 * Returns the union of multiple permission sets.
 * - `net`: `"allowlist"` wins over `"none"` (any network permission propagates).
 * - All path/host/env string arrays are deduplicated across all inputs.
 * - An empty input array returns deny-all defaults.
 */
export function unionPermissions(perms: Permissions[]): Permissions {
  if (perms.length === 0) {
    return { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] };
  }
  const net = perms.some((p) => p.net === "allowlist") ? "allowlist" : "none";
  const dedup = (...arrs: string[][]): string[] => [...new Set(arrs.flat())];
  return {
    net,
    fsRead:      dedup(...perms.map((p) => p.fsRead)),
    fsWrite:     dedup(...perms.map((p) => p.fsWrite)),
    netAllowlist: dedup(...perms.map((p) => p.netAllowlist)),
    env:         dedup(...perms.map((p) => p.env)),
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -w @meta-agent/core -- --test-name-pattern "unionPermissions"
```

Expected: all 6 `unionPermissions` tests pass.

- [ ] **Step 5: Run full core test suite to confirm no regressions**

```bash
npm test -w @meta-agent/core
```

Expected: all tests pass.

- [ ] **Step 6: Replace the private `unionPermissions`+`unionStrings` in `workflow/lift.ts` with the shared export [L1]**

`packages/core/src/workflow/lift.ts` contains a private `unionPermissions` (lines ~235–244) and `unionStrings` (lines ~247–249) that duplicate what was just added as an export. Remove both private functions and import the shared one instead.

1. Add `unionPermissions` to the import from `../permissions-normalize.ts` at the top of `lift.ts` (it currently imports `normalizePermissions`):

```ts
import { normalizePermissions, unionPermissions } from "../permissions-normalize.ts";
```

2. Delete the private `unionPermissions` function block (~8 lines starting with `function unionPermissions`).

3. Delete the private `unionStrings` function block (~3 lines starting with `function unionStrings`).

The one call site inside `lift.ts` already matches the shared function's signature:
```ts
const permissions = unionPermissions(dependencies.map((d) => req.toolsByName[d]!.manifest.permissions));
```
No change needed at the call site.

> **Behavioral note:** the private `unionStrings` sorted its output (`Array.from(new Set([...])).sort()`); the shared `unionPermissions` preserves insertion order. Permissions are checked as sets (not sequences), so this has no correctness impact.

- [ ] **Step 7: Run typecheck + tests to confirm lift.ts change is clean**

```bash
npm run typecheck && npm test -w @meta-agent/core
```

Expected: all tests pass; no typecheck errors.

---

## Task 2: New approval types + updated signatures across all consumers

This task changes `approval/interface.ts` types and fixes all immediate type errors in consuming files. At the end of this task `npm run typecheck && npm test` both pass. No new behavior is introduced — the yolo code-path returns the new `{ kind: "code", ... }` shape, and the existing `reviewDraft` non-yolo path delegates to `prompter.promptGate1(payload)` which is updated in the CLI in Task 5.

**Files:**
- Modify: `packages/core/src/approval/interface.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/approval/tiered-policy.ts`
- Modify: `packages/core/src/factory/factory.ts`
- Modify: `packages/core/src/factory/factory.test.ts`
- Modify: `packages/core/src/e2e.test.ts`
- Modify: `packages/cli/src/approval-tui.ts`

- [ ] **Step 1: Update `packages/core/src/approval/interface.ts`**

Replace the entire file content with:

```ts
import type { ApprovalRecord, ApprovalToken, Permissions, Tool, ToolDraft, ToolManifest, ToolResult } from "../types.ts";
import type { Workflow } from "../workflow/types.ts";

/** Discriminator values for {@link Gate1Decision} and {@link ExecutionDecision}. */
export const APPROVAL_DECISION = {
  approve: "approve",
  reject: "reject",
} as const;

/**
 * Gate 1 review payload for a code-generated tool (atomic or composite).
 * Carries the full ToolDraft and the sandboxed smoke-test result shown to the reviewer.
 */
export type CodeGate1Payload = {
  kind: "code";
  draft: ToolDraft;
  smoke: ToolResult;
};

/**
 * Gate 1 review payload for a deterministically lifted workflow tool.
 * Carries the workflow IR, its manifest, the unioned effective permissions of all steps,
 * and a human-readable literate rendering of the workflow.
 */
export type WorkflowGate1Payload = {
  kind: "workflow";
  workflow: Workflow;
  /** Manifest produced by the lifter (name, description, inputSchema, hash, permissions). */
  manifest: ToolManifest;
  /** Union of all step-dependency permissions (bubbled-up set shown to reviewer). */
  effectivePermissions: Permissions;
  /** Output of `renderLiterate(workflow)` — step-by-step human-readable description. */
  literateRendering: string;
};

/** Discriminated union of Gate 1 review payloads. Passed to {@link ApprovalPolicy.reviewDraft}. */
export type Gate1ReviewPayload = CodeGate1Payload | WorkflowGate1Payload;

/**
 * Gate 1 decision returned for a code tool.
 * - approve: optionally always-approve future executions; optionally carry an edited draft.
 * - reject: reason shown to the agent.
 */
export type CodeGate1Decision =
  | { kind: "code"; decision: typeof APPROVAL_DECISION.approve; alwaysApprove: boolean; notes?: string; editedDraft?: ToolDraft }
  | { kind: "code"; decision: typeof APPROVAL_DECISION.reject; reason: string };

/**
 * Gate 1 decision returned for a workflow tool.
 * - approve: optionally always-approve; optionally carry edited name/description.
 * - reject: reason shown to the agent.
 */
export type WorkflowGate1Decision =
  | { kind: "workflow"; decision: typeof APPROVAL_DECISION.approve; alwaysApprove: boolean; notes?: string; editedName?: string; editedDescription?: string }
  | { kind: "workflow"; decision: typeof APPROVAL_DECISION.reject; reason: string };

/** Discriminated union of Gate 1 decisions. Returned from {@link ApprovalPolicy.reviewDraft}. */
export type Gate1Decision = CodeGate1Decision | WorkflowGate1Decision;

/**
 * Represents the possible outcomes of an execution approval decision (Gate 2/3).
 *
 * - If `decision` is `"approve"`:
 *    - `token`: An {@link ApprovalToken} that authorizes the tool execution.
 *    - `cacheForSession`: If true, the approval decision may be cached for the session.
 *
 * - If `decision` is `"reject"`:
 *    - `reason`: Explanation for rejection.
 */
export type ExecutionDecision =
  | { decision: typeof APPROVAL_DECISION.approve; token: ApprovalToken; cacheForSession: boolean }
  | { decision: typeof APPROVAL_DECISION.reject; reason: string };

/** Risk levels for execution prompts (promptGate23). */
export const RISK_TIER = {
  low: "low",
  medium: "medium",
  elevated: "elevated",
} as const;

export type RiskTier = (typeof RISK_TIER)[keyof typeof RISK_TIER];

/**
 * Interface for orchestrating approval prompts at different gates of the tool execution lifecycle.
 */
export interface ApprovalPrompter {
  /**
   * Prompt the user for review and approval at Gate 1 (tool creation).
   *
   * @param payload - Discriminated union: code draft + smoke result, or workflow IR + permissions.
   * @returns A Promise resolving to a {@link Gate1Decision} whose `kind` matches `payload.kind`.
   */
  promptGate1(payload: Gate1ReviewPayload): Promise<Gate1Decision>;

  /**
   * Prompt the user (or approval agent) for approval before executing a tool (Gate 2/3).
   */
  promptGate23(tool: Tool, args: unknown, tier: RiskTier): Promise<ExecutionDecision>;
}

/**
 * Interface defining the policy logic for tool approval and execution gating.
 */
export interface ApprovalPolicy {
  /**
   * Review a tool creation payload at Gate 1.
   *
   * @param payload - Discriminated union describing the tool being reviewed.
   * @returns A Promise resolving to a {@link Gate1Decision} whose `kind` matches `payload.kind`.
   */
  reviewDraft(payload: Gate1ReviewPayload): Promise<Gate1Decision>;

  /**
   * Check if a tool execution should be permitted at runtime (Gate 2/3).
   */
  checkExecution(tool: Tool, args: unknown, approval: ApprovalRecord | null): Promise<ExecutionDecision>;

  /**
   * If true, the policy auto-approves everything (yolo mode).
   */
  readonly yolo: boolean;
}
```

- [ ] **Step 1b: Export new approval types from `packages/core/src/index.ts` [H1]**

The CLI imports `CodeGate1Payload`, `WorkflowGate1Payload`, `Gate1ReviewPayload`, `CodeGate1Decision`, and `WorkflowGate1Decision` from `@meta-agent/core`. The package entrypoint `packages/core/src/index.ts` currently only exports `ApprovalPolicy`, `ApprovalPrompter`, `Gate1Decision`, `ExecutionDecision`, and `RiskTier`. Without this step, `npm run typecheck` will fail in the CLI package.

Replace the existing approval type export line in `index.ts`:

```ts
// Before:
export type { ApprovalPolicy, ApprovalPrompter, Gate1Decision, ExecutionDecision, RiskTier } from "./approval/interface.ts";

// After:
export type {
  ApprovalPolicy,
  ApprovalPrompter,
  CodeGate1Decision,
  CodeGate1Payload,
  ExecutionDecision,
  Gate1Decision,
  Gate1ReviewPayload,
  RiskTier,
  WorkflowGate1Decision,
  WorkflowGate1Payload,
} from "./approval/interface.ts";
```

- [ ] **Step 2: Update `TieredApprovalPolicy.reviewDraft` signature and yolo branch**

In `packages/core/src/approval/tiered-policy.ts`, replace the `reviewDraft` method:

```ts
async reviewDraft(payload: Gate1ReviewPayload): Promise<Gate1Decision> {
  if (this.yolo) {
    if (payload.kind === "code") {
      return { kind: "code", decision: APPROVAL_DECISION.approve, alwaysApprove: true, notes: "yolo" };
    }
    return { kind: "workflow", decision: APPROVAL_DECISION.approve, alwaysApprove: false, notes: "yolo" };
  }
  return this.prompter.promptGate1(payload);
}
```

Add the new imports at the top of `tiered-policy.ts` (update the existing import from `./interface.ts`):

```ts
import {
  APPROVAL_DECISION,
  type ApprovalPolicy,
  type ApprovalPrompter,
  type ExecutionDecision,
  type Gate1Decision,
  type Gate1ReviewPayload,
  RISK_TIER,
  type RiskTier,
} from "./interface.ts";
```

- [ ] **Step 3: Update `ToolFactory.presentAndSave` to wrap into `CodeGate1Payload`**

In `packages/core/src/factory/factory.ts`, find `presentAndSave` and update the `reviewDraft` call and the decision handling.

Replace the body of `presentAndSave` with:

```ts
private async presentAndSave(draft: ToolDraft, smoke: ToolResult): Promise<FactoryOutcome> {
  const decision = await this.opts.approval.reviewDraft({ kind: "code", draft, smoke });
  if (decision.kind !== "code") {
    return { ok: false, reason: "unexpected decision kind from Gate 1 review" };
  }
  if (decision.decision === APPROVAL_DECISION.reject) {
    this.opts.tracer.log(TRACE_KIND_TOOL_REJECTED, { name: draft.name, reason: decision.reason });
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
  this.opts.tracer.log(TRACE_KIND_TOOL_CREATED, { name: tool.manifest.name, hash: tool.manifest.hash, approvedBy: this.approvedBy });
  return { ok: true, tool, approval };
}
```

Also add `Gate1ReviewPayload` to the imports from `../approval/interface.ts` in `factory.ts`:

```ts
import { APPROVAL_DECISION, type ApprovalPolicy } from "../approval/interface.ts";
```

becomes:

```ts
import { APPROVAL_DECISION, type ApprovalPolicy, type Gate1ReviewPayload } from "../approval/interface.ts";
```

- [ ] **Step 4: Update `factory.test.ts` prompter mocks to return discriminated decisions**

In `packages/core/src/factory/factory.test.ts`, update every `promptGate1` mock.

The three top-level tests each have an inline `prompter`. Update them:

**Test "happy path — static passes, smoke passes, approval auto-approves":**
```ts
const prompter = {
  promptGate1: async () => ({ kind: "code" as const, decision: APPROVAL_DECISION.approve, alwaysApprove: false }),
  promptGate23: async () => { throw new Error("no"); },
};
```

**Test "static failure triggers repair loop":**
```ts
const prompter = {
  promptGate1: async () => ({ kind: "code" as const, decision: APPROVAL_DECISION.approve, alwaysApprove: false }),
  promptGate23: async () => { throw new Error("no"); },
};
```

**Test "rejected by reviewer returns failure":**
```ts
const prompter = {
  promptGate1: async () => ({ kind: "code" as const, decision: APPROVAL_DECISION.reject, reason: "no thanks" }),
  promptGate23: async () => { throw new Error("no"); },
};
```

The `describe("createWorkflow and previewWorkflow")` block has a shared `prompter` in `before()`. Update it to handle both kinds (createWorkflow does not yet call `reviewDraft`, but the type must be correct):

```ts
const prompter = {
  promptGate1: async (payload: Gate1ReviewPayload) => {
    if (payload.kind === "workflow") {
      return { kind: "workflow" as const, decision: APPROVAL_DECISION.approve, alwaysApprove: false };
    }
    return { kind: "code" as const, decision: APPROVAL_DECISION.approve, alwaysApprove: false };
  },
  promptGate23: async () => { throw new Error("no"); },
};
```

Add the import for `Gate1ReviewPayload` at the top of the file:

```ts
import { APPROVAL_DECISION, type Gate1ReviewPayload } from "../approval/interface.ts";
```

- [ ] **Step 5: Update `CliApprovalPrompter.promptGate1` signature in `approval-tui.ts`**

In `packages/cli/src/approval-tui.ts`:

1. Add new imports at the top (update the existing `@meta-agent/core` import):

```ts
import {
  APPROVAL_DECISION,
  type ApprovalPrompter,
  type CodeGate1Payload,
  type ExecutionDecision,
  type Gate1Decision,
  type Gate1ReviewPayload,
  type RiskTier,
  type Tool,
  type ToolDraft,
  type ToolResult,
  type WorkflowGate1Decision,
  type WorkflowGate1Payload,
} from "@meta-agent/core";
```

2. Rename the existing `promptGate1` to `promptGate1Code` (private) and update `printGate1Review` call:

```ts
private async promptGate1Code(payload: CodeGate1Payload): Promise<Gate1Decision> {
  printGate1Review(payload.draft, payload.smoke);
  const answer = (await this.rl.question(formatGate1ChoicePrompt())).trim();
  if (isGate1RejectAnswer(answer)) {
    const reason = (await this.rl.question(theme.meta("Reason: "))).trim() || GATE1_DEFAULT_REJECT_REASON;
    return { kind: "code", decision: APPROVAL_DECISION.reject, reason };
  }
  return {
    kind: "code",
    decision: APPROVAL_DECISION.approve,
    alwaysApprove: isAlwaysApproveAnswer(answer),
  };
}
```

3. Add the new public `promptGate1` that dispatches on `payload.kind` (the workflow branch calls a stub for now — the full implementation is added in Task 5):

```ts
async promptGate1(payload: Gate1ReviewPayload): Promise<Gate1Decision> {
  if (payload.kind === "workflow") {
    return this.promptGate1Workflow(payload);
  }
  return this.promptGate1Code(payload);
}

private async promptGate1Workflow(_payload: WorkflowGate1Payload): Promise<WorkflowGate1Decision> {
  // Full implementation in Task 5. For now: auto-approve so typecheck passes.
  throw new Error("workflow Gate 1 UI not yet implemented");
}
```

- [ ] **Step 5b: Update `e2e.test.ts` prompter mocks to return discriminated decisions [H2]**

`packages/core/src/e2e.test.ts` has two inline `prompter` objects whose `promptGate1` mocks return the old shape `{ decision: ..., alwaysApprove: ... }`. Once `ApprovalPrompter.promptGate1` returns the new `Gate1Decision` discriminated union, these are no longer assignable and `npm run typecheck` fails.

Find both occurrences (around lines 75–76 and 105–106) and update them:

```ts
// Before (appears twice):
promptGate1: async () => ({ decision: APPROVAL_DECISION.approve, alwaysApprove: true }),

// After (applies to both occurrences):
promptGate1: async () => ({ kind: "code" as const, decision: APPROVAL_DECISION.approve, alwaysApprove: true }),
```

- [ ] **Step 6: Run typecheck to confirm all type errors are resolved**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 7: Run tests to confirm nothing regressed**

```bash
npm test -w @meta-agent/core && npm test -w @meta-agent/cli
```

Expected: all tests pass. The `createWorkflow` tests still pass because `createWorkflow` does not yet call `reviewDraft`.

---

## Task 3: `TieredApprovalPolicy.reviewDraft` tests

**Files:**
- Modify: `packages/core/src/approval/tiered-policy.test.ts`

- [ ] **Step 1: Write failing tests for `reviewDraft`**

Add to the bottom of `packages/core/src/approval/tiered-policy.test.ts`:

```ts
import {
  APPROVAL_DECISION,
  RISK_TIER,
  type Gate1ReviewPayload,
  type WorkflowGate1Payload,
} from "./interface.ts";
import { TieredApprovalPolicy, riskTier } from "./tiered-policy.ts";
```

(These imports are already at the top; just extend them.)

Add these tests:

```ts
// --- reviewDraft tests ---

function mkCodePayload(): Gate1ReviewPayload {
  return {
    kind: "code",
    draft: {
      name: "t", description: "d", rationale: "r",
      inputSchema: { type: "object" }, outputShape: { type: "object" },
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      code: "export async function run(i){return i;}",
      dependencies: [], smokeTestInput: {}, kind: "atomic",
    },
    smoke: { ok: true, value: {} },
  };
}

function mkWorkflowPayload(): WorkflowGate1Payload {
  return {
    kind: "workflow",
    workflow: { schemaVersion: 1, name: "wf", description: "d", goal: "g", inputs: [], steps: [], return: null },
    manifest: {
      name: "wf", description: "d", rationale: "",
      inputSchema: { type: "object" }, outputShape: { type: "object" },
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [], limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
      hash: "sha256:" + "a".repeat(64), createdAt: "2026-01-01T00:00:00Z", kind: "workflow",
    },
    effectivePermissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    literateRendering: "Workflow wf:\n  (no steps)",
  };
}

test("reviewDraft non-yolo code: delegates to prompter with code payload", async () => {
  let received: Gate1ReviewPayload | undefined;
  const prompter = {
    promptGate1: async (p: Gate1ReviewPayload) => {
      received = p;
      return { kind: "code" as const, decision: APPROVAL_DECISION.approve, alwaysApprove: false };
    },
    promptGate23: async () => { throw new Error("no"); },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/w" });
  const result = await policy.reviewDraft(mkCodePayload());
  assert.equal(received?.kind, "code");
  assert.equal(result.kind, "code");
  assert.equal(result.decision, APPROVAL_DECISION.approve);
});

test("reviewDraft non-yolo workflow: delegates to prompter with workflow payload", async () => {
  let received: Gate1ReviewPayload | undefined;
  const prompter = {
    promptGate1: async (p: Gate1ReviewPayload) => {
      received = p;
      return { kind: "workflow" as const, decision: APPROVAL_DECISION.approve, alwaysApprove: false };
    },
    promptGate23: async () => { throw new Error("no"); },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/w" });
  const result = await policy.reviewDraft(mkWorkflowPayload());
  assert.equal(received?.kind, "workflow");
  assert.equal(result.kind, "workflow");
  assert.equal(result.decision, APPROVAL_DECISION.approve);
});

test("reviewDraft yolo code: auto-approves without calling prompter, returns kind=code", async () => {
  const prompter = {
    promptGate1: async () => { throw new Error("should not be called"); },
    promptGate23: async () => { throw new Error("no"); },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/w", yolo: true });
  const result = await policy.reviewDraft(mkCodePayload());
  assert.equal(result.kind, "code");
  assert.equal(result.decision, APPROVAL_DECISION.approve);
  if (result.kind === "code" && result.decision === APPROVAL_DECISION.approve) {
    assert.equal(result.alwaysApprove, true);
    assert.equal(result.notes, "yolo");
  }
});

test("reviewDraft yolo workflow: auto-approves without calling prompter, returns kind=workflow", async () => {
  const prompter = {
    promptGate1: async () => { throw new Error("should not be called"); },
    promptGate23: async () => { throw new Error("no"); },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/w", yolo: true });
  const result = await policy.reviewDraft(mkWorkflowPayload());
  assert.equal(result.kind, "workflow");
  assert.equal(result.decision, APPROVAL_DECISION.approve);
  if (result.kind === "workflow" && result.decision === APPROVAL_DECISION.approve) {
    assert.equal(result.alwaysApprove, false);
    assert.equal(result.notes, "yolo");
  }
});
```

- [ ] **Step 2: Run tests to confirm the new ones pass (yolo tests pass; non-yolo pass via delegation)**

```bash
npm test -w @meta-agent/core -- --test-name-pattern "reviewDraft"
```

Expected: all 4 new tests pass. (The behavior was already implemented in Task 2.)

- [ ] **Step 3: Run full core test suite**

```bash
npm test -w @meta-agent/core
```

Expected: all tests pass.

---

## Task 4: `ToolFactory.createWorkflow` — Gate 1 gate

This is the core behavior change: `createWorkflow` now calls `reviewDraft` before saving.

**Files:**
- Modify: `packages/core/src/factory/factory.ts`
- Modify: `packages/core/src/factory/factory.test.ts`

- [ ] **Step 1: Write failing tests for workflow Gate 1 in `factory.test.ts`**

Add new tests inside the `describe("createWorkflow and previewWorkflow")` block (after the existing two tests):

```ts
test("createWorkflow: calls reviewDraft with workflow payload before saving", async () => {
  const slice = [
    { name: "fetch-webpage-text", args: { url: "https://x/p.md" }, ok: true, value: "text" },
  ];
  let capturedPayload: Gate1ReviewPayload | undefined;

  // Rebuild factory with a custom prompter that captures the payload
  const customPrompter = {
    promptGate1: async (p: Gate1ReviewPayload) => {
      capturedPayload = p;
      return { kind: "workflow" as const, decision: APPROVAL_DECISION.approve, alwaysApprove: false };
    },
    promptGate23: async () => { throw new Error("no"); },
  };
  const customApproval = new TieredApprovalPolicy(customPrompter, { workspace: wfDir });
  const customFactory = new ToolFactory({
    llm: new MockLLMProvider(),
    registry: wfRegistry,
    sandbox: new NodePermissionSandbox({ workspace: wfDir }),
    approval: customApproval,
    tracer: await Tracer.open(join(wfDir, "traces"), "s2"),
    tombstoned: new Set(),
  });

  const out = await customFactory.createWorkflow({
    slice, name: "fetch-only", intent: "fetch a url", description: "fetches url",
  });

  assert.equal(out.ok, true);
  assert.ok(capturedPayload, "reviewDraft should have been called");
  assert.equal(capturedPayload?.kind, "workflow");
  if (capturedPayload?.kind === "workflow") {
    assert.equal(capturedPayload.manifest.name, "fetch-only");
    assert.ok(typeof capturedPayload.literateRendering === "string");
    assert.ok(capturedPayload.literateRendering.length > 0);
    // effectivePermissions should include fetch-webpage-text's net:allowlist
    assert.equal(capturedPayload.effectivePermissions.net, "allowlist");
  }
});

test("createWorkflow: returns { ok: false } when reviewer rejects", async () => {
  const slice = [
    { name: "fetch-webpage-text", args: { url: "https://x" }, ok: true, value: "t" },
  ];
  const rejectPrompter = {
    promptGate1: async (p: Gate1ReviewPayload) => {
      if (p.kind === "workflow") {
        return { kind: "workflow" as const, decision: APPROVAL_DECISION.reject, reason: "not today" };
      }
      return { kind: "code" as const, decision: APPROVAL_DECISION.approve, alwaysApprove: false };
    },
    promptGate23: async () => { throw new Error("no"); },
  };
  const rejectApproval = new TieredApprovalPolicy(rejectPrompter, { workspace: wfDir });
  const rejectFactory = new ToolFactory({
    llm: new MockLLMProvider(),
    registry: wfRegistry,
    sandbox: new NodePermissionSandbox({ workspace: wfDir }),
    approval: rejectApproval,
    tracer: await Tracer.open(join(wfDir, "traces"), "s3"),
    tombstoned: new Set(),
  });

  const out = await rejectFactory.createWorkflow({
    slice, name: "rejected-wf", intent: "test", description: "d",
  });

  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.reason, /not today/);
  assert.equal(await wfRegistry.has("rejected-wf"), false);
});

test("createWorkflow: applies editedName from approval decision", async () => {
  const slice = [
    { name: "fetch-webpage-text", args: { url: "https://x/q.md" }, ok: true, value: "text" },
  ];
  const editPrompter = {
    promptGate1: async (p: Gate1ReviewPayload) => {
      if (p.kind === "workflow") {
        return {
          kind: "workflow" as const,
          decision: APPROVAL_DECISION.approve,
          alwaysApprove: false,
          editedName: "renamed-fetch",
        };
      }
      return { kind: "code" as const, decision: APPROVAL_DECISION.approve, alwaysApprove: false };
    },
    promptGate23: async () => { throw new Error("no"); },
  };
  const editApproval = new TieredApprovalPolicy(editPrompter, { workspace: wfDir });
  const editFactory = new ToolFactory({
    llm: new MockLLMProvider(),
    registry: wfRegistry,
    sandbox: new NodePermissionSandbox({ workspace: wfDir }),
    approval: editApproval,
    tracer: await Tracer.open(join(wfDir, "traces"), "s4"),
    tombstoned: new Set(),
  });

  const out = await editFactory.createWorkflow({
    slice, name: "original-name", intent: "test", description: "d",
  });

  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.tool.manifest.name, "renamed-fetch");
  assert.equal(await wfRegistry.has("renamed-fetch"), true);
  assert.equal(await wfRegistry.has("original-name"), false);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -w @meta-agent/core -- --test-name-pattern "createWorkflow"
```

Expected: the 3 new tests fail (`capturedPayload` is undefined / approval never called / renamed tool not found).

- [ ] **Step 3: Update `createWorkflow` in `factory.ts`**

Replace the entire `createWorkflow` method body:

```ts
async createWorkflow(req: CreateWorkflowReq): Promise<FactoryOutcome> {
  const liftResult = await this.liftSlice(req);
  if (!liftResult.ok) {
    return { ok: false, reason: `lift failed: ${liftResult.errors.map((e) => e.message).join("; ")}` };
  }

  let { workflow, manifest } = liftResult;   // literalFallbacks dropped: console.log removed

  if (req.promotions && req.promotions.length > 0) {
    const pr = parameterize(workflow, req.promotions);
    if (!pr.ok) return { ok: false, reason: `parameterize failed: ${pr.errors.map((e) => e.message).join("; ")}` };
    workflow = pr.workflow;
    manifest = { ...manifest, inputSchema: inputSchemaFromInputs(workflow.inputs) };
  }

  const validation = await validateWorkflow(workflow, this.opts.registry);
  if (!validation.ok) {
    return { ok: false, reason: `validation failed: ${validation.errors.map((e) => e.message).join("; ")}` };
  }

  // Compute effective permissions: union over all step-dependency manifests.
  const depNames = [...new Set(workflow.steps.map((s) => s.tool))];
  const depPerms = [];
  for (const name of depNames) {
    const dep = await this.opts.registry.get(name);
    if (dep) depPerms.push(dep.manifest.permissions);
  }
  const effectivePermissions = unionPermissions(depPerms);

  const literateRendering = renderLiterate(workflow);

  // Build the review payload and call Gate 1.
  const payload: WorkflowGate1Payload = {
    kind: "workflow",
    workflow,
    manifest,
    effectivePermissions,
    literateRendering,
  };
  const decision = await this.opts.approval.reviewDraft(payload);

  if (decision.kind !== "workflow") {
    return { ok: false, reason: "unexpected decision kind from Gate 1 review" };
  }
  if (decision.decision === APPROVAL_DECISION.reject) {
    this.opts.tracer.log(TRACE_KIND_TOOL_REJECTED, { name: manifest.name, reason: decision.reason });
    return { ok: false, reason: decision.reason };
  }

  // Apply optional name/description edits from the reviewer.
  const finalName = decision.editedName ?? workflow.name;
  const finalDescription = decision.editedDescription ?? workflow.description;
  const finalWorkflow: typeof workflow = { ...workflow, name: finalName, description: finalDescription };
  const workflowJson = JSON.stringify(finalWorkflow, null, 2);
  const { hash: _liftHash, ...manifestSansHash } = manifest;
  const finalManifest = { ...manifestSansHash, name: finalName, description: finalDescription };
  const tool = this.toolFromManifestAndCode(finalManifest, workflowJson);

  const approval: ApprovalRecord = {
    hash: tool.manifest.hash,
    approvedAt: new Date().toISOString(),
    approvedBy: this.approvedBy,
    alwaysApprove: decision.alwaysApprove,
    ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
  };

  await this.opts.registry.save(tool, approval);
  this.opts.tracer.log(TRACE_KIND_TOOL_CREATED, { name: tool.manifest.name, hash: tool.manifest.hash, approvedBy: this.approvedBy });
  return { ok: true, tool, approval };
}
```

Update the imports at the top of `factory.ts`:

- In the existing `import { APPROVAL_DECISION, type ApprovalPolicy } from "../approval/interface.ts"` line, add `type Gate1ReviewPayload` and `type WorkflowGate1Payload`:

```ts
import { APPROVAL_DECISION, type ApprovalPolicy, type Gate1ReviewPayload, type WorkflowGate1Payload } from "../approval/interface.ts";
```

- Add `unionPermissions` to the existing `permissions-normalize` import (which currently only imports `normalizePermissions`):

```ts
import { normalizePermissions, unionPermissions } from "../permissions-normalize.ts";
```

- [ ] **Step 4: Run the new tests to confirm they pass**

```bash
npm test -w @meta-agent/core -- --test-name-pattern "createWorkflow"
```

Expected: all 5 `createWorkflow` tests pass (2 existing + 3 new).

- [ ] **Step 5: Run full core test suite**

```bash
npm test -w @meta-agent/core
```

Expected: all tests pass.

---

## Task 5: CLI workflow rendering

Add the parameter-list input schema formatter, the new Gate 1 format functions, and the full `promptGate1Workflow` implementation.

**Files:**
- Modify: `packages/cli/src/approval-display.ts`
- Modify: `packages/cli/src/approval-display.test.ts`
- Modify: `packages/cli/src/approval-format.ts`
- Modify: `packages/cli/src/approval-format.test.ts`
- Modify: `packages/cli/src/approval-tui.ts`
- Create: `packages/cli/src/approval-tui.test.ts`

- [ ] **Step 0: Add `formatWorkflowInputSchema` to `approval-display.ts` [M2]**

The spec requires the workflow input schema rendered as a human-readable parameter list, not raw JSON. Add a new exported function to `packages/cli/src/approval-display.ts`:

```ts
/**
 * Formats a workflow's JSON Schema input shape as a human-readable parameter list
 * for Gate 1 approval prompts.
 *
 * @param schema - The `inputSchema` from the workflow manifest (JSON Schema object).
 * @returns ANSI-styled multi-line string listing each declared parameter with type,
 *   required/optional status, and optional description.
 */
export function formatWorkflowInputSchema(schema: Record<string, unknown>): string {
  const header = theme.progressLabel("Inputs");
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  if (!properties || Object.keys(properties).length === 0) {
    return `${header}\n${theme.meta("  (no parameters)")}`;
  }
  const lines = Object.entries(properties).map(([name, prop]) => {
    const typeName = typeof prop.type === "string" ? prop.type : "unknown";
    const req = required.includes(name) ? "required" : "optional";
    const desc = typeof prop.description === "string" ? ` — ${prop.description}` : "";
    return `  ${theme.progressLabel(name + ":")} ${theme.progressBody(typeName)} (${req})${theme.meta(desc)}`;
  });
  return `${header}\n${lines.join("\n")}`;
}
```

Then write a failing test for it in `packages/cli/src/approval-display.test.ts`. Check what the existing test file imports and add to the import and to the file bottom:

```ts
import { formatArgsTable, formatPermissionsTable, formatWorkflowInputSchema } from "./approval-display.ts";
```

```ts
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("formatWorkflowInputSchema: renders parameter name, type, and required status", () => {
  const schema = {
    type: "object",
    properties: {
      url:  { type: "string", description: "the target URL" },
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
```

Run:
```bash
npm test -w @meta-agent/cli -- --test-name-pattern "formatWorkflowInputSchema"
```

Expected: two tests fail (function not yet exported), then implement, then pass.

- [ ] **Step 1: Write failing tests for new format functions**

In `packages/cli/src/approval-format.test.ts`, update the existing import from `./approval-format.ts` to also include the two new functions:

```ts
import {
  formatGate1ChoicePrompt,
  formatGate1Header,
  formatGate1WorkflowChoicePrompt,    // add this
  formatGate1WorkflowHeader,           // add this
  formatGate23ChoicePrompt,
  formatGate23Header,
  formatLabelValue,
} from "./approval-format.ts";
```

Then add at the bottom of the file:

```ts
test("formatGate1WorkflowHeader includes GATE 1 and workflow", () => {
  const plain = stripAnsi(formatGate1WorkflowHeader());
  assert.match(plain, /GATE 1/);
  assert.match(plain, /workflow/i);
});

test("formatGate1WorkflowChoicePrompt includes approve, always-approve, edit, and reject keys", () => {
  const plain = stripAnsi(formatGate1WorkflowChoicePrompt());
  assert.match(plain, /\[a\]/);
  assert.match(plain, /\[A\]/);
  assert.match(plain, /\[e\]/);
  assert.match(plain, /\[r\]/);
  assert.ok(plain.endsWith("? "));
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -w @meta-agent/cli -- --test-name-pattern "formatGate1Workflow"
```

Expected: `ReferenceError: formatGate1WorkflowHeader is not defined`.

- [ ] **Step 3: Add `editMeta` key and new format functions to `approval-format.ts`**

1. Add `editMeta: "e"` to `APPROVAL_CHOICE_KEY`:

```ts
export const APPROVAL_CHOICE_KEY = {
  approve: "a",
  alwaysApprove: "A",
  sessionApprove: "s",
  reject: "r",
  editMeta: "e",
} as const;
```

2. Add two new exported functions after `formatGate1ChoicePrompt`:

```ts
const GATE1_WORKFLOW_HEADER = "GATE 1: Review new workflow";

/**
 * Header line for Gate 1 workflow review.
 *
 * @returns ANSI-colored section header for stderr/console output.
 */
export function formatGate1WorkflowHeader(): string {
  return theme.progressLabel(`\n=== ${GATE1_WORKFLOW_HEADER} ===`);
}

/**
 * Choice prompt for Gate 1 workflow review.
 * Includes an [e]dit name/description option in addition to the standard choices.
 *
 * @returns Colored prompt listing approve, always-approve, edit, and reject keys.
 */
export function formatGate1WorkflowChoicePrompt(): string {
  return `\n${[
    choiceApprove(APPROVAL_CHOICE_KEY.approve, "pprove"),
    CHOICE_SEPARATOR,
    choiceApprove(APPROVAL_CHOICE_KEY.alwaysApprove, "lways-approve", true),
    CHOICE_SEPARATOR,
    theme.progressLabel(`[${APPROVAL_CHOICE_KEY.editMeta}]`) + "dit name/desc",
    CHOICE_SEPARATOR,
    choiceReject("eject"),
    CHOICE_PROMPT_SUFFIX,
  ].join("")}`;
}
```

- [ ] **Step 4: Run format tests to confirm they pass**

```bash
npm test -w @meta-agent/cli -- --test-name-pattern "formatGate1Workflow"
```

Expected: both new tests pass.

- [ ] **Step 5: Implement `promptGate1Workflow` in `approval-tui.ts`**

Replace the stub `promptGate1Workflow` method added in Task 2 with the full implementation. Also update the import to include the new format functions.

1. Update the import from `./approval-format.ts`:

```ts
import {
  APPROVAL_CHOICE_KEY,
  formatGate1ChoicePrompt,
  formatGate1Header,
  formatGate1WorkflowChoicePrompt,
  formatGate1WorkflowHeader,
  formatGate23ChoicePrompt,
  formatGate23Header,
  formatLabelValue,
} from "./approval-format.ts";
```

2. Replace the stub `promptGate1Workflow` with the full method:

```ts
private async promptGate1Workflow(payload: WorkflowGate1Payload): Promise<WorkflowGate1Decision> {
  console.log(formatGate1WorkflowHeader());
  console.log(formatLabelValue("Name", payload.manifest.name));
  console.log(formatLabelValue("Description", payload.manifest.description));
  console.log(formatWorkflowInputSchema(payload.manifest.inputSchema as Record<string, unknown>));
  console.log(formatPermissionsTable(payload.effectivePermissions));
  console.log(theme.meta("\n--- WORKFLOW STEPS ---"));
  console.log(theme.progressBody(payload.literateRendering));
  console.log(theme.meta("--- /WORKFLOW STEPS ---\n"));

  const answer = (await this.rl.question(formatGate1WorkflowChoicePrompt())).trim();

  if (isGate1RejectAnswer(answer)) {
    const reason = (await this.rl.question(theme.meta("Reason: "))).trim() || GATE1_DEFAULT_REJECT_REASON;
    return { kind: "workflow", decision: APPROVAL_DECISION.reject, reason };
  }

  if (answer === APPROVAL_CHOICE_KEY.editMeta || answer === "edit") {
    const rawName = (await this.rl.question(theme.meta(`Name [${payload.manifest.name}]: `))).trim();
    const rawDesc = (await this.rl.question(theme.meta(`Description [${payload.manifest.description}]: `))).trim();
    return {
      kind: "workflow",
      decision: APPROVAL_DECISION.approve,
      alwaysApprove: false,
      ...(rawName ? { editedName: rawName } : {}),
      ...(rawDesc ? { editedDescription: rawDesc } : {}),
    };
  }

  return {
    kind: "workflow",
    decision: APPROVAL_DECISION.approve,
    alwaysApprove: isAlwaysApproveAnswer(answer),
  };
}
```

- [ ] **Step 6: Write and run behavior tests for `CliApprovalPrompter.promptGate1` workflow flows [M1]**

Create `packages/cli/src/approval-tui.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Interface as RlInterface } from "node:readline/promises";
import { CliApprovalPrompter } from "./approval-tui.ts";
import type { WorkflowGate1Payload } from "@meta-agent/core";

/** Minimal fake readline that returns canned answers in order. */
function makeRl(...answers: string[]): RlInterface {
  let i = 0;
  return { question: async (_prompt: string) => answers[i++] ?? "" } as unknown as RlInterface;
}

const WF_PAYLOAD: WorkflowGate1Payload = {
  kind: "workflow",
  workflow: {
    schemaVersion: 1,
    name: "fetch-wf",
    description: "fetches stuff",
    goal: "fetch",
    inputs: [],
    steps: [],
    return: null,
  },
  manifest: {
    name: "fetch-wf",
    description: "fetches stuff",
    rationale: "",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    outputShape: { type: "object" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    hash: "sha256:" + "a".repeat(64),
    createdAt: "2026-01-01T00:00:00Z",
    kind: "workflow",
  },
  effectivePermissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  literateRendering: "Workflow: fetch-wf\n  (no steps)",
};

test("CliApprovalPrompter.promptGate1 workflow [a]: approve, alwaysApprove false, no edits", async () => {
  const p = new CliApprovalPrompter(makeRl("a"));
  const result = await p.promptGate1(WF_PAYLOAD);
  assert.equal(result.kind, "workflow");
  assert.equal(result.decision, "approve");
  if (result.kind === "workflow" && result.decision === "approve") {
    assert.equal(result.alwaysApprove, false);
    assert.equal(result.editedName, undefined);
    assert.equal(result.editedDescription, undefined);
  }
});

test("CliApprovalPrompter.promptGate1 workflow [A]: approve, alwaysApprove true", async () => {
  const p = new CliApprovalPrompter(makeRl("A"));
  const result = await p.promptGate1(WF_PAYLOAD);
  assert.equal(result.kind, "workflow");
  if (result.kind === "workflow" && result.decision === "approve") {
    assert.equal(result.alwaysApprove, true);
  }
});

test("CliApprovalPrompter.promptGate1 workflow [r]: reject with supplied reason", async () => {
  const p = new CliApprovalPrompter(makeRl("r", "bad workflow"));
  const result = await p.promptGate1(WF_PAYLOAD);
  assert.equal(result.kind, "workflow");
  assert.equal(result.decision, "reject");
  if (result.kind === "workflow" && result.decision === "reject") {
    assert.equal(result.reason, "bad workflow");
  }
});

test("CliApprovalPrompter.promptGate1 workflow [e]: approve with editedName, no editedDescription", async () => {
  // answers: 'e' → new name → blank description (keep original)
  const p = new CliApprovalPrompter(makeRl("e", "renamed-wf", ""));
  const result = await p.promptGate1(WF_PAYLOAD);
  assert.equal(result.kind, "workflow");
  assert.equal(result.decision, "approve");
  if (result.kind === "workflow" && result.decision === "approve") {
    assert.equal(result.editedName, "renamed-wf");
    assert.equal(result.editedDescription, undefined);
    assert.equal(result.alwaysApprove, false);
  }
});

test("CliApprovalPrompter.promptGate1 workflow [e]: approve with editedDescription only", async () => {
  // answers: 'e' → blank name (keep original) → new description
  const p = new CliApprovalPrompter(makeRl("e", "", "new description"));
  const result = await p.promptGate1(WF_PAYLOAD);
  assert.equal(result.kind, "workflow");
  assert.equal(result.decision, "approve");
  if (result.kind === "workflow" && result.decision === "approve") {
    assert.equal(result.editedName, undefined);
    assert.equal(result.editedDescription, "new description");
  }
});
```

Run to confirm the stub throws (tests fail), implement the full `promptGate1Workflow` in Step 5, then re-run:

```bash
npm test -w @meta-agent/cli -- --test-name-pattern "CliApprovalPrompter"
```

Expected after full implementation: all 5 tests pass.

- [ ] **Step 7: Run typecheck to confirm no errors**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 8: Run full test suite**

```bash
npm test -w @meta-agent/core && npm test -w @meta-agent/cli
```

Expected: all tests pass.

---

## Task 6: Code cleanup pass on all changed files

Apply the repo code-cleanup skill (`@meta-agent/.cursor/skills/code-cleanup/SKILL.md`) to each new or changed source file. Run one file at a time, fix issues inline, then move to the next. Test files are excluded (cleanup target = production code only).

**Files to clean (in this order):**
1. `packages/core/src/permissions-normalize.ts`
2. `packages/core/src/workflow/lift.ts`
3. `packages/core/src/approval/interface.ts`
4. `packages/core/src/approval/tiered-policy.ts`
5. `packages/core/src/factory/factory.ts`
6. `packages/cli/src/approval-display.ts`
7. `packages/cli/src/approval-format.ts`
8. `packages/cli/src/approval-tui.ts`

For each file, apply the checklist from the skill:

```
Code cleanup — target file: ___

- [ ] Protocol/id literals → const object + types aligned
- [ ] Repeated unions → named `export type` + JSDoc, wire signatures
- [ ] Magic numbers → named module constants
- [ ] Trace/event kinds → TRACE_KIND_* near Tracer, consumers updated
- [ ] Fat blocks → helpers with explicit params + preserved side-effect order
- [ ] Package index / cross-package imports updated
- [ ] Exported types / functions / classes → JSDoc with @param / @returns
- [ ] tsc clean for touched packages
```

- [ ] **Step 1: Clean `permissions-normalize.ts`**

Read the skill (`packages/core/.cursor/skills/code-cleanup/SKILL.md`). Key things to look for:
- `unionPermissions` is a new export — needs a JSDoc block with `@param perms` and `@returns`.
- `normalizePermissions` already has JSDoc; verify it still covers the full signature.
- No magic numbers or repeated unions expected; if found, name them.

Run after: `npm run typecheck`

- [ ] **Step 2: Clean `workflow/lift.ts`**

Key things to look for:
- The private `unionPermissions` and `unionStrings` were deleted; verify no dead helpers remain.
- The import from `../permissions-normalize.ts` was added — check that it sits with the other imports at the top.
- JSDoc on any exports that were touched.

Run after: `npm run typecheck`

- [ ] **Step 3: Clean `approval/interface.ts`**

Key things to look for:
- All new exported types (`CodeGate1Payload`, `WorkflowGate1Payload`, `Gate1ReviewPayload`, `CodeGate1Decision`, `WorkflowGate1Decision`, `Gate1Decision`) need JSDoc — summary + key field docs for non-obvious fields.
- `ApprovalPrompter.promptGate1` and `ApprovalPolicy.reviewDraft` updated signatures need updated JSDoc.
- Check that `APPROVAL_DECISION` and `RISK_TIER` const objects still have JSDoc.

Run after: `npm run typecheck`

- [ ] **Step 4: Clean `approval/tiered-policy.ts`**

Key things to look for:
- `reviewDraft` now branches on kind — if the body is long, extract private helpers `reviewDraftCode` / `reviewDraftWorkflow`.
- `reviewDraft` JSDoc needs to describe the payload union.
- Verify `RISK_TIER` and `APPROVAL_DECISION` are imported from constants, not duplicated as literals.

Run after: `npm run typecheck`

- [ ] **Step 5: Clean `factory/factory.ts`**

Key things to look for:
- `createWorkflow` is now longer — check if the `effectivePermissions` computation block warrants extraction into a private helper (e.g. `computeEffectivePermissions(workflow): Promise<Permissions>`).
- `presentAndSave` JSDoc: update to mention the `{ kind: "code" }` wrapping.
- `createWorkflow` JSDoc: update to mention Gate 1 review is now included.
- Verify no magic strings (tool kind values, trace event kinds) are introduced as raw literals.

Run after: `npm run typecheck`

- [ ] **Step 6: Clean `approval-display.ts`**

Key things to look for:
- `formatWorkflowInputSchema` is a new export — needs JSDoc with `@param schema` and `@returns`.
- No repeated display patterns between the existing table renderers and the new function; if shared logic emerges, extract a helper.

Run after: `npm run typecheck`

- [ ] **Step 7: Clean `approval-format.ts`**

Key things to look for:
- `formatGate1WorkflowHeader` and `formatGate1WorkflowChoicePrompt` need JSDoc.
- `APPROVAL_CHOICE_KEY.editMeta` — confirm the new key has a comment or is documented at the object.
- `GATE1_WORKFLOW_HEADER` constant — should be a `const` at module scope (not inlined in the function body).
- Check for repeated string literals between `formatGate1Header` and `formatGate1WorkflowHeader`; share if sensible.

Run after: `npm run typecheck`

- [ ] **Step 8: Clean `approval-tui.ts`**

Key things to look for:
- `promptGate1Workflow` is a new private method — add a brief behavior comment if non-obvious.
- `promptGate1Code` was extracted from the old `promptGate1` — verify JSDoc on the public `promptGate1` covers both branches.
- If `promptGate1Workflow` exceeds ~30 lines, extract the render block into a `printWorkflowGate1Review(payload)` private helper.

Run after: `npm run typecheck`

- [ ] **Step 9: Run full test suite to confirm cleanup introduced no regressions**

```bash
npm test -w @meta-agent/core && npm test -w @meta-agent/cli
```

Expected: all tests pass.

---

## Final Verification

- [ ] **Step 1: Full typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 2: Full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Smoke-check the compose flow (manual)**

```bash
npm run cli
```

In the REPL, run two tool calls, then type `/compose`. Select the slice, give a name and intent. At the new Gate 1 prompt, verify:
- The workflow name, description, input schema, effective permissions, and step rendering are shown.
- `[a]pprove / [A]lways-approve / [e]dit name/desc / [r]eject` choices appear.
- Pressing `a` saves the workflow to the registry.
- Pressing `r` and giving a reason returns "rejected: <reason>".

---

## Key Invariants to Preserve

1. **Atomic and composite tools unchanged** — `presentAndSave` still calls `reviewDraft({ kind: 'code', ... })`; the reviewer sees the same code/smoke review as before.
2. **yolo mode** — `createWorkflow` in yolo auto-approves with `alwaysApprove: false` and `notes: 'yolo'`; no user prompt.
3. **previewWorkflow unchanged** — the CLI still calls `previewWorkflow` before `createWorkflow` for the parameterization step. No approval happens in `previewWorkflow`.
4. **editedName triggers hash recompute** — if the reviewer edits the workflow name, `toolFromManifestAndCode` recomputes the hash over the updated manifest and workflow JSON.
