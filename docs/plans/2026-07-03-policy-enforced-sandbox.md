# PolicyEnforcedSandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misleading `ApprovalToken` parameter on `Sandbox.execute` with a `PolicyEnforcedSandbox` wrapper that structurally enforces approval-policy checks before every tool execution, so the enforcement cannot be bypassed by future callers with access to `Sandbox`.

**Architecture:** Remove `ApprovalToken` from `types.ts` and all callsites; strip the dead param from `Sandbox.execute` / `NodePermissionSandbox`. Create `PolicyEnforcedSandbox implements Sandbox` that wraps a raw `Sandbox` and calls `ApprovalPolicy.checkExecution` before delegating to the inner sandbox. `AgentLoop` is typed to require a `PolicyEnforcedSandbox` (not a raw `Sandbox`), while `ToolFactory` intentionally keeps the raw `Sandbox` for smoke-test execution. The agent loop's `runWithApproval` is split: workflow tools keep an in-loop policy check; sandbox tools delegate entirely to `PolicyEnforcedSandbox`, and the loop only handles tracing.

**Tech Stack:** TypeScript, Node.js ≥ 25, `node:crypto` not required (no signed tokens), existing `ApprovalPolicy` / `ToolRegistry` / `Sandbox` interfaces.

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `packages/core/src/types.ts` | Delete `ApprovalToken` type |
| Modify | `packages/core/src/approval/interface.ts` | Remove `token` from `ExecutionDecision`; drop `ApprovalToken` import |
| Modify | `packages/core/src/approval/tiered-policy.ts` | Delete `newToken()` and `approveExecution`'s token field |
| Modify | `packages/core/src/sandbox/sandbox.ts` | Remove `approvalToken` param from `Sandbox.execute` |
| Modify | `packages/core/src/sandbox/node-permission-sandbox.ts` | Remove `_approvalToken` param |
| **Create** | `packages/core/src/sandbox/policy-enforced-sandbox.ts` | `PolicyEnforcedSandbox` class |
| **Create** | `packages/core/src/sandbox/policy-enforced-sandbox.test.ts` | Unit tests for the wrapper |
| Modify | `packages/core/src/agent/agent-loop.ts` | `opts.sandbox: PolicyEnforcedSandbox`; split `runWithApproval` → `runWithApproval` (workflow) + `runWithTracing` (sandbox) |
| Modify | `packages/core/src/index.ts` | Export `PolicyEnforcedSandbox` |
| Modify | `packages/cli/src/approval-tui.ts` | Remove `randomApprovalToken()`; fix `ExecutionDecision` shape |
| Modify | `packages/cli/src/repl.ts` | Construct `PolicyEnforcedSandbox`; pass raw sandbox to factory |
| Modify | `packages/core/src/sandbox/node-permission-sandbox.test.ts` | Remove `"token"` arg from every `execute` call |
| Modify | `packages/core/src/agent/agent-loop.test.ts` | Use `PolicyEnforcedSandbox` in every `new AgentLoop(...)` setup |
| Modify | `packages/core/src/e2e.test.ts` | Same |
| Modify | `packages/core/src/agent/reference-flow.test.ts` | Same |
| Modify | `packages/core/src/workflow/e2e-lift.test.ts` | Remove `"token"` arg; no AgentLoop changes needed |
| Modify | `packages/core/src/workflow/llm-step.e2e.test.ts` | Remove `"token"` arg |

---

## Task 1: Delete `ApprovalToken` from interfaces and policy

Remove the type and every reference in the types / approval layer. After this task the code won't compile yet (sandbox and agent-loop still reference `ApprovalToken`), but the change is self-contained.

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/approval/interface.ts`
- Modify: `packages/core/src/approval/tiered-policy.ts`
- Modify: `packages/cli/src/approval-tui.ts`

- [ ] **Step 1.1 — Delete `ApprovalToken` from `types.ts`**

```typescript
// packages/core/src/types.ts  — remove this line entirely:
// export type ApprovalToken = string;
```

After edit the file should have no `ApprovalToken` definition.

- [ ] **Step 1.2 — Remove `token` from `ExecutionDecision` in `approval/interface.ts`**

Replace the `ExecutionDecision` type and its JSDoc:

```typescript
/**
 * Represents the possible outcomes of an execution approval decision (Gate 2/3).
 *
 * - If `decision` is `"approve"`:
 *    - `cacheForSession`: If true, the approval decision may be cached for the session.
 *
 * - If `decision` is `"reject"`:
 *    - `reason`: Explanation for rejection.
 */
