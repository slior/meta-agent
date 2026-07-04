# yolo / Gate-1 Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `yolo` bypass from Gate 1 (`reviewDraft`) so that `--yolo` only skips Gate 2/3 execution prompts, matching the documented model.

**Architecture:** Single-method change inside `TieredApprovalPolicy.reviewDraft`; delete the `if (this.yolo)` branch and its helper. Two unit tests are flipped to assert the prompter IS called. Two doc files are updated to be consistent with the now-correct behavior.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node:test`), no new dependencies.

---

## File Map

| File | Action | What changes |
|---|---|---|
| `packages/core/src/approval/tiered-policy.ts` | Modify | Remove `yolo` branch from `reviewDraft`; delete `yoloGate1Decision`; delete `YOLO_GATE1_NOTE`; update JSDoc |
| `packages/core/src/approval/tiered-policy.test.ts` | Modify | Flip the two `reviewDraft yolo` tests |
| `docs/tool-permissions.md` | Modify | Update YOLO mode section and Flow 6 |
| `docs/configuration.md` | Modify | Remove stale qualifier on `yolo` description |

---

## Task 1: Flip the two failing tests first (TDD)

**Files:**
- Modify: `packages/core/src/approval/tiered-policy.test.ts:190-218`

- [ ] **Step 1: Replace the two yolo `reviewDraft` tests with correct assertions**

Open `packages/core/src/approval/tiered-policy.test.ts`. Replace lines 190–218 (both yolo reviewDraft tests) with:

```typescript
test("reviewDraft yolo code: delegates to prompter (yolo does not skip Gate 1)", async () => {
  let received: Gate1ReviewPayload | undefined;
  const prompter = {
    promptGate1: async (p: Gate1ReviewPayload) => {
      received = p;
      return { kind: GATE1_KIND.CODE, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false };
    },
    promptGate23: async () => { throw new Error("no"); },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/w", yolo: true });
  const result = await policy.reviewDraft(mkCodePayload());
  assert.equal(received?.kind, GATE1_KIND.CODE);
  assert.equal(result.kind, GATE1_KIND.CODE);
  assert.equal(result.decision, APPROVAL_DECISION.APPROVE);
});

test("reviewDraft yolo workflow: delegates to prompter (yolo does not skip Gate 1)", async () => {
  let received: Gate1ReviewPayload | undefined;
  const prompter = {
    promptGate1: async (p: Gate1ReviewPayload) => {
      received = p;
      return { kind: GATE1_KIND.WORKFLOW, decision: APPROVAL_DECISION.APPROVE, alwaysApprove: false };
    },
    promptGate23: async () => { throw new Error("no"); },
  };
  const policy = new TieredApprovalPolicy(prompter, { workspace: "/w", yolo: true });
  const result = await policy.reviewDraft(mkWorkflowPayload());
  assert.equal(received?.kind, GATE1_KIND.WORKFLOW);
  assert.equal(result.kind, GATE1_KIND.WORKFLOW);
  assert.equal(result.decision, APPROVAL_DECISION.APPROVE);
});
```

- [ ] **Step 2: Run the tests to confirm they now fail (red)**

```bash
npm test -w @meta-agent/core 2>&1 | grep -A 3 "reviewDraft yolo"
```

Expected: both new tests FAIL with something like `Error: should not be called` (because `reviewDraft` still has the yolo bypass) — confirming the tests now encode the correct expectation.

---

## Task 2: Remove the yolo bypass from `reviewDraft`

**Files:**
- Modify: `packages/core/src/approval/tiered-policy.ts`

- [ ] **Step 1: Delete `YOLO_GATE1_NOTE`, `yoloGate1Decision`, and the `if (this.yolo)` branch**

In `packages/core/src/approval/tiered-policy.ts`:

1. Delete line 17:
   ```typescript
   const YOLO_GATE1_NOTE = "yolo";
   ```

2. Replace the full `reviewDraft` method (lines 76–81) with:
   ```typescript
   /**
    * Gate 1 review for code or workflow creation payloads.
    * Always delegates to the prompter regardless of {@link TieredApprovalPolicy.yolo}.
    * The `yolo` flag only bypasses Gate 2/3 execution prompts.
    *
    * @param payload - Discriminated Gate 1 review payload.
    * @returns Approve/reject decision whose `kind` matches `payload.kind`.
    */
   async reviewDraft(payload: Gate1ReviewPayload): Promise<Gate1Decision> {
     return this.prompter.promptGate1(payload);
   }
   ```

3. Delete the entire `yoloGate1Decision` private method (lines 123–138):
   ```typescript
   private yoloGate1Decision(payload: Gate1ReviewPayload): Gate1Decision {
     if (payload.kind === GATE1_KIND.CODE) {
       return {
         kind: GATE1_KIND.CODE,
         decision: APPROVAL_DECISION.APPROVE,
         alwaysApprove: true,
         notes: YOLO_GATE1_NOTE,
       };
     }
     else return {
       kind: GATE1_KIND.WORKFLOW,
       decision: APPROVAL_DECISION.APPROVE,
       alwaysApprove: false,
       notes: YOLO_GATE1_NOTE,
     };
   }
   ```

4. Update the JSDoc on `TieredOpts.yolo` (currently line 46–47). Replace:
   ```typescript
   /** When true, auto-approves Gate 1 and Gate 2/3 without prompting. */
   yolo?: boolean;
   ```
   With:
   ```typescript
   /**
    * When true, auto-approves Gate 2/3 execution prompts without prompting.
    * Gate 1 creation review always prompts regardless of this flag.
    */
   yolo?: boolean;
   ```

- [ ] **Step 2: Run the full tiered-policy test suite (green)**

```bash
npm test -w @meta-agent/core 2>&1 | grep -E "(pass|fail|reviewDraft)"
```

Expected: all `reviewDraft` tests PASS, including both new yolo tests. The `"yolo mode auto-approves everything without prompting"` test (which only calls `checkExecution`) still passes unchanged.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/approval/tiered-policy.ts packages/core/src/approval/tiered-policy.test.ts
git commit -m "fix: yolo no longer bypasses Gate 1 creation review

TieredApprovalPolicy.reviewDraft now always delegates to the prompter.
yolo only skips Gate 2/3 execution prompts, matching the documented model.
Removes yoloGate1Decision helper and YOLO_GATE1_NOTE constant."
```

---

## Task 3: Update `docs/tool-permissions.md`

**Files:**
- Modify: `docs/tool-permissions.md:307-329` (YOLO mode section) and `:404-408` (Flow 6)

- [ ] **Step 1: Update the YOLO mode section**

In `docs/tool-permissions.md`, replace lines 313–329:

```markdown
Current implementation behavior:
- **Gate 1 reviewDraft:** auto-approve with `alwaysApprove: true`
- **Gate 2/3 checkExecution:** auto-approve without prompts

So YOLO bypasses the human approval workflow entirely.

What YOLO **does not** bypass:
- static draft validation
- schema validation at invocation time
- sandbox capability boundaries (manifest-derived flags still apply)
- runtime limits (timeout, output cap, recursion depth)

In short:
- normal mode = **capability boundaries + human gates**
- YOLO mode = **capability boundaries only**

This is why YOLO is fast but higher-risk from a review perspective.
```

With:

```markdown
Implementation behavior:
- **Gate 1 reviewDraft:** always prompts — yolo does not skip Gate 1 creation review.
- **Gate 2/3 checkExecution:** auto-approve without prompts.

YOLO removes execution prompts (Gate 2/3); Gate 1 creation review is always interactive.

What YOLO **does not** bypass:
- Gate 1 creation review (always prompts)
- static draft validation
- schema validation at invocation time
- sandbox capability boundaries (manifest-derived flags still apply)
- runtime limits (timeout, output cap, recursion depth)

In short:
- normal mode  = **capability boundaries + Gate 1 review + Gate 2/3 execution prompts**
- YOLO mode    = **capability boundaries + Gate 1 review** (execution runs without Gate 2/3 prompts)

This is why YOLO speeds up the execution loop while preserving the human review of generated tool code.
```

- [ ] **Step 2: Update Flow 6**

In `docs/tool-permissions.md`, replace lines 407–408:

```markdown
2. Tool creation: no Gate 1 prompt.
3. Tool execution: no Gate 2/3 prompt.
```

With:

```markdown
2. Tool creation: Gate 1 prompt shown as normal — yolo does not skip it.
3. Tool execution: no Gate 2/3 prompt.
```

- [ ] **Step 3: Commit**

```bash
git add docs/tool-permissions.md
git commit -m "docs: update tool-permissions.md YOLO section to reflect Gate 1 fix"
```

---

## Task 4: Update `docs/configuration.md`

**Files:**
- Modify: `docs/configuration.md:84`

- [ ] **Step 1: Remove the stale qualifier from the `yolo` description**

In `docs/configuration.md`, replace line 84:

```markdown
When `true`, the tiered approval policy **skips interactive prompts for running tools** that would normally ask the user. **Creating** new tools still goes through the approval flow unless your overall setup changes that elsewhere.
```

With:

```markdown
When `true`, the tiered approval policy **skips interactive prompts for running tools** that would normally ask the user. **Creating** new tools always goes through the Gate 1 approval flow.
```

- [ ] **Step 2: Commit**

```bash
git add docs/configuration.md
git commit -m "docs: remove stale qualifier from yolo description in configuration.md"
```

---

## Task 5: Final verification

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: all tests pass, no failures.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.
