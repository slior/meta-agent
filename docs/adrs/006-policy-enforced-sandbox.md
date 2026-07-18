# ADR 006: PolicyEnforcedSandbox

## Status

ACCEPTED on 2026-07-03.

Assumes [ADR 004: Registry Integrity Verification](004-registry-integrity-verification.md).

## Context

`Sandbox.execute(tool, args, approvalToken, opts)` takes an `ApprovalToken`
parameter that suggests execution is gated by an approval check. In reality
`NodePermissionSandbox` ignores it (`_approvalToken`): the token is a random
string that authorizes nothing. Approval enforcement lives instead as a
convention in the agent loop, which any future caller holding a `Sandbox` could
forget or bypass. This is design-review finding H4 — the enforcement is not
structural, and the token gives a false impression of safety.

Forces and considerations:

- The raw execution interface should be honest about what it is: a subprocess
  mechanism with no policy knowledge.
- Approval enforcement must be impossible to bypass by construction, not by
  discipline.
- The tool factory legitimately runs smoke tests *before* Gate 1 approval, so
  it must be exempt from execution policy.
- Double-gating must be avoided: a tool should not be policy-checked twice.

## Decision

Delete the `ApprovalToken` type and remove the parameter from `Sandbox.execute`,
making the raw sandbox a pure subprocess mechanism. Introduce
`PolicyEnforcedSandbox`, a `Sandbox` implementation that wraps a raw sandbox and
calls `ApprovalPolicy.checkExecution` before delegating; on rejection the inner
sandbox is never reached. `AgentLoop` is typed to require a
`PolicyEnforcedSandbox` (not a raw `Sandbox`), so the approval check is
structurally in the execution path at compile time.

The `ToolFactory` keeps the raw inner sandbox for smoke tests (explicitly exempt
from execution policy), while the agent loop gets the wrapped one. The loop's
execution path is split: `runWithApproval` keeps the in-loop policy check for
workflow tools (which run in-process, not through the sandbox), and a new
`runWithTracing` handles sandbox tools with tracing only — no policy call, since
the wrapper performs it. A policy rejection surfaced by the wrapper is recovered
in `runWithTracing` by inspecting the result kind, so tracing semantics
(`execution-denied` vs. `tool-invoked`) are preserved.

## Consequences

- Approval enforcement is now a structural property of the type system rather
  than a caller convention; a holder of a `PolicyEnforcedSandbox` cannot bypass
  the gate.
- The wrapper reads the approval record through the registry, so it naturally
  benefits from registry integrity verification (ADR 004): needs-review tools
  return a `null` approval and are re-prompted.
- The `runWithTracing` method introduced here became the single shared exit
  point for all three tool kinds, which output-contract enforcement (ADR 007)
  then used as its one insertion point for output validation.