export type ExecutionDecision =
  | { decision: typeof APPROVAL_DECISION.APPROVE; cacheForSession: boolean }
  | { decision: typeof APPROVAL_DECISION.REJECT; reason: string };
```

Also remove `ApprovalToken` from the import line at the top of `approval/interface.ts`:

```typescript
import type { ApprovalRecord, Permissions, Tool, ToolDraft, ToolManifest, ToolResult } from "../types.ts";
```

- [ ] **Step 1.3 — Remove `newToken()` and token emission from `tiered-policy.ts`**

In `packages/core/src/approval/tiered-policy.ts`:

1. Remove `ApprovalToken` from the import:

```typescript
import { PERMISSIONS_NET, type ApprovalRecord, type Permissions, type Tool } from "../types.ts";
```

2. Replace `approveExecution`:

```typescript
private approveExecution(cacheForSession: boolean): ExecutionDecision {
  return { decision: APPROVAL_DECISION.APPROVE, cacheForSession };
}
```

3. Delete the `newToken()` function at the bottom of the file entirely (lines ~156–168).

- [ ] **Step 1.4 — Fix `approval-tui.ts`**

In `packages/cli/src/approval-tui.ts`:

1. Delete `randomApprovalToken()` (lines ~68–70):

```typescript
// DELETE the following function entirely:
// function randomApprovalToken(): string {
//   return Math.random().toString(36).slice(2);
// }
```

2. Find the `promptGate23` implementation which builds the approval result. It currently has `token: randomApprovalToken()` — remove that field:

```typescript
// Before (around line 193):
return { decision: APPROVAL_DECISION.APPROVE, token: randomApprovalToken(), cacheForSession: ... };

// After:
return { decision: APPROVAL_DECISION.APPROVE, cacheForSession: ... };
```

Find the exact line with `token: randomApprovalToken()` in `approval-tui.ts` and remove just the `token: randomApprovalToken(),` portion. The surrounding `decision` and `cacheForSession` fields stay.

---

## Task 2: Strip `approvalToken` from `Sandbox.execute`

Make the raw execution interface honest: it is a pure subprocess mechanism with no policy knowledge.

**Files:**
- Modify: `packages/core/src/sandbox/sandbox.ts`
- Modify: `packages/core/src/sandbox/node-permission-sandbox.ts`
- Modify: `packages/core/src/sandbox/node-permission-sandbox.test.ts`
- Modify: `packages/core/src/workflow/e2e-lift.test.ts`
- Modify: `packages/core/src/workflow/llm-step.e2e.test.ts`

- [ ] **Step 2.1 — Remove `approvalToken` from `Sandbox` interface**

In `packages/core/src/sandbox/sandbox.ts`:

1. Remove `ApprovalToken` from imports (the type no longer exists):

```typescript
import type { Tool, ToolResult } from "../types.ts";
```

2. Replace the `execute` signature:

```typescript
/**
 * Execute a sandboxed tool with the given arguments.
 *
 * Policy enforcement (approval gate) is the caller's responsibility.
 * Use {@link PolicyEnforcedSandbox} when constructing an {@link AgentLoop} to ensure
 * the approval policy is checked before every execution.
 *
 * @param tool - The compiled or source representation of the tool to run.
 * @param args - The arguments to pass to the tool on invocation.
 * @param opts - (Optional) Execution options including toolPath override, composite tool handler, call depth, etc.
 * @returns A Promise that resolves to the ToolResult, including output, errors, or invocation metadata.
 */
