# ADR 005: Workflow Gate 1 Approval

## Status

ACCEPTED on 2026-06-26.

Assumes [ADR 001: Workflow Parameterization](001-workflow-parameterization.md).

## Context

Atomic and composite tools go through a human Gate 1 review at creation time,
where a reviewer sees the draft and its smoke-test result before it is saved.
Workflow tools created via `/compose` bypass this review entirely — they are
lifted and saved without any human sign-off, even though a workflow's real
authority is the union of everything its steps can do.

Forces and considerations:

- Gate 1 for code tools reviews a draft plus a smoke result; a workflow has no
  code and no smoke test, but it does have an IR, a manifest, an input schema,
  and a set of effective permissions. The review surface is different, so a
  single flat payload type does not fit both.
- A reviewer must be able to see what the workflow does and what it can touch,
  in human-readable form — raw IR JSON is not reviewable.
- The change should not disturb the existing code-tool review path or `yolo`
  behavior.

## Decision

Route `ToolFactory.createWorkflow` through the same `ApprovalPolicy.reviewDraft`
entry point as code tools, using a discriminated `Gate1ReviewPayload` union
(`code | workflow`) and a matching `Gate1Decision` union. The workflow payload
carries the workflow IR, its manifest, the effective permissions, and a literate
rendering. The reviewer for a workflow can approve, always-approve, reject, or
edit only the name and description (not the structure).

The effective permissions shown to the reviewer are computed as the union of all
step-dependency permissions (allowlist wins over none; path/host/env arrays are
deduplicated), using a shared `unionPermissions` helper extracted from
`lift.ts`. The workflow is presented via a literate rendering plus a
human-readable parameter list derived from the input schema, and its permission
set reuses the same permission table as code-tool review. Under `yolo`, workflow
creation auto-approves with `alwaysApprove: false` and `notes: "yolo"`,
consistent with the documented model.

## Consequences

- Workflow tools now get the same human sign-off as code tools, closing an
  approval-surface gap.
- The discriminated `Gate1ReviewPayload` / `Gate1Decision` unions gave the
  approval interface room to grow for future tool kinds without a new entry
  point.
- Reviewability depends on the parameterized workflow work (ADR 001): a workflow
  has a real input schema and parameters to display precisely because
  parameterization introduced them.
- The `presentAndSave` review path this touched is the same path that
  output-contract enforcement (ADR 007) later extends to re-validate edited
  drafts.
