# ADR 002: LLM Tool Calls in the Workflow IR

## Status

ACCEPTED on 2026-06-05.

Assumes [ADR 001: Workflow Parameterization](001-workflow-parameterization.md).

## Context

A `/compose` of a "fetch a page, summarize it, write the summary" session
produced a broken workflow: the summary was frozen as a literal, so the workflow
wrote *that one paper's summary* on every run instead of summarizing its input.
The root cause is structural — the summary was produced by the agent's own
free-form reasoning, which is not a tool call, so lift had nothing to bind and
froze the value.

To fix this, a workflow step must be able to produce a value by calling the
model, and that call must appear in the trace so it can be lifted.

Forces and considerations:

- `/compose` lifts only from tool calls, so generation must happen *through a
  tool* to ever appear in a workflow.
- The project's security stance forbids ambient authority in tool code and
  keeps the model out of the execution loop (code/data separation). An "open
  hole filled by the model at run time" would violate both.
- Reaching the model needs an API key and network — the exact primitives a
  poisoned or coerced tool could use to exfiltrate data.

Alternatives considered:

- Shape of the capability: a generic `llm_generate` primitive (chosen) vs.
  factory-minted specialized tools (nothing in a trace to lift into one) vs.
  both, primitive first (chosen as the trajectory).
- Where the call executes: sandbox-direct with net + key (rejected — hands
  exfiltration primitives to tool code) vs. a host special-case in
  `dispatchTool` (rejected — an all-or-nothing magic name, not hash-gated) vs.
  a mediated capability (chosen).

## Decision

Model model-generation as an ordinary `tool_call` to a built-in `llm_generate`
tool — no new argument kind and no new step kind, so the IR grammar is unchanged
and the call rides the existing lift, parameterize, and validate paths. The tool
does no networking itself; it calls a mediated `globalThis.llm` capability that
mirrors the existing `invokeTool` RPC. The sandbox parent services the request
using the host `LLMProvider`, so the API key and outbound network stay entirely
in the host and never enter the child.

The capability is gated by a new `capabilities?: string[]` manifest field that
participates in the tool hash, so granting it re-triggers human approval. The
host wires the `onLlm` handler only when the tool declares the capability, and
the parent refuses an `llm` frame from a tool that did not declare it (defense in
depth). `llm_generate` ships as a trusted, pre-approved built-in with
`net: "none"`, `env: []`, and `sourceLabels: ["llm_generated"]`; the static
validator forbids LLM-authored drafts from granting themselves the capability.
The host builds the whole prompt envelope and strips tool definitions and
`tool_choice`, so the mediated call cannot become an agentic sub-session.

## Consequences

- Generative steps now appear in traces and lift with every edge bound, so
  `fetch → llm_generate → write` composes into a workflow that re-summarizes its
  real input.
- The mediated-capability pattern (a per-tool, hash-gated, host-serviced RPC)
  became a reusable seam that any future blessed capability can follow.
- Seeding `sourceLabels: ["llm_generated"]` means a future taint/VERIFY checker
  works with no retrofit.
- The plan left an open question — how to reliably route generation through
  `llm_generate` rather than by prompt persuasion — which ADR 003
  (reference-based data passing) resolves structurally.
- Because the model is confined to producing data for a slot the fixed plan
  already decided to fill, this preserved code/data separation and set up the
  network hardening in ADR 010, whose "no exfiltration primitive" argument
  assumes an honest network boundary.