execute(
  tool: Tool,
  args: unknown,
  opts?: ExecuteOpts
): Promise<ToolResult>;
```

- [ ] **Step 2.2 — Remove `_approvalToken` from `NodePermissionSandbox.execute`**

In `packages/core/src/sandbox/node-permission-sandbox.ts`, find the `execute` method signature (around line 176):

```typescript
// Before:
async execute( tool: Tool, args: unknown, _approvalToken: string, opts: ExecuteOpts = {}, ): Promise<ToolResult> {

// After:
async execute(tool: Tool, args: unknown, opts: ExecuteOpts = {}): Promise<ToolResult> {
```

The body of the method is unchanged.

- [ ] **Step 2.3 — Update `node-permission-sandbox.test.ts`**

Remove the `"token"` third argument from every `sb.execute(...)` call. There are ~8 occurrences, all look like:

```typescript
// Before:
const r = await sb.execute(tool, { x: 3 }, "token", { toolPath: ... });

// After:
const r = await sb.execute(tool, { x: 3 }, { toolPath: ... });
```

The opts object (previously the 4th arg) becomes the 3rd arg. For calls that had no opts:

```typescript
// Before:
const r = await sb.execute(tool, {}, "token");

// After:
const r = await sb.execute(tool, {});
```

- [ ] **Step 2.4 — Update `e2e-lift.test.ts` and `llm-step.e2e.test.ts`**

In `packages/core/src/workflow/e2e-lift.test.ts`, there are three calls (lines ~172, 282, 323):

```typescript
// Before:
return sandbox.execute(tool, args, "token");

// After:
return sandbox.execute(tool, args);
```

In `packages/core/src/workflow/llm-step.e2e.test.ts` (line ~51):

```typescript
// Before:
return sandbox.execute(tool, args, "token", { ... });

// After:
return sandbox.execute(tool, args, { ... });
```

- [ ] **Step 2.5 — Run sandbox tests to verify no regressions**

```bash
npm test -w @meta-agent/core -- --test-name-pattern "sandbox"
```

Expected: all sandbox tests pass. Typecheck still fails (agent-loop still imports `ApprovalToken`).

---

## Task 3: Create `PolicyEnforcedSandbox` (TDD)

Write the tests first, then the implementation.

**Files:**
- Create: `packages/core/src/sandbox/policy-enforced-sandbox.test.ts`
- Create: `packages/core/src/sandbox/policy-enforced-sandbox.ts`

- [ ] **Step 3.1 — Write failing tests**

Create `packages/core/src/sandbox/policy-enforced-sandbox.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Sandbox, ExecuteOpts } from "./sandbox.ts";
import type { ApprovalPolicy } from "../approval/interface.ts";
import { APPROVAL_DECISION } from "../approval/interface.ts";
import { PolicyEnforcedSandbox } from "./policy-enforced-sandbox.ts";
import type { ApprovalRecord, Tool, ToolResult } from "../types.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTool(name = "test-tool"): Tool {
  return {
    manifest: {
      name,
      description: "test",
      rationale: "test",
      inputSchema: {},
      outputShape: {},
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [],
      limits: { timeoutMs: 5000, maxOldSpaceSizeMb: 64 },
      hash: "sha256:abc",
      createdAt: new Date().toISOString(),
      kind: "atomic",
    },
    code: "export async function run() { return {}; }",
  };
}

function makeApprovalRecord(toolHash: string): ApprovalRecord {
  return {
    hash: toolHash,
    approvedAt: new Date().toISOString(),
    approvedBy: "test",
    alwaysApprove: false,
  };
}

function makeInnerSandbox(result: ToolResult): { sandbox: Sandbox; callCount: () => number } {
  let count = 0;
  const sandbox: Sandbox = {
    async execute(_tool, _args, _opts?: ExecuteOpts): Promise<ToolResult> {
      count++;
      return result;
    },
  };
  return { sandbox, callCount: () => count };
}

function makeApprovalPolicy(decision: "approve" | "reject"): { policy: ApprovalPolicy; callCount: () => number } {
  let count = 0;
  const policy: ApprovalPolicy = {
    yolo: false,
    async reviewDraft() { throw new Error("not used"); },
    async checkExecution(_tool, _args, _approval): Promise<ReturnType<ApprovalPolicy["checkExecution"]>> {
      count++;
      if (decision === "approve") return { decision: APPROVAL_DECISION.APPROVE, cacheForSession: false };
      return { decision: APPROVAL_DECISION.REJECT, reason: "denied by test policy" };
    },
  };
  return { policy, callCount: () => count };
}

