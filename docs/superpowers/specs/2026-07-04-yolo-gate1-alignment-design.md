# Design Spec: Align `yolo` with documented Gate 1 intent

**Date:** 2026-07-04
**Status:** Approved
**Scope:** Fix `TieredApprovalPolicy.reviewDraft` so `yolo` no longer bypasses Gate 1 creation review.

---

## 1. Problem

The design (`meta-tool-design.md` §11.6) and public documentation (`configuration.md`, `README.md`) state that `--yolo` skips interactive prompts **only for tool execution** (Gate 2/3). Gate 1 — where the user reviews LLM-generated code, declared permissions, rationale, and smoke-test output before persistence — is documented as always interactive.

The implementation contradicts this: `TieredApprovalPolicy.reviewDraft` has an `if (this.yolo)` early return that auto-approves with `alwaysApprove: true` and never calls the prompter. As a result, running with `--yolo` can silently persist arbitrary LLM-generated tools without human review. The only guards that remain are static validation and the OS-level sandbox permission flags.

`tool-permissions.md` §7 documents the actual broken behavior honestly, which means the docs are internally inconsistent with each other.

The two `reviewDraft yolo` unit tests encode the bug as intended behavior, so the test suite currently passes against the wrong semantics.

---

## 2. Goal

After this change:

- `yolo: true` skips Gate 2/3 execution prompts, exactly as documented.
- `yolo: true` does **not** skip Gate 1 — `reviewDraft` always delegates to the prompter.
- All documentation is consistent with the implementation.
- All tests reflect the correct semantics.

---

## 3. Changes

### 3.1 `packages/core/src/approval/tiered-policy.ts`

**Remove** the `if (this.yolo)` early return from `reviewDraft` and **delete** the `yoloGate1Decision` private method (dead code after the removal).

After the change, `reviewDraft` is:

```typescript
async reviewDraft(payload: Gate1ReviewPayload): Promise<Gate1Decision> {
  return this.prompter.promptGate1(payload);
}
```

**Update** the JSDoc on `TieredOpts.yolo`:

> When true, auto-approves Gate 2/3 execution prompts without prompting. Gate 1 creation review always prompts regardless of this flag.

The `yolo` property, `TieredOpts` type, `checkExecution` logic, and all wiring in `factory.ts` / `agent-loop.ts` are unchanged.

### 3.2 `packages/core/src/approval/tiered-policy.test.ts`

Two test cases assert the broken behavior and must be updated:

| Old name | New name | Change |
|---|---|---|
| `"reviewDraft yolo code: auto-approves without calling prompter, returns kind=code"` | `"reviewDraft yolo code: delegates to prompter (yolo does not skip Gate 1)"` | Assert prompter IS called; assert its return value is the result. |
| `"reviewDraft yolo workflow: auto-approves without calling prompter, returns kind=workflow"` | `"reviewDraft yolo workflow: delegates to prompter (yolo does not skip Gate 1)"` | Same. |

The existing `"yolo mode auto-approves everything without prompting"` test only exercises `checkExecution` and passes unchanged.

### 3.3 `docs/tool-permissions.md` — §7 (YOLO mode in detail)

Replace the current behavior description:

```
- **Gate 1 reviewDraft:** auto-approve with `alwaysApprove: true`
- **Gate 2/3 checkExecution:** auto-approve without prompts

So YOLO bypasses the human approval workflow entirely.
```

With:

```
- **Gate 1 reviewDraft:** always prompts — yolo does not skip Gate 1 creation review.
- **Gate 2/3 checkExecution:** auto-approve without prompts.
```

Replace the summary sentence with:

> YOLO removes execution prompts (Gate 2/3); Gate 1 creation review is always interactive.

Update the "normal mode vs YOLO mode" summary:

```
- normal mode  = capability boundaries + human gates (Gate 1 + Gate 2/3)
- YOLO mode    = capability boundaries + Gate 1 review; execution runs without Gate 2/3 prompts
```

Update Flow 6 ("same elevated tool in YOLO mode"):

```
2. Tool creation: Gate 1 prompt shown as normal — yolo does not skip it.
3. Tool execution: no Gate 2/3 prompt.
```

### 3.4 `docs/configuration.md` — `yolo` description

The current text says:

> When true, the tiered approval policy **skips interactive prompts for running tools** that would normally ask the user. **Creating** new tools still goes through the approval flow unless your overall setup changes that elsewhere.

Remove the trailing qualifier `unless your overall setup changes that elsewhere` — it is now simply untrue:

> When true, the tiered approval policy **skips interactive prompts for running tools** that would normally ask the user. **Creating** new tools always goes through the Gate 1 approval flow.

---

## 4. Architecture

No architecture changes. The `ApprovalPolicy` interface, `TieredOpts` type, wiring in `factory.ts`, `agent-loop.ts`, and `workflow/lift.ts` are all unchanged. This is a behavioral correction inside a single method body.

---

## 5. Error handling

No new error paths. Gate 1 rejection (when the prompter returns `decision: "reject"`) was already handled by `ToolFactory` — it will now fire in yolo mode where it previously could not. `ToolFactory` already surfaces this as a structured `{ ok: false, error: "rejected by reviewer: <reason>" }` result to the agent loop, so no new handling is needed.

---

## 6. Testing

All changes are in unit tests for `TieredApprovalPolicy`. No integration or e2e test changes required because the e2e tests already use `yolo: false` and pass a prompter stub that implements `promptGate1`.

The two modified tests will use the same prompter stub pattern already present in the non-yolo `reviewDraft` tests (`"reviewDraft non-yolo code: delegates to prompter with code payload"`).

---

## 7. Non-goals

- No change to `checkExecution` behavior.
- No new config flags or CLI options.
- No migration needed — there are no external consumers of this POC's API.
- The `YOLO_GATE1_NOTE` constant (`"yolo"`) can be removed along with `yoloGate1Decision`; no other code references it.
