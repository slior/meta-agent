# ADR 007: Output Contract Enforcement

## Status

ACCEPTED on 2026-07-04.

Assumes [ADR 003: LLM Call Tracing and Reference-Based Data Passing](003-llm-tracing-and-reference-based-data-passing.md)
and [ADR 006: PolicyEnforcedSandbox](006-policy-enforced-sandbox.md).

## Context

Every tool manifest declares an `outputShape`, and it is shown to the Gate 1
reviewer, but it is never enforced at any boundary. Inputs are validated against
`inputSchema` at dispatch and fail hard on mismatch; successful outputs pass
through unchecked. This is design-review finding H5.

The gap has real consequences: malformed outputs enter the result store and can
be referenced via `$ref` in later calls; workflow steps silently pass mismatched
data between tools; composed tools build assumptions on outputs that were never
structurally verified; and the factory smoke test only checks that the
subprocess exited, so a tool returning the wrong shape passes Gate 1 undetected.

Alternatives considered:

- A shared `validateToolOutput` helper called by both the agent loop and the
  factory (chosen), mirroring the existing `coerce-tool-input.ts` pattern.
- Inlining the validation at each call site (rejected — duplicated logic and no
  shared, cached validator or test target).
- Validating at the sandbox boundary (rejected — workflow tools bypass the
  sandbox and run in-process, and the factory uses a raw sandbox for smoke
  tests; schema validation is not a sandbox concern).

## Decision

Add a focused `validate-tool-output.ts` module with a module-level Ajv instance
and a per-schema compiled-validator cache, so each unique schema is compiled once
and per-call cost is a single function call. Add a distinct
`output_schema_violation` error kind, kept separate from the input
`schema_violation` so the model can reason differently ("I passed wrong args"
vs. "the tool returned an unexpected shape — repair it or route around it").

Enforce the contract at two points. At runtime, `runWithTracing` validates a
successful output before tracing or storing it, using a local `effectiveResult`
so a violation is traced as a failed invocation and the bad value never enters
the result store or a `$ref` binding; this one insertion point covers atomic,
composite, and workflow tools. At creation time, the factory checks the smoke
output against `outputShape` with its own repair loop, and re-validates
reviewer-edited drafts (static, smoke, and output checks) before saving. Lift is
updated to derive a workflow's `outputShape` from its last step's tool manifest
instead of hardcoding `{}`, so runtime validation is meaningful for lifted
workflows. Trace events at depth greater than zero gain an `errorKind` field so
the new distinction is visible for nested and workflow-step failures.

## Consequences

- `outputShape` becomes a real contract at both runtime and creation time rather
  than an aspirational declaration.
- Existing registry tools whose declared `outputShape` does not match their
  actual output will fail at first invocation with `output_schema_violation`;
  recovery is by on-disk edit, agent workaround, or reporting to the user. Loose
  schemas (`{}`) continue to pass unchanged.
- Deriving workflow `outputShape` from the last step changes the manifest hash
  for newly lifted workflows (existing entries are unaffected) — the desired
  behavior, since the hash should reflect the real contract.
- This decision consumes two earlier foundations: the shared `runWithTracing`
  exit point from ADR 006, and the result store / `$ref` mechanism from ADR 003
  that it protects.