function makeRegistry(approvalRecord: ApprovalRecord | null): ToolRegistry {
  return {
    async getApproval(_name: string) { return approvalRecord; },
    async list() { return []; },
    listSync() { return []; },
    async get(_name: string) { return null; },
    async save() {},
    async delete() {},
    async getDependents(_name: string) { return []; },
    async has(_name: string) { return false; },
    rootDir() { return ""; },
    async getWorkflow(_name: string) { return null; },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("PolicyEnforcedSandbox: calls checkExecution before delegating to inner sandbox", async () => {
  const tool = makeTool();
  const record = makeApprovalRecord(tool.manifest.hash);
  const { sandbox: inner, callCount: innerCalls } = makeInnerSandbox({ ok: true, value: "result" });
  const { policy, callCount: policyCalls } = makeApprovalPolicy("approve");
  const registry = makeRegistry(record);

  const sandbox = new PolicyEnforcedSandbox(inner, policy, registry);
  const result = await sandbox.execute(tool, { x: 1 });

  assert.equal(policyCalls(), 1, "checkExecution should be called once");
  assert.equal(innerCalls(), 1, "inner sandbox should be called once");
  assert.deepEqual(result, { ok: true, value: "result" });
});

test("PolicyEnforcedSandbox: returns rejected_by_user error without calling inner sandbox when policy rejects", async () => {
  const tool = makeTool();
  const record = makeApprovalRecord(tool.manifest.hash);
  const { sandbox: inner, callCount: innerCalls } = makeInnerSandbox({ ok: true, value: "should not reach" });
  const { policy } = makeApprovalPolicy("reject");
  const registry = makeRegistry(record);

  const sandbox = new PolicyEnforcedSandbox(inner, policy, registry);
  const result = await sandbox.execute(tool, {});

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "rejected_by_user");
  assert.ok(!result.ok && result.error.message.includes("denied by test policy"));
  assert.equal(innerCalls(), 0, "inner sandbox must NOT be called after rejection");
});

test("PolicyEnforcedSandbox: passes opts through to inner sandbox on approval", async () => {
  const tool = makeTool();
  const record = makeApprovalRecord(tool.manifest.hash);
  let capturedOpts: ExecuteOpts | undefined;
  const inner: Sandbox = {
    async execute(_tool, _args, opts?: ExecuteOpts) {
      capturedOpts = opts;
      return { ok: true, value: null };
    },
  };
  const { policy } = makeApprovalPolicy("approve");
  const registry = makeRegistry(record);

  const onInvokeTool = async () => ({ ok: true as const, value: "sub" });
  const sandbox = new PolicyEnforcedSandbox(inner, policy, registry);
  await sandbox.execute(tool, {}, { onInvokeTool, depth: 1 });

  assert.equal(capturedOpts?.depth, 1);
  assert.equal(capturedOpts?.onInvokeTool, onInvokeTool);
});

test("PolicyEnforcedSandbox: passes null approvalRecord to checkExecution when registry has no record", async () => {
  const tool = makeTool();
  let capturedRecord: ApprovalRecord | null = makeApprovalRecord("sentinel");
  const inner: Sandbox = { async execute() { return { ok: true, value: null }; } };
  const policy: ApprovalPolicy = {
    yolo: false,
    async reviewDraft() { throw new Error("not used"); },
    async checkExecution(_t, _a, approval) {
      capturedRecord = approval;
      return { decision: APPROVAL_DECISION.APPROVE, cacheForSession: false };
    },
  };
  const registry = makeRegistry(null);

  const sandbox = new PolicyEnforcedSandbox(inner, policy, registry);
  await sandbox.execute(tool, {});

  assert.equal(capturedRecord, null, "null record should be forwarded to checkExecution");
});
```

- [ ] **Step 3.2 — Run tests to confirm they all fail (import error)**

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/sandbox/policy-enforced-sandbox.test.ts
```

Expected: Error — module `./policy-enforced-sandbox.ts` not found.

- [ ] **Step 3.3 — Implement `PolicyEnforcedSandbox`**

Create `packages/core/src/sandbox/policy-enforced-sandbox.ts`:

```typescript
import { APPROVAL_DECISION } from "../approval/interface.ts";
import type { ApprovalPolicy } from "../approval/interface.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";
import type { Tool, ToolResult } from "../types.ts";
import { toolError } from "../errors.ts";
import type { ExecuteOpts, Sandbox } from "./sandbox.ts";

/**
 * Wraps a raw {@link Sandbox} with an {@link ApprovalPolicy} enforcement layer.
 *
 * Every call to {@link execute} first runs `ApprovalPolicy.checkExecution`; if the
 * policy rejects the invocation the inner sandbox is never reached. This makes it
 * impossible for callers who hold a `PolicyEnforcedSandbox` to accidentally bypass
 * the approval gate — the check is structurally in the execution path, not a caller
 * convention.
 *
 * `ToolFactory` receives the raw inner {@link Sandbox} directly for smoke-test
 * executions (which occur before Gate 1 approval and are explicitly exempt from
 * execution policy).
 */
export class PolicyEnforcedSandbox implements Sandbox {
  constructor(
    private readonly inner: Sandbox,
    private readonly approval: ApprovalPolicy,
    private readonly registry: ToolRegistry,
  ) {}

  async execute(tool: Tool, args: unknown, opts?: ExecuteOpts): Promise<ToolResult> {
    const approvalRecord = await this.registry.getApproval(tool.manifest.name);
    const decision = await this.approval.checkExecution(tool, args, approvalRecord);
    if (decision.decision === APPROVAL_DECISION.REJECT) {
      return toolError("rejected_by_user", decision.reason);
    }
    return this.inner.execute(tool, args, opts);
  }
}
```

- [ ] **Step 3.4 — Run the new tests to confirm they all pass**

```bash
node --test --experimental-transform-types --no-warnings \
  packages/core/src/sandbox/policy-enforced-sandbox.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 3.5 — Commit**

```bash
git add packages/core/src/sandbox/policy-enforced-sandbox.ts \
        packages/core/src/sandbox/policy-enforced-sandbox.test.ts
git commit -m "feat(sandbox): add PolicyEnforcedSandbox wrapper"
```

---

## Task 4: Restructure `AgentLoop`

Split the current `runWithApproval` into two methods and make the sandbox dependency structurally typed.

**Files:**
- Modify: `packages/core/src/agent/agent-loop.ts`

The key change: `runWithApproval` keeps the policy check for **workflow** tools. For **sandbox** tools a new `runWithTracing` method is used instead — no policy call there, because `PolicyEnforcedSandbox` handles it. Tracing of `execution-denied` for sandbox rejections is recovered in `runWithTracing` by inspecting the result kind.

- [ ] **Step 4.1 — Update `AgentLoopOpts.sandbox` type**

In `packages/core/src/agent/agent-loop.ts`:

1. Add import for `PolicyEnforcedSandbox`:

```typescript
import { PolicyEnforcedSandbox } from "../sandbox/policy-enforced-sandbox.ts";
```

2. Remove `ApprovalToken` from the `types.ts` import line:

```typescript
import { TOOL_CAPABILITY, TOOL_KIND, type Tool, type ToolResult } from "../types.ts";
```

3. Change `sandbox` field in `AgentLoopOpts`:

```typescript
export type AgentLoopOpts = {
  llm: LLMProvider;
  registry: ToolRegistry;
  index: ToolIndex;
  /** Must be a {@link PolicyEnforcedSandbox}; this type constraint ensures the approval
   *  policy is structurally in the execution path for every sandbox tool invocation. */
  sandbox: PolicyEnforcedSandbox;
  approval: ApprovalPolicy;
  factory: ToolFactory;
  tracer: Tracer;
  maxTurns?: number;
  onToolInvoked?: (ev: ToolInvokedEvent) => void;
};
```

- [ ] **Step 4.2 — Add `runWithTracing` private method**

Add `runWithTracing` immediately before or after `runWithApproval` in `agent-loop.ts`. This is the execution + tracing path used by sandbox tools. Policy checks are **not** performed here — they belong in `PolicyEnforcedSandbox`.

```typescript
/**
 * Executes a sandbox tool via `executeFn`, measures elapsed time, and logs the appropriate
 * trace event. If the result is a `rejected_by_user` error (policy rejection surfaced by
 * {@link PolicyEnforcedSandbox}), logs `TRACE_KIND_EXECUTION_DENIED` without calling
 * `onToolInvoked`. All other results (success or non-rejection failure) log
 * `TRACE_KIND_TOOL_INVOKED` and call `onToolInvoked`.
 *
 * @param tool Tool whose manifest name is used for tracing.
 * @param input Validated invocation arguments.
 * @param recordArgs Unresolved args at depth 0 (forwarded to `onToolInvoked`).
 * @param task Current session context.
 * @param depth Recursion depth.
 * @param executeFn Zero-argument thunk that runs the sandboxed tool.
 */
private async runWithTracing(
  tool: Tool,
  input: unknown,
  recordArgs: unknown,
  task: Task,
  depth: number,
  executeFn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const name = tool.manifest.name;
  const started = Date.now();
  const result = await executeFn();
  const durationMs = Date.now() - started;

  if (!result.ok && result.error.kind === "rejected_by_user") {
    this.opts.tracer.log(TRACE_KIND_EXECUTION_DENIED, { name, reason: result.error.message });
    return result;
  }

  this.opts.tracer.log(TRACE_KIND_TOOL_INVOKED, { name, duration: durationMs, ok: result.ok });
  if (depth === 0) {
    const binding = this.storeDepth0Result(name, result);
    this.opts.onToolInvoked?.({
      name, args: recordArgs, ok: result.ok, durationMs,
      value: result.ok ? result.value : undefined,
      ...(binding !== null ? { binding } : {}),
    });
  } else {
    this.opts.onToolInvoked?.({ name, args: input, ok: result.ok, durationMs, value: result.ok ? result.value : undefined });
  }
  if (result.ok) task.invokedThisSession.add(name);
  return result;
}
```

- [ ] **Step 4.3 — Update `runWithApproval` to use `runWithTracing` internally and drop the token**

Replace the existing `runWithApproval` signature and body:

```typescript
/**
 * Approval gate, executor, tracer, and notification handler for **workflow** tools.
 *
 * Calls `checkExecution` (Gate 2/3) then delegates execution and tracing to
 * {@link runWithTracing}. Sandbox tools use {@link runWithTracing} directly — their
 * policy check is handled by {@link PolicyEnforcedSandbox}.
 *
 * @param tool Registered tool whose manifest drives the approval check.
 * @param input Validated, coerced invocation arguments.
 * @param recordArgs Unresolved arguments at depth 0, passed to `onToolInvoked` for lift.
 * @param task Current session context updated on successful invocation.
 * @param depth Recursion depth; controls `storeDepth0Result` and `onToolInvoked` shape.
 * @param executeFn Tool-kind executor thunk (workflow executor for workflow tools).
 * @returns ToolResult from the executor, or a rejection error if the policy denies.
 */
private async runWithApproval(
  tool: Tool,
  input: unknown,
  recordArgs: unknown,
  task: Task,
  depth: number,
  executeFn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const name = tool.manifest.name;
  const approval = await this.opts.registry.getApproval(name);
  const decision = await this.opts.approval.checkExecution(tool, input, approval);
  if (decision.decision === APPROVAL_DECISION.REJECT) {
    this.opts.tracer.log(TRACE_KIND_EXECUTION_DENIED, { name, reason: decision.reason });
    return toolError("rejected_by_user", decision.reason);
  }
  return this.runWithTracing(tool, input, recordArgs, task, depth, executeFn);
}
```

- [ ] **Step 4.4 — Update `dispatchTool` to call `runWithTracing` for sandbox tools**

In `dispatchTool`, the **workflow** branch stays with `runWithApproval`. Change the **sandbox** branch at the bottom:

```typescript
// Before (around line 510-517):
const wantsLlm = tool.manifest.capabilities?.includes(TOOL_CAPABILITY.LLM) ?? false;
return this.runWithApproval(tool, input, recordArgs, task, depth,
  (token) => this.opts.sandbox.execute(tool, input, token, {
    depth,
    onInvokeTool: (subName, subArgs) => this.dispatchTool(subName, subArgs, task, depth + 1),
    ...(wantsLlm ? { onLLM: (req) => this.runLlmCapability(req) } : {}),
  }),
);

// After:
const wantsLlm = tool.manifest.capabilities?.includes(TOOL_CAPABILITY.LLM) ?? false;
return this.runWithTracing(tool, input, recordArgs, task, depth,
  () => this.opts.sandbox.execute(tool, input, {
    depth,
    onInvokeTool: (subName, subArgs) => this.dispatchTool(subName, subArgs, task, depth + 1),
    ...(wantsLlm ? { onLLM: (req) => this.runLlmCapability(req) } : {}),
  }),
);
```

The workflow branch (lines ~500-507) stays unchanged **except** the `executeFn` signature drops `_token`:

```typescript
return this.runWithApproval(tool, input, recordArgs, task, depth,
  () => this.executor.run(
    wf,
    input as Record<string, unknown>,
    (toolName, toolArgs, d) => this.dispatchTool(toolName, toolArgs, task, d),
    depth,
  ),
);
```

- [ ] **Step 4.5 — Run typecheck to see what still fails**

```bash
npm run typecheck
```

Expected output: errors in test files (AgentLoop construction with raw sandbox) and `repl.ts`. The core library files themselves should typecheck cleanly after this task. Fix any unexpected errors before proceeding.

---

## Task 5: Update test wiring — `AgentLoop` call sites

Every test that constructs `AgentLoop` must now provide a `PolicyEnforcedSandbox`. The pattern is consistent across all files:

```typescript
// Before (existing pattern in every test):
const sandbox = new NodePermissionSandbox({ workspace: dir });
const factory = new ToolFactory({ llm, registry, sandbox, approval, tracer, tombstoned: new Set() });
const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });

