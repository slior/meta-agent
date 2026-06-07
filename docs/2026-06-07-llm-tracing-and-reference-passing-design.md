# LLM Call Tracing and Reference-Based Data Passing

**Status:** Design (pre-implementation)
**Date:** 2026-06-07
**Scope:** Two related changes. (1) **Observability:** emit the full request/response of every host LLM call into the trace, not just token usage. (2) **Reliable lifting:** stop the agent from transforming intermediate data "in its head," by feeding tool outputs back to it as *references* (handles) instead of raw bytes. The agent then wires references between tools, those references are recorded, and `liftFromTrace` reads them directly instead of guessing by value-matching.

**Related:**
- [`2026-06-05-llm-tool-call-design.md`](./2026-06-05-llm-tool-call-design.md) — the mediated `llm_generate` capability. This spec resolves its Open Question #3 ("nudge the agent to route generative work through `llm_generate` so such steps appear in traces and lift").
- [`2026-06-04-workflow-parameterization-design.md`](../2026-06-04-workflow-parameterization-design.md) — promoting lifted literals into typed workflow inputs.

---

## 1. Problem

### 1.1 The lifting failure (motivating bug)

A `/compose` of a `fetch → summarize → write` session produced a workflow whose `llm_generate` `input` was a **literal**, not a `symref` to the fetched text. Root cause, established by tracing the session:

The agent's **orchestration LLM turn** receives the entire 24k-char `fetch-webpage-text` output in its context (it is inlined into the conversation as a `tool` message). When it then wants a summary, the easiest completion is to **write the summary itself** and type the digest into `llm_generate`'s `input` — or even pre-digest the text before calling `llm_generate` at all. That transformation happened in the agent's reasoning, which is **not a tool call**, so:

- `liftFromTrace` had no prior-step output that byte-matched `input`, so it froze `input` as a literal.
- The resulting "workflow" re-summarizes *that one session's digest* every run instead of summarizing its actual input.

This is not a bug in `llm_generate` wiring or in lift's matching logic — both are correct given what the trace contained. The defect is structural: **the agent has an untraceable data-transformation channel (its own reasoning), and lift cannot recover an edge that was never expressed as a tool call.**

A second, related structural gap: even a well-behaved agent that passes `fetchResult.text` (a *field* of a prior object output) gets a literal, because lift only binds against a prior step's **whole** output (`canonicalJson` equality, no field projection).

### 1.2 The observability gap

The full LLM request/response is visible only via the optional `--debug` OpenAI sink (`resolve-debug.ts`), which is separate from the trace. The trace records LLM turns (`llm-turn`, `llm-synthesis`, `factory-repair-llm`) but only as **token-usage metadata** — never the prompt or the produced content. So the trace, which is the canonical session artifact, cannot show what the model was actually asked or what it returned.

### 1.3 What we want

1. The trace contains the full request/response of every host LLM call (orchestration, synthesis, mediated `llm_generate` capability, factory draft/repair).
2. The agent routes *all* data transformations through liftable tool calls (chiefly `llm_generate`), so `fetch → llm_generate → write` chains lift with every edge bound — reliably, not by prompt persuasion alone.
3. Field projection (`fetchResult.text`) lifts to a projected `symref`.

---

## 2. Goals and non-goals

### Goals
1. **Full-content LLM tracing** across all host LLM call paths, via a single seam.
2. **Reference-based tool-output feedback:** the agent receives a handle + shape + bounded preview for non-trivial tool outputs, not the raw value.
3. **Reference arguments:** the agent expresses "use a prior output" as a structured, validated reference (with top-level field projection), resolved by the host before execution.
4. **Authoritative lift:** `liftFromTrace` derives `symref`s from recorded references, not from value-matching guesswork; value-matching remains a fallback for inlined scalars.
5. **Enforcement without persuasion:** because large data is withheld, in-head transformation is impossible; malformed/unknown references fail loudly and recover through the existing invoke-failure loop.

### Non-goals (deferred)
- **Lift-time "derived literal" diagnostic** (flag a large literal that matches a shown preview). Designed in §9.1 but **optional / not in Phase 1**.
- **Nested-path projection** (`a.b.c`). Phase 1 supports **single-key** projection only (covers `fetchResult.text`).
- **Branch/loop step kinds.** Unchanged; still rejected.
- **Trace redaction / secret scrubbing policy.** Noted as residual risk (§7); the trace is a local JSONL dev artifact.
- **Persisting the result store** beyond the live session.

