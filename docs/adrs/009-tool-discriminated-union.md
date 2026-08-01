# ADR 009: Tool Discriminated Union and Explicit Registry API

## Status

ACCEPTED on 2026-08-01.

Assumes [ADR 003: LLM Call Tracing and Reference-Based Data Passing](003-llm-tracing-and-reference-based-data-passing.md),
[ADR 004: Registry Integrity Verification](004-registry-integrity-verification.md),
and [ADR 005: Workflow Gate 1 Approval](005-workflow-gate1-approval.md).

## Context

The original saved-tool model overloaded `Tool.code`: atomic and composite
tools held TypeScript source, while workflows temporarily held serialized
workflow IR. `FsToolRegistry.save` had to parse that string to write
`workflow.json`, then retained a `code: ""` placeholder alongside a parallel
workflow map. This makes generic code responsible for interpreting a field by
kind, makes workflow hashing depend on ad-hoc caller serialization, and leaves
the in-memory model unlike the persisted object.

This is the M1 issue identified in the discriminated-union design review.
ADR 005 already established that differing code and workflow review payloads
need an explicit discriminated union. Registered tools need the same property,
without weakening ADR 004's Link A (manifest-to-body) and Link B
(approval-to-manifest) guarantees.

## Decision

Model registered tools as a `Tool` discriminated union owned by `tool.ts`:
`CodeTool` pairs an atomic or composite manifest with TypeScript `code`, and
`WorkflowTool` pairs a workflow manifest with typed `workflow` IR. Workflow IR
is never serialized into `code`, and workflow cache entries have no empty-code
placeholder. `CodeKind` remains in `types.ts` so drafts can be restricted to
code kinds without a type-module cycle.

Make the public registry API kind-explicit. Replace polymorphic `get` and
`save` with `getCode`, `getWorkflow`, `saveCode`, and `saveWorkflow`; add
`getKind` and `getManifest` for metadata-only reads. `getWorkflow` returns a
`WorkflowTool`, so callers use `.workflow`. The registry continues to expose
`integrityReport()`. Kind-changing saves remove the alternate body file.

Replace generic public hashing with `hashCodeTool` and `hashWorkflowTool`.
`hashToolBody` is the package-internal raw-body primitive used by integrity
verification and the sandbox, and is deliberately not re-exported from the
public package barrel. New workflow saves use `serializeWorkflowBody`, but
rehydration hashes the exact `tool.ts` or `workflow.json` bytes read from disk:
it must never parse, reserialize, then hash. This preserves Link A for valid
legacy workflow files regardless of their formatting. After Link A succeeds,
workflow bytes are parsed structurally before caching; a structural failure is
reported as `invalid`, while a Link A mismatch remains `quarantined`.
`saveWorkflow` performs that structural validation before writing.

Preserve the execution boundary as well as the persistence boundary. Before a
code tool is spawned, the sandbox recomputes Link A from its code using
`hashToolBody`; a mismatch returns `permission_denied` and does not spawn a
child. For workflow dispatch, the agent loop fetches the `WorkflowTool` once
and uses that same snapshot for input validation, approval, and executor run,
preventing an approve-one/run-another fetch split.

## Consequences

- The type system and registry API make code and workflow bodies explicit,
  removing the workflow-string convention and the parallel workflow cache.
- Existing public callers must migrate from `hashTool` and registry `get`/`save`
  to the kind-specific replacements; `getWorkflow` callers now dereference
  `.workflow`.
- Raw-byte load verification preserves previously approved on-disk bodies, while
  new saves have one owned workflow serialization format.
- `invalid` becomes a discoverable integrity diagnostic for structurally
  unusable but hash-authentic workflow bodies; it does not change the meaning
  of ADR 004's quarantine status.
- Code execution gains a final Link A check at the sandbox boundary, and
  workflow approval/execution binds to one fetched snapshot.