// After:
const innerSandbox = new NodePermissionSandbox({ workspace: dir });
const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });
const loop = new AgentLoop({ llm, registry, index, sandbox, approval, factory, tracer });
```

Note: `ToolFactory` gets `innerSandbox` (raw) for smoke tests. `AgentLoop` gets `sandbox` (wrapped). `PolicyEnforcedSandbox` constructor takes 3 args: `(inner, approval, registry)`.

**Files:**
- Modify: `packages/core/src/agent/agent-loop.test.ts`
- Modify: `packages/core/src/e2e.test.ts`
- Modify: `packages/core/src/agent/reference-flow.test.ts`

- [ ] **Step 5.1 — Update `agent-loop.test.ts`**

Add `PolicyEnforcedSandbox` to the imports at the top:

```typescript
import { PolicyEnforcedSandbox } from "../sandbox/policy-enforced-sandbox.ts";
```

Apply the three-line pattern change to **every** test setup block in this file (there are ~20 setups). Each setup currently has:

```typescript
const sandbox = new NodePermissionSandbox({ workspace: dir });
```

Replace with:

```typescript
const innerSandbox = new NodePermissionSandbox({ workspace: dir });
const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
```

And change the factory line to use `innerSandbox`:

```typescript
const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval, tracer, tombstoned: new Set() });
```

The `AgentLoop` construction line passes `sandbox` (the wrapped version) — that line is already correct, no change.

Note: some tests use `approval: policy` instead of `approval`. In those cases pass the same `policy` variable to `PolicyEnforcedSandbox`:

```typescript
const innerSandbox = new NodePermissionSandbox({ workspace: dir });
const sandbox = new PolicyEnforcedSandbox(innerSandbox, policy, registry);
const factory = new ToolFactory({ llm, registry, sandbox: innerSandbox, approval: policy, tracer, tombstoned: new Set() });
const loop = new AgentLoop({ llm, registry, index, sandbox, approval: policy, factory, tracer });
```

Also: the test `"agent: workflow wrapper checkExecution is called before executor runs"` (line ~527) uses a custom `checkedPolicy`. Update it identically — the policy mock is used in both the `PolicyEnforcedSandbox` and the workflow path of `runWithApproval`, so `checkExecution` will still be called for both tool kinds as the test verifies.

- [ ] **Step 5.2 — Update `e2e.test.ts`**

Add import:

```typescript
import { PolicyEnforcedSandbox } from "./sandbox/policy-enforced-sandbox.ts";
```

Apply the same three-line pattern to both test setups in this file.

- [ ] **Step 5.3 — Update `reference-flow.test.ts`**

Add import:

```typescript
import { PolicyEnforcedSandbox } from "../sandbox/policy-enforced-sandbox.ts";
```

Apply the three-line pattern to the test setup.

- [ ] **Step 5.4 — Run core tests**

```bash
npm test -w @meta-agent/core
```

Expected: all tests pass. Fix any remaining type errors before continuing.

---

## Task 6: Update CLI wiring and exports

**Files:**
- Modify: `packages/cli/src/repl.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 6.1 — Wire `PolicyEnforcedSandbox` in `repl.ts`**

