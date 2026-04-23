---
name: code-cleanup
description: >-
  Removes basic code smells in a focused pass—magic strings and numbers, duplicated
  protocol identifiers, and oversized control-flow blocks—by introducing typed constants,
  single sources of truth, and extracted methods. Use when cleaning up a file or module,
  reducing repetition, preparing a refactor, or when the user mentions code smells,
  literals, constants, or extracting methods.
---

# Code cleanup (focused file pass)

Apply this workflow to **one primary file** (and only other files needed to keep types, exports, and consumers consistent). Do not expand scope with drive-by refactors elsewhere.

## 1. Scan for smells

Read the target file end-to-end and note:

| Smell | What to look for |
|--------|------------------|
| **Protocol / identity literals** | Same string compared, assigned to `role`, `name`, `kind`, event type, JSON schema discriminator, etc. More than once or paired with a type definition. |
| **Numeric literals** | Defaults (`?? 20`), limits, timeouts, lengths—especially repeated or documented in comments. |
| **Fat loops or run methods** | Sequences that mix I/O, tracing, branching, and mutation in one block; repeated patterns inside loops. |
| **Consumer drift** | `switch (e.kind)`, tests asserting string `kind`, CLI mappers—must stay aligned with producers. |

Skip renaming for **domain prose** (user-visible copy, LLM prompts) unless the goal is to sync names with constants; if in doubt, only substitute where the string is an **identifier**, not natural language.

## 2. Introduce constants (single source of truth)

**String families used as API or protocol names**

- Add one `as const` object (or small set of objects) **next to the type or registry they describe**, e.g. chat roles beside `ChatMessage`, tool names beside tool defs, trace kinds beside `TraceEvent`.
- Derive union types when useful: `export type Foo = (typeof FOO)[keyof typeof FOO]`.
- Point type members at `typeof CONST.field` so literals cannot drift from values.
- **Export** values that cross package boundaries; re-export from the package **`index`** when CLI or other packages must import them.

**Numeric defaults**

- Replace inline numbers with a **named constant** at module scope; short JSDoc linking to the related option or behavior.
- One constant per meaning (do not merge unrelated magic numbers).

**Tracer / telemetry `kind` strings**

- Define `TRACE_KIND_*` (or project convention) **next to `Tracer` / `TraceEvent`**, export, use in `tracer.log(...)`, tests, and any formatter that `switch`es on `kind`.

## 3. Extract methods without changing behavior

When a block becomes a private/helper method:

- **Pass everything needed explicitly** (no hidden globals). Keep mutable collections (`messages`, `task`) passed by reference when mutation is intentional.
- **Preserve order of operations**: e.g. compute “prior state” **before** appending the message that changes it.
- **Encode control flow clearly**:
  - Return `string \| null` for “final answer vs continue”.
  - Or a small discriminated union `{ done: true; answer: string } \| { done: false; ... }` when multiple exit paths exist.
- Keep **early returns** equivalent to the original; do not duplicate work or logs.

Name helpers by **intent** (`runOneAgentTurn`, `processOneToolCall`, `finalizeSoloStopCall`), not only by position in the file.

## 4. Wire consumers

- **Tests**: import shared constants; use them in mock payloads and in `assert.equal(..., TRACE_KIND_*)` / `includes(prefix)` built from constants if the production string is built from those parts.
- **CLI / other packages**: update `switch` cases to use imported constants from the core package.
- **Meta-tool / schema JSON**: property names like `"tool"` in `required` arrays are **field names**, not necessarily the same as meta-function names—do not blindly unify.

## 5. Verify

- Run the project typecheck (`tsc`) for affected packages.
- Fix imports; avoid circular dependency (constants live in a leaf module like `interface.ts` / `tracer.ts`, not in files that import heavy graphs unnecessarily).

## Anti-patterns (avoid)

- Dumping unrelated strings into one giant enum without ownership.
- Exporting constants nobody imports—keep visibility minimal.
- Extracting methods that only shuffle lines without clarifying data flow.
- Editing large docs or READMEs unless the user asked.

## Quick checklist

Copy for the session:

```
Code cleanup — target file: ___

- [ ] Protocol/id literals → const object + types aligned
- [ ] Magic numbers → named module constants
- [ ] Trace/event kinds → TRACE_KIND_* near Tracer, consumers updated
- [ ] Fat blocks → helpers with explicit params + preserved side-effect order
- [ ] Package index / cross-package imports updated
- [ ] tsc clean for touched packages
```
