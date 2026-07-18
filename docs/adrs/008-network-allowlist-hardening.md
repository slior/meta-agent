# ADR 008: Network Allowlist Hardening

## Status

ACCEPTED on 2026-07-18.

No implementation dependencies on prior ADRs. Completes the network boundary
that [ADR 002: LLM Tool Calls in the Workflow IR](002-llm-tool-calls-in-workflow-ir.md)
assumes for its "no exfiltration primitive in the child" guarantee.

## Context

The `net: "allowlist"` manifest constraint is supposed to restrict a sandboxed
tool to a set of hosts, but the baseline enforcement is weak. Direct HTTP client
modules (`node:http`, `node:https`, `undici`, `node:fetch`) are permitted as long
as the tool has net permission, and the allowlist is enforced by a shim that
monkey-patches `fetch`. The shim has several holes: it skips entirely when the
allowlist is empty (a bypass), it reads the host off the wrong shape for `URL`
and `Request` inputs (a bypass), and it lets `fetch` auto-follow a 3xx redirect
to an unchecked host. Worse, the ESM named exports of modules like `node:http`
and `undici` are read-only and cannot be reliably guarded in-process, so multiple
network routes stay unguarded regardless of the shim.

Forces and considerations:

- The manifest network schema should not change (`net: "none" | "allowlist"`,
  `netAllowlist: string[]`), and no new subprocess or dependency should be added.
- There must be a single guardable network chokepoint, since guarding several
  client modules in-process is not reliable.
- The constraint should fail closed and return a clear error the agent can act
  on.

Alternative considered and rejected: patching `fetch`, `undici`, and
`http.request` individually — the non-`fetch` clients' read-only ESM exports
cannot be reliably wrapped, leaving unguarded routes.

## Decision

Make network access fetch-only. Static validation forbids importing
`node:http`, `node:https`, `undici`, and `node:fetch` outright (a hard failure
regardless of declared net mode), leaving the global `fetch` as the single
sanctioned network path, and it requires a non-empty `netAllowlist` when
`net: "allowlist"`.

Harden the runner's `fetch` shim so the boundary is honest: it activates on the
*presence* of the allowlist environment variable (an empty-but-present value
means "active, zero hosts" and blocks everything — fail closed), extracts and
checks the host from `string`, `URL`, and `Request` inputs, forces
`redirect: "manual"` so a response cannot auto-follow a 3xx to an unchecked host
(the tool must re-`fetch` the target, which is re-validated), and returns a
`permission_denied` error for a blocked host instead of a generic runtime error.
The manifest schema and the parent env plumbing are unchanged.

## Consequences

- `net: "allowlist"` becomes an honest, hard-to-bypass constraint with a single
  audited chokepoint, and blocked access is reported as `permission_denied`.
- The host allowlist remains an application-layer (shim) guard, not an OS
  socket-level jail; the coarse `--allow-net` flag plus human-in-the-loop remain
  the hard guards, and a socket-level jail is noted as future hardening.
- Tools that used non-`fetch` HTTP clients will now fail static validation and
  must be rewritten to use `fetch`.
- This completes the network side of the project's security stance that earlier
  decisions assumed — in particular, the "no exfiltration primitive in the
  child" argument behind the mediated LLM capability (ADR 002) depends on the
  network boundary actually being honest.