---

## 3. Background: the relevant machinery today

- **Tracer (`tracer.ts`).** Single JSONL writer. `log(kind, data)` appends `{ ts, sessionId, kind, data }` and notifies observers (the CLI progress printer) before disk write. All LLM events today carry only `{ turn, usage }`-style metadata.
- **Host LLM boundary.** Every real model call goes through `opts.llm: LLMProvider` (`chat`, `generateStructured`) in the host. Call sites: the agent loop's orchestration turn and synthesis pass, `runLlmCapability` (mediated `llm_generate`), and the factory's draft/repair.
- **Tool-output feedback (the elision point).** After dispatch, the agent loop inlines the entire result into the conversation:

```234:238:packages/core/src/agent/agent-loop.ts
    messages.push({
      role: CHAT_ROLE.tool,
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });
```

- **Invocation capture for lift.** `onToolInvoked` pushes `{ name, args, ok, value }` per executed registry tool (`repl.ts`); `/compose` slices these and calls `liftFromTrace`.
- **Lift (`workflow/lift.ts`).** Assigns `binding = r_${i}_${tool}` per slice position; binds an argument to a prior binding when `canonicalJson(arg)` equals a prior step's whole output, else freezes a literal.
- **IR (`workflow/types.ts`).** `SymRef = { kind, ref }` with `path?` **already reserved** (commented) for a future tier. The executor resolves bindings; the validator checks symref targets exist.

The design reuses all of these seams; it does **not** touch the sandbox/runner stdio protocol (reference resolution is entirely host-side; the child still receives fully concrete args).

---

## 4. Options considered (recap; decided in brainstorming)

| Option | Description | Verdict |
|---|---|---|
| **2 — Lift orchestration turns** | Detect when a turn's output feeds a later tool; synthesize an `llm_generate` step heuristically. | **Rejected.** A turn's input is the whole conversation (ambiguous binding); its output mixes reasoning + tool-calls; the lifted "step" would replay agent reasoning over session-specific context — not a deterministic workflow. |
| **1b — Prompt nudging + lift diagnostic** | Keep inlining full outputs; tell the agent (in the prompt) not to transform in-head; flag derived literals at lift time. | **Insufficient alone.** The wrong path (transform in-head) stays the *easiest* path; already attempted via prompt and proved unreliable. The diagnostic is kept as an **optional** safety net (§9.1). |
| **1a — Reference-based data passing** | Withhold large tool outputs; feed back a handle + shape + preview; agent wires references; record them; lift reads them. | **Chosen.** Removes the wrong path structurally; references are a copy task; malformed refs fail loudly; also fixes field projection. |

**Enforcement rationale (why 1a is not "just a better prompt"):** withholding the bytes makes in-head transformation of large data *impossible*; the binding id is shown to the agent so emitting a reference is a copy, not a generation; references are validated, so mistakes are loud, recoverable runtime errors instead of silent literals discovered at lift time. Worst case for any single edge degrades to a literal — i.e. today's behavior — never worse.

---

## 5. Design

### 5.1 Observability — full-content LLM tracing via a decorator

Introduce a `TracingLLMProvider` that **decorates** the host `LLMProvider` and is the single seam through which all host calls already pass. It logs a new trace event around each call:

```ts
// new TRACE kind
TRACE_KIND_LLM_CALL = "llm-call";

// data payload
{
  phase: "orchestration" | "synthesis" | "capability" | "factory-draft" | "factory-repair",
  method: "chat" | "generateStructured",
  request: { messages, tools?, toolChoice?, schemaName? },   // the resolved request actually sent
  response: { content?, tool_calls?, structured? },           // full produced content
  usage,
}
```

- **Single seam, all paths.** Because every path uses `opts.llm`, wrapping the provider once covers orchestration, synthesis, the mediated capability, and factory calls. `phase` is supplied via a lightweight call-context (e.g. an optional tag on the request or an AsyncLocalStorage set at each call site) so the event is attributable without changing each call site's shape.
- **Existing phase markers stay.** `llm-turn(-start)`, `llm-synthesis(-start)`, `factory-repair-llm` remain for ordering/usage; `llm-call` adds the content. (We may later collapse these, but not in Phase 1.)
- **Resolved content.** For the mediated capability, the request is logged **after** reference resolution (§5.2.4), so the trace shows the real input the model saw even though the agent only handled a reference. This is the deliberate answer to "what content appears in the trace."
- **Observer output unchanged.** The CLI progress printer ignores `llm-call` (or prints a one-liner); full content lives in the JSONL.

