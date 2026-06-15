---
name: code-cleanup
description: >-
  Removes basic code smells in a focused pass—magic strings and numbers, duplicated
  protocol identifiers, repeated inline unions, and oversized control-flow blocks—by
  introducing typed constants, named types, single sources of truth, extracted methods,
  and JSDoc on exported types, functions, and classes.
  Use when cleaning up a file or module, reducing repetition, preparing a refactor, or when
  the user mentions code smells, literals, constants, named types, extracting methods, or
  export documentation.
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
| **Repeated anonymous unions** | The same union (e.g. `"a" \| "b" \| null`) appears in a return type and parameter(s), or labels a concept worth naming in docs. |

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

**Named type aliases for repeated unions**

- When an inline union is **duplicated** across functions in the same module (return type + argument, or several APIs sharing one notion), introduce **`export type Name = …`** colocated with those functions.
- Use the named type on **every** relevant signature so refactors stay centralized; callers usually need no change if inference already matched.
- Document new exported types in **step 5** (domain meaning, e.g. “supported root JSON Schema `type` values”).
- Export from the package **`index`** only if external modules should reference the type; otherwise keep it module-local.

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

## 5. Document exports (JSDoc)

Every **`export`** in the target file (and any new exports introduced during cleanup) must have a JSDoc block directly above it. Match project style: multi-line `/** … */`, summary sentence first, then tags.

**Functions**

- One-line summary of what the function does (domain intent, not implementation).
- `@param name - …` for each parameter.
- `@returns …` describing the return value (omit only when return type is `void`).

**Types** (`export type`, interfaces, type aliases)

- One-line summary of what the type represents in the domain.
- For object types with non-obvious fields, add a property-level `/** … */` on the field or document key fields in the type block.
- For discriminated unions, note what each variant means if not obvious from member names.

**Classes**

- Class-level JSDoc: role of the class and how callers use it.
- JSDoc on each **public** method (and exported constructors) with `@param` / `@returns` as for functions.
- Skip JSDoc on private helpers unless behavior is non-obvious.

**Re-exports** (`export type { X }`, `export { X }`)

- Document at the re-export site when the symbol is part of the module’s public API surface; otherwise rely on the source module’s docs.

**Do not document**

- Module-private functions, constants, and types unless the user asked or behavior is genuinely hard to read.
- `@example` blocks unless the API is unusually subtle—prefer concise param/return descriptions.

## 6. Verify

- Run the project typecheck (`tsc`) for affected packages.
- Fix imports; avoid circular dependency (constants live in a leaf module like `interface.ts` / `tracer.ts`, not in files that import heavy graphs unnecessarily).

## Anti-patterns (avoid)

- Dumping unrelated strings into one giant enum without ownership.
- Exporting constants nobody imports—keep visibility minimal.
- Extracting methods that only shuffle lines without clarifying data flow.
- One-word or tag-only JSDoc (`/** foo */`) on exported APIs—use full blocks with `@param` / `@returns` where applicable.
- Editing large docs or READMEs unless the user asked.

## Quick checklist

Copy for the session:

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