In `packages/cli/src/repl.ts`, add the import:

```typescript
import {
  // ...existing imports...
  PolicyEnforcedSandbox,
} from "@meta-agent/core";
```

In `createReplSession`, replace:

```typescript
// Before (lines ~107-111 then ~132-148):
const sandbox = new NodePermissionSandbox({
  workspace: config.workspace,
  maxDepth: config.sandbox.maxDepth,
  maxOutputBytes: config.sandbox.maxOutputBytes,
});
// ...
const factory = new ToolFactory({
  llm,
  registry,
  sandbox,
  approval,
  tracer,
  tombstoned: new Set(),
});
const agent = new AgentLoop({
  llm,
  registry,
  index,
  sandbox,
  approval,
  factory,
  tracer,
  maxTurns: config.maxTurns,
  onToolInvoked: (ev) => recordInvocation(invocations, ev),
});
```

After:

```typescript
const innerSandbox = new NodePermissionSandbox({
  workspace: config.workspace,
  maxDepth: config.sandbox.maxDepth,
  maxOutputBytes: config.sandbox.maxOutputBytes,
});
const sandbox = new PolicyEnforcedSandbox(innerSandbox, approval, registry);
// ...
const factory = new ToolFactory({
  llm,
  registry,
  sandbox: innerSandbox,   // raw sandbox: smoke tests bypass approval
  approval,
  tracer,
  tombstoned: new Set(),
});
const agent = new AgentLoop({
  llm,
  registry,
  index,
  sandbox,                 // policy-enforced sandbox
  approval,
  factory,
  tracer,
  maxTurns: config.maxTurns,
  onToolInvoked: (ev) => recordInvocation(invocations, ev),
});
```