This workstream is **independent** of §5.2–§5.5 and can land first.

### 5.2 Reference-based data passing

#### 5.2.1 Session result store
An in-memory map owned by the agent loop: `binding → { value, shape }`. Each **successful** registry-tool invocation is assigned a binding **at invocation time**, using lift's existing scheme `r_${i}_${tool}` where `i` is the session-global invocation index. This is the "intermediate session state" — a map, not a process or file.

#### 5.2.2 Output elision + preview
At the elision point (`agent-loop.ts:234–238`), replace the inlined value with a compact descriptor when the serialized value exceeds a size threshold `ELISION_MAX_BYTES`:

```jsonc
{ "ok": true,
  "ref": "r_0_fetch_webpage_text",
  "shape": { "type": "object", "keys": ["title","text","url","contentLength","truncated"] },
  "preview": { "text": "<first PREVIEW_CHARS chars>…", "contentLength": 24291 } }
```

- Small scalar/short results are still inlined verbatim (they lift fine via value-matching and the agent legitimately needs them to reason/plan).
- The preview is explicitly **partial and non-authoritative**; the prompt states the full value is only reachable via the `ref`.

#### 5.2.3 Reference argument syntax (with projection)
The agent refers to a prior output using a **sentinel object** inside `invoke_tool` args (not a `@string` token — the object is unambiguous, JSON-native, and nests cleanly):

```jsonc
{ "instructions": "Summarize this paper as markdown",
  "input": { "$ref": "r_0_fetch_webpage_text", "path": "text" } }   // path optional; single key in Phase 1
```

#### 5.2.4 Reference resolution (runtime, host-side)
Immediately before dispatch, the loop deep-walks the parsed args, and for each `$ref` sentinel looks it up in the result store, applies `path` (single top-level key) if present, and substitutes the concrete value. The sandbox/executor then run with fully concrete args — **no protocol change**. Resolution errors are structured failures:

- unknown ref → `{ ok:false, error:"unknown ref 'r_5_foo'; available: r_0_fetch_webpage_text, r_1_llm_generate" }`
- missing path key → `{ ok:false, error:"ref 'r_0_...' has no key 'txt'; keys: title,text,url,..." }`

These route into the existing invoke-failure recovery so the agent self-corrects in-loop:

```200:205:packages/core/src/agent/agent-loop.ts
    if (invokeFailedThisBatch) {
      messages.push({ role: CHAT_ROLE.user, content: INVOKE_FAILURE_RECOVERY_USER });
    }
```

#### 5.2.5 Recording references for lift
`onToolInvoked` (and the `tool-call` trace event) record the **unresolved** args (sentinels intact) plus the resolved `value`. The invocation record becomes:

```ts
type InvocationRecord = {
  name: string;
  args: unknown;          // UNRESOLVED (may contain { $ref, path })
  ok: boolean;
  value: unknown;         // resolved output (for the result store / value-match fallback)
  binding: string;        // runtime binding id assigned at invocation
};
```

### 5.3 IR, validator, executor — turn on `SymRef.path`

```36:41:packages/core/src/workflow/types.ts
export type SymRef = {
  kind: typeof ARG_KIND.symref;
  ref: string;
  // Reserved for tier B (parser rejects non-undefined `path` in v1):
  // path?: string;
};
```

- **Types:** un-reserve `path?: string` (single key in Phase 1).
- **Validator (`workflow/validator.ts`):** accept `path` on a `symref`; keep all existing target-exists checks. (Optionally validate the key is a plausible identifier; the produced shape is not statically known, so this stays lenient.)
- **Executor (`workflow/executor.ts`):** when resolving a `symref` with `path`, resolve the binding then index the single key; a missing key is a runtime step error (consistent with §5.2.4).

### 5.4 Lift — read references, translate slice-local

`liftFromTrace` becomes authoritative on recorded refs:

