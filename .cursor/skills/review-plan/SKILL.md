---
name: review-plan
description: >-
  Reviews an implementation plan file for correctness, completeness, and
  consistency against the actual codebase. Checks that code and architecture
  assumptions hold, that design and implementation are consistent, that test
  coverage is complete, that a cleanup step and full test-suite run are
  included, and that any architectural changes are justified. Writes a
  severity-sorted markdown issue list to the given output file.
  Use when asked to review a plan, audit an implementation plan, check a plan
  for issues, or when the user provides a plan file path and an output path.
---

# Review plan

Audit a written implementation plan against the real codebase and write a
severity-sorted issue list to a file.

## Required inputs

Both are **mandatory**. If either is missing, ask before proceeding.

| Input | Description |
|-------|-------------|
| **Plan file path** | Path to the plan to review (e.g. `docs/plans/2026-06-11-my-feature.md`) |
| **Output file path** | Where to write the findings (e.g. `tmp/reviews/review1.md`) |

## Quick checklist

Copy and track:

```
Review plan
- [ ] Step 1: Read the plan end-to-end
- [ ] Step 2: Read every source file the plan references
- [ ] Step 3: Run all 8 checks
- [ ] Step 4: Write severity-sorted output
```

---

## Step 1 — Read the plan

Read the full plan file. While reading, note:

- Which source files the plan says it will create or modify
- Which symbols (types, constants, functions, exports) the plan claims exist or will be added
- The proposed function/method signatures and their parameter types
- Which test cases the coverage matrix (or equivalent section) lists as required
- What the visual design or expected output looks like (if shown)

---

## Step 2 — Read the real code

Read every source file mentioned in the plan — **including test files**. Also read:

- The module's `index.ts` (or equivalent) to check what is actually exported
- Any `tsconfig.json` / compiler config to check strictness flags
- Existing test files for the modules being changed

Read files before drawing conclusions. Do not rely on the plan's description of what the code currently does.

---

## Step 3 — Run all checks

Work through each check below in order. Collect every issue as you go.

### Check A — Architecture assumptions

For each specific claim the plan makes about existing code, verify it against the actual file.

Look for:
- **Line-number references** — do those lines actually contain what the plan says?
- **Claimed exports** — is the symbol actually exported from the module/package index?
- **Claimed function signatures** — does the real signature match what the plan says it does?
- **Claimed constants** — does the constant exist at the expected path with the expected value?

Example of a bad assumption: the plan says `import { FOO } from "@my-package/core"` but `FOO` is only in `src/types.ts` and not re-exported from `src/index.ts`.

### Check B — Type-system correctness

Read the plan's proposed TypeScript code with the project's compiler flags in mind (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes).

Look for:
- **`readonly` / mutability mismatch** — the plan uses `as const` in a test but the function parameter is `T[]` (mutable). TypeScript strict mode rejects assigning `readonly T[]` to `T[]`. Fix: use `ReadonlyArray<T>`.
- **Optional properties** — `exactOptionalPropertyTypes: true` means `{ x?: string }` and `{ x: string | undefined }` are not the same.
- **`noUncheckedIndexedAccess`** — array access like `arr[0]` returns `T | undefined`, not `T`.

These will cause `typecheck` to fail even if the runtime tests pass.

### Check C — Existing tests that will break

The plan changes code. Some existing tests likely assert the **old format or behaviour**. Read existing test files for the modules being changed and check whether any assertions will fail after the planned change.

Common patterns that break:
- A test asserts an exact output string (e.g. `assert.match(out, /tool=write-file-text/)`) but the change rewrites that output into a table where `tool` and `write-file-text` are separate columns — the literal `tool=write-file-text` will no longer appear.
- A test asserts a format (`" — "` separator) that the plan removes.
- A test imports a symbol the plan renames or deletes.

For each broken test, check whether the plan says to update or remove it. If not, flag it.

### Check D — Import placement and duplicate imports

Scan the plan's code snippets for import statements.

Look for:
- **Import inside a function body** — an `import` declaration appearing inside a function/method block is a syntax error in ESM. The plan should explicitly say to add the import at the top of the file.
- **Duplicate imports** — a task says to add `import { A, B }` to a test file that already imports `{ A }`. Duplicate imports are invalid ESM. The plan should say to **update** the existing import line.

### Check E — Coverage matrix vs actual test code

If the plan contains a coverage matrix or "Test coverage" table that lists required test cases, compare every row in that table against the test code written in the tasks.

For each row in the matrix that has no corresponding test in any task's code block, flag it as a gap. Coverage rows marked "required" with no test code mean the plan's own quality bar is not met.

### Check F — Design consistency

Compare the plan's **visual design** or described output format against the **implementation code**.

Example: the design shows multiline value preview lines appearing immediately under each row in a table. The implementation code batches all preview lines after the entire table. The output will look different from the spec.

If the implementation does not produce what the design describes, flag it.

### Check G — Orphan exports and missing implementations

Look at the plan's "File structure" or "New files" section. For each export or symbol listed there, verify it is actually implemented in some task's code block and tested.

Common gap: the file structure says a module exports `formatFoo`, `formatBar`, and `formatSection`, but only `formatFoo` and `formatBar` appear in any task code. `formatSection` is never implemented, never tested, never called — but an implementing agent will try to write it.

### Check H — Dead code and cleanup

After the plan's changes, some symbols will no longer be used. Check:

- Are any existing constants, functions, or imports **removed from use** by the planned changes but never explicitly deleted?  
  Example: a constant `SEPARATOR = " — "` is used only in the function the plan rewrites. The plan does not say to remove `SEPARATOR`, so it becomes dead code.
- Does the plan include a **dedicated code cleanup step** (a task or step explicitly for removing dead code, checking for orphan exports, naming consistency)?
- Does the plan run **the full monorepo test suite** (not just the package under development) at least once, to catch cross-package regressions?  
  Example: `cd packages/cli && npm test` runs only CLI tests. `npm test` from the repo root also runs `packages/core` tests. If the plan never runs the latter, cross-package breaks go undetected.

---

## Step 4 — Write the output

Create parent directories for the output file if needed, then write a markdown file.

### Output format

```markdown
# Plan Review: <plan filename>
**Plan file:** `<plan file path>`

Issues are listed from highest to lowest severity.

---

## HIGH

- **[H1] <Short title>**
  <Concrete explanation. Quote the plan and the real code. Say exactly what will go wrong.>

## MEDIUM

- **[M1] <Short title>**
  <Concrete explanation.>

## LOW

- **[L1] <Short title>**
  <Concrete explanation.>
```

### Severity guide

| Severity | When to use |
|----------|-------------|
| **HIGH** | Will cause a syntax error, typecheck failure, or test suite to be broken after the task is applied as written |
| **MEDIUM** | Produces wrong output, missing required test coverage, inconsistency between design and implementation, missing implementations, no cleanup pass |
| **LOW** | Latent correctness bug, misleading instructions that could confuse an agent, redundant or incorrect test-management advice, incomplete monorepo test run |

If a check finds no issues, do not create a section for it. If all checks pass, write: "No issues found."

---

## Example invocation

**User:** "Review the plan in `docs/plans/my-feature.md` and write findings to `tmp/reviews/review1.md`."

**Agent:** Read skill → read plan → read referenced source files → run checks A–H → write `tmp/reviews/review1.md` → confirm.