- [ ] **Step 6.2 — Export `PolicyEnforcedSandbox` from core**

In `packages/core/src/index.ts`, add the new export on the sandbox export line:

```typescript
export type { Sandbox, InvokeToolHandler, ExecuteOpts } from "./sandbox/sandbox.ts";
export { NodePermissionSandbox } from "./sandbox/node-permission-sandbox.ts";
export { PolicyEnforcedSandbox } from "./sandbox/policy-enforced-sandbox.ts";
```

---

## Task 7: Final verification

- [ ] **Step 7.1 — Full typecheck**

```bash
npm run typecheck
```

Expected: zero type errors.

- [ ] **Step 7.2 — Full test suite**

```bash
npm test
```

Expected: all tests pass in both `@meta-agent/core` and `@meta-agent/cli`.

- [ ] **Step 7.3 — Confirm `ApprovalToken` is fully gone**

```bash
grep -r "ApprovalToken\|approvalToken\|_approvalToken\|factory-smoke\|randomApprovalToken" \
  packages/ --include="*.ts" | grep -v ".test.ts" | grep -v "node_modules"
```

Expected: no matches in non-test source files. (`factory-smoke` string should be gone because `execute` no longer takes a token arg.)

- [ ] **Step 7.4 — Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(sandbox): PolicyEnforcedSandbox — structural approval enforcement

