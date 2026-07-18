# ADR 003: LLM Call Tracing and Reference-Based Data Passing

## Status

ACCEPTED on 2026-06-07.

Assumes [ADR 001: Workflow Parameterization](001-workflow-parameterization.md)
and [ADR 002: LLM Tool Calls in the Workflow IR](002-llm-tool-calls-in-workflow-ir.md).

## Context

Two related problems.

First, an observability gap: the trace — the canonical session artifact —
records LLM turns only as token-usage metadata, never the actual prompt or
produced content. What the model was asked and what it returned is visible only
through an optional, separate debug sink.

Second, a lifting failure that ADR 002 did not fully close. Because the agent's
orchestration turn receives the entire tool output inlined into its context, the
easiest completion is to transform that data "in its head" and type the digest
directly into the next tool's argument. That transformation is not a tool call,
so lift has no edge to bind and freezes a literal. A related gap: even a
well-behaved agent passing `fetchResult.text` gets a literal, because lift only
matches against a prior step's *whole* output.

Considerations and alternatives:

- The wrong path (transform in-head) is the *easiest* path, and prompt-only
  nudging had already proved unreliable.
- Options weighed: lift orchestration turns (rejected — a turn's input is the
  whole conversation and its output mixes reasoning with tool calls);
  prompt-nudging plus a lift-time diagnostic (insufficient alone, kept only as
  an optional safety net); and reference-based data passing (chosen).

## Decision

Add full-content LLM tracing by decorating the host `LLMProvider` with a
`TracingLLMProvider` that emits an `llm-call` event carrying the resolved
request and response, tagged by phase. Because every host call already flows
through one provider, a single decorator covers orchestration, synthesis, the
mediated `llm_generate` capability, and factory calls. This part is independent
and can ship first.

For reliable lifting, stop feeding large tool outputs back to the agent as raw
bytes. Store each successful output in an in-memory session result store keyed by
a binding id, and feed the agent back only a compact `{ ref, shape, preview }`
descriptor when the output is large. The agent refers to a prior output with a
`{ "$ref": "<binding>", "path": "<key>" }` sentinel object, which the host
resolves to a concrete value before dispatch — so the sandbox still receives
fully concrete arguments and no protocol changes. Malformed or unknown
references become loud, recoverable errors routed into the existing
invoke-failure loop. The `SymRef.path` field is turned on (single top-level key)
across types, validator, and executor, and lift becomes authoritative on
recorded references (value-matching remains only a fallback).

## Consequences

- Withholding large outputs makes in-head transformation *impossible* rather
  than merely discouraged; the binding id turns "use a prior output" into a copy
  task, and mistakes fail loudly instead of becoming silent literals discovered
  at lift time. Worst case for any single edge degrades to the old behavior
  (a literal) — never worse.
- Field projection (`fetchResult.text`) now lifts to a projected symref.
- The trace becomes a complete record of model interaction, at the cost of the
  trace now holding full prompts and outputs (a local dev JSONL; no secret
  scrubbing was added, and API keys are never part of a request payload).
- The result store this introduced is exactly the store that output-contract
  enforcement (ADR 007) later protects, ensuring a malformed value never becomes
  referenceable.
