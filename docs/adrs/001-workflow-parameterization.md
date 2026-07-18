# ADR 001: Workflow Parameterization

## Status

ACCEPTED on 2026-06-04.

## Context

When `/compose` lifts a session trace into a workflow, every argument that was
not linked to a prior step's output is frozen as a literal. A workflow lifted
from a "fetch this URL, write to this path" session therefore replays those
exact constants on every run — it cannot fetch a *different* URL or write to a
*different* path. This makes lifted workflows single-use rather than reusable
tools.

The baseline (v1) Workflow IR is a "LEAN tier": arguments are either `literal`
or `symref`, and `workflow.inputs` must be empty (guarded by an explicit
`inputs_not_supported_in_v1` check). To make a workflow reusable, a user needs
a way to promote a chosen literal into a named, typed parameter, optionally with
a default.

Forces at play:

- The lift transform must stay pure and deterministic ("same trace produces
  byte-identical IR"), so parameterization cannot be folded into it.
- Parameters need a JSON-Schema type, a required/optional flag, and a default
  (for optional inputs) so the manifest `inputSchema` can be projected and the
  executor can seed values at run time.
- Scope, name-format, collision, and default rules should have a single source
  of truth rather than being duplicated across transform, validator, and
  executor.

## Decision

Add a separate, pure `parameterize` transform that runs after `liftFromTrace`.
It rewrites chosen literal arguments into `SymRef`s that target declared
workflow inputs, while lift itself stays unchanged and continues to emit
`inputs: []` plus literal fallbacks. The IR is widened from `inputs: string[]`
to a typed `WorkflowInput[]` (name, JSON-Schema fragment, required flag,
optional default, optional description). Declared inputs are in scope as
bindings from step 0, so the existing symref-resolution machinery resolves an
input reference exactly like a reference to a prior step's result.

The `inputs_not_supported_in_v1` guard is removed and replaced with
input-specific validation (invalid name, duplicate, binding collision, optional
input missing a default, invalid schema). The executor seeds each input from the
caller's value, falling back to the default, and errors when a required input is
missing. The agent loop validates workflow input against the projected
`inputSchema` (via Ajv) before execution. The factory gains `previewWorkflow`
(lift without persisting) and `createWorkflow(promotions[])`, and `/compose`
presents the lifted literals so the user can choose which to promote.

## Consequences

- Lifted workflows become genuinely reusable, parameterized tools rather than
  constant replayers.
- The typed `WorkflowInput[]` IR and the "input is a symref target in scope
  from step 0" model became the foundation that later work built on. In
  particular, the `llm_generate` capability (ADR 002) relies on being able to
  promote an instruction recipe to a workflow input, and reference-based data
  passing (ADR 003) extends the same symref mechanism with field projection.
- Keeping `parameterize` a pure, standalone transform (validation rules living
  only in the validator) established the project's recurring pattern of pushing
  behavior into the narrowest, most testable seam.
- A workflow now carries a real `inputSchema`, which later made human review of
  workflows (ADR 005) and output-shape enforcement (ADR 007) meaningful.