Remove the misleading ApprovalToken parameter from Sandbox.execute (it was
accepted but ignored). Add PolicyEnforcedSandbox, a Sandbox wrapper that calls
ApprovalPolicy.checkExecution before every execution, structurally preventing
bypass by future callers. AgentLoop now requires PolicyEnforcedSandbox in its
opts; ToolFactory retains the raw Sandbox for pre-Gate-1 smoke tests.
EOF
)"
```

---

## Self-Review

### Spec coverage

| Requirement (from H4 review finding) | Covered by task |
|---|---|
| Remove misleading `approvalToken` param from `Sandbox.execute` | Task 2 |
| Enforcement lives in the wrapper, not a caller convention | Task 3 |
| `AgentLoop` structurally requires the wrapped sandbox | Task 4 step 4.1 |
| `ToolFactory` explicitly exempt (raw sandbox) | Task 5, Task 6 |
| No double-gating (agent loop doesn't call `checkExecution` for sandbox tools) | Task 4 step 4.4 |
| Trace semantics preserved (`execution-denied` vs `tool-invoked`) | Task 4 step 4.2 |
| CLI wiring updated | Task 6 |
| All tests pass | Task 7 |

### Placeholder scan

No TBDs, no "implement later", no "similar to Task N" — every step has exact code or exact commands.

### Type consistency

- `PolicyEnforcedSandbox` constructor: `(inner: Sandbox, approval: ApprovalPolicy, registry: ToolRegistry)` — used identically in Task 3 (implementation), Task 5 (tests), and Task 6 (CLI).
- `executeFn: () => Promise<ToolResult>` — used in both `runWithApproval` (Task 4.3) and `runWithTracing` (Task 4.2); call sites in Task 4.4 use `() =>` (no token arg).
- `ExecutionDecision` approve branch: `{ decision: APPROVAL_DECISION.APPROVE, cacheForSession: boolean }` — no `token` field, consistent across Task 1 (interface), Task 1 (tiered-policy), Task 1 (approval-tui), and Task 3 (test helpers).
