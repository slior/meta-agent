# ADR 004: Registry Integrity Verification

## Status

ACCEPTED on 2026-06-26.

## Context

The approval model rests on a content hash that binds a manifest to its body
(`tool.ts` or `workflow.json`) and an approval record to that manifest. For an
on-disk tool to be trustworthy, two links must hold: Link A (the manifest's hash
equals the recomputed hash of its body) and Link B (the approval's hash equals
the manifest's hash).

The baseline registry verifies neither at the persistence boundary. It parses
`manifest.json`, `approval.json`, and the body and trusts the stored
`manifest.hash` as-is. The approval-policy check compares `approval.hash` to
`manifest.hash`, but both are blindly read from disk, so the comparison is
self-referential. As a result, hand-editing a tool's body while leaving the
stale hash and approval in place lets the system execute code that was never
approved under the recorded hash. There is also a related hole: a low-tier tool
with no approval record runs with zero prompts.

Alternatives considered:

- Verification inside `FsToolRegistry` backed by a standalone pure module
  (chosen for POC simplicity).
- A `VerifyingToolRegistry` decorator wrapping any registry (rejected for now —
  the cache and quarantine-at-load semantics live where files are read, so a
  decorator would double-read files or need raw-byte access; recorded as the
  long-term direction).
- Lazy verify-at-read (rejected — tampered tools would still surface in `list`
  and the catalog, and hashing would repeat on every read).

## Decision

Recompute and verify Link A and Link B at the persistence boundary — on load
(durable state entering memory) and on save (state leaving memory) — using a
pure, I/O-free `registry/integrity.ts` module. On load, a Link A failure
quarantines the tool (it is not inserted into the cache, so it is undiscoverable
and unrunnable, even under `yolo`), and a Link B failure marks the tool
needs-review (it loads with `approval: null` and re-prompts on every execution).
On save, an inconsistent tool throws a `RegistryIntegrityError` so the registry
can never persist a self-inconsistent entry.

The approval policy is tightened so that a `null` binding approval always
prompts at Gate 2/3, bypassing the low-tier fast path, the session cache, and
always-approve. This reuses the existing `approval === null` seam rather than
adding new policy surface, and it simultaneously closes the standalone
zero-prompt hole. `yolo` still auto-approves execution of authentic-but-
unapproved (needs-review) tools, but quarantine (Link A) applies even under
`yolo`, because a corrupted tool never becomes runnable.

## Consequences

ADR 009 extends the integrity-status set with `invalid` for a body that passes
Link A but is structurally unusable; this is distinct from `quarantined`.

- The on-disk approval model becomes authoritative: any edit to a body or
  manifest invalidates approval, and tampered tools cannot run.
- Keeping the verification logic in a standalone pure module makes the future
  `VerifyingToolRegistry` decorator a cheap lift with no change to the core.
- The `getApproval` returning `null` for needs-review tools is exactly the seam
  that `PolicyEnforcedSandbox` (ADR 006) later reads to enforce approval
  structurally.
- The save assertion required migrating placeholder-hash test fixtures to a
  shared `makeConsistentTool` helper — the main cost of the change.