1. For each invocation in the slice, walk its **unresolved** args:
   - `{ $ref, path }` pointing at a binding **inside the slice** → `symref` to that step's slice-local binding, carrying `path`.
   - `{ $ref }` pointing at a binding **outside the slice** (before the selected range) → **literal**, using the resolved `value` projected by `path` (recovered from the invocation's resolved args / result store).
   - any other value → existing behavior: value-match against prior whole outputs → `symref`, else `literal`.
2. Slice-local binding ids keep the existing `r_${i}_${tool}` scheme (`i` = position in slice), so runtime ids are **translated**, not leaked. This preserves "same trace ⇒ byte-identical IR."

Result for the motivating case:

```
fetch                                  → r_0_fetch_webpage_text
llm_generate(input = symref r_0 .text) → r_1_llm_generate
write(content = symref r_1)
```

Every edge bound; field projection preserved.

### 5.5 System prompt
Teach the reference contract once (`agent/system-prompt.ts`, `builtins.ts`):

- Non-trivial tool outputs come back as `{ ref, shape, preview }`; the full value is reachable **only** via the `ref`.
- To use a prior output (whole or a field) in a later tool, pass `{ "$ref": "<binding>", "path": "<key>" }` — do **not** retype or summarize previewed data yourself.
- To transform data (summarize, reformat, extract), call `llm_generate` with the `$ref` as `input`.

The prompt only teaches syntax; withholding data + ref validation do the enforcing.

---

## 6. Touchpoints

| Area | File(s) | Change |
|---|---|---|
| Trace kind | `tracer.ts`, `index.ts` | Add `TRACE_KIND_LLM_CALL`. |
| LLM tracing seam | new `TracingLLMProvider` + wiring in `repl.ts` | Decorate `opts.llm`; log full request/response with `phase`. |
| Result store + elision + resolution | `agent/agent-loop.ts` | Store outputs; elide large values to `{ref,shape,preview}`; resolve `$ref` before dispatch; loud failures into recovery loop. |
| Invocation record | `agent/agent-loop.ts`, `cli/src/repl.ts` | Carry unresolved args + resolved value + binding. |
| IR | `workflow/types.ts` | Un-reserve `SymRef.path` (single key). |
| Validate | `workflow/validator.ts` | Accept `symref.path`. |
| Execute | `workflow/executor.ts` | Resolve projected symrefs. |
| Lift | `workflow/lift.ts` | Refs → symrefs (slice-local translation); out-of-slice ref → projected literal; value-match fallback. |
| Prompt | `agent/system-prompt.ts`, `agent/builtins.ts` | Reference contract. |

No change to `sandbox/*` stdio protocol.

---

## 7. Security / risk notes

- **Trace now contains full prompts + model output** (including fetched page content and any data routed through the model). The trace was already a local dev JSONL; this enlarges what it holds. No secret scrubbing is in scope (residual risk); API keys are never part of a request payload.
- **Reference resolution is host-side and concrete.** The sandbox still receives only resolved values; no new ambient authority. References are pure intra-session indirection.
- **Code/data separation preserved.** References point only at prior outputs of the *same* session plan; the executor resolves them deterministically. The model still never chooses control flow.

---

## 8. Phasing

- **Phase 1a — Observability.** `TracingLLMProvider` + `TRACE_KIND_LLM_CALL`. Independent, low risk; ship first.
- **Phase 1b — Reference-based passing.** Result store, elision/preview, `$ref` resolution + recovery, invocation-record change, `SymRef.path` (types/validator/executor), lift translation, prompt. This is the bug fix.
- **Optional / deferred — lift-time derived-literal diagnostic** (§9.1).

---

## 9. Open questions / decisions

### 9.1 Lift-time "derived literal" diagnostic (optional, deferred)
A safety net: at lift time, if an argument is a large **literal** whose value matches (or contains) a `preview` we showed the agent for some prior binding, flag or fail the lift with "looks derived from `r_k`; reference it instead." Catches the residual case where the agent reconstructs data from a preview. **Decided: design it, do not implement in Phase 1.**

### 9.2 Thresholds
`ELISION_MAX_BYTES` (when to elide vs inline) and `PREVIEW_CHARS` (preview length). Defaults TBD during implementation; pick conservative values (e.g. elide > ~1–2 KB serialized; preview ~200 chars) and make them constants.

### 9.3 `phase` propagation
Tag the request object vs. AsyncLocalStorage vs. distinct provider instances per call site. Leaning toward a small explicit tag on the call context to keep it obvious and testable.

### 9.4 Projection depth
Phase 1 = single top-level key. Nested paths (`a.b.c`) deferred until a real case needs them.
