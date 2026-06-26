# LLM Tool Calls in the Workflow IR

**Status:** Design (pre-implementation)
**Date:** 2026-06-05
**Scope:** Let a workflow step produce a value by invoking an LLM, so the result of model generation can flow through the IR as a `SymRef` instead of being frozen as a literal. Adds a built-in `llm_generate` tool backed by a **mediated, network-less sandbox capability**.

**Related:**
- [`2026-05-07-workflow-ir-design.md`](../2026-05-07-workflow-ir-design.md) — the LEAN-tier Workflow IR (literals + symrefs, lift-from-trace).
- [`2026-06-04-workflow-parameterization-design.md`](../2026-06-04-workflow-parameterization-design.md) — promoting lifted literals into typed workflow inputs.

---

## 1. Problem

The Workflow IR (LEAN tier) supports exactly two argument kinds: `literal` (a constant fixed at compose time) and `symref` (a reference to a prior step's `resultBinding` or a declared workflow input). Lift-from-trace links an argument to a prior step's output when their canonical JSON matches; otherwise it freezes the value as a literal.

This breaks down for values that an LLM produces *during* a run. The motivating case is the lifted `summarize_paper` workflow:

```jsonc
// steps[1] (write-file-text), abbreviated
"arguments": {
  "path":    { "kind": "symref",  "ref": "out_file" },
  "content": { "kind": "literal", "value": "# Summary of Key Innovations: ... (multi-KB markdown)" }
}
```

The summary the agent generated was never a tool output, so lift froze it as a literal. The "workflow" therefore writes *that one paper's summary* every time — it does not summarize its input. The generative step is missing from the IR entirely, because the agent performed it as free-form assistant text, not as a tool call.

We want the IR to express: *fetch a URL, summarize the fetched text with an LLM, write the summary*. Concretely, `content` must become `{ "kind": "symref", "ref": "<the summarize step>" }`.

### 1.1 What this is not

The fix is **not** a new argument `kind` (e.g. "filled by the model at run time") and **not** a new step kind. Adding an "open hole" argument that the model fills mid-execution would reintroduce the model into the execution loop — the exact thing the project's security stance forbids (see §7). Instead, generation is modeled as an ordinary `tool_call` to a tool that wraps the LLM. This keeps the IR grammar unchanged.

---

## 2. Goals and non-goals

### Goals
1. A workflow step can produce a value via an LLM call, bound to a `resultBinding` and consumed downstream by `SymRef`.
2. The capability is **liftable**: an LLM call in a session trace composes into the IR via the existing `liftFromTrace` path.
3. The capability is **parameterizable**: the instruction recipe can be promoted to a workflow input via the existing parameterization flow.
4. The LLM call introduces **no new ambient authority** in sandboxed tool code — no raw network, no API key in the child process.
5. Pre-populate the reserved VERIFY taint fields so future static verification treats LLM output as untrusted with no retrofit.

### Non-goals (deferred)
- **Factory-minted, purpose-specific LLM tools** (e.g. `summarize_paper_text` with a baked prompt and strong output schema). The generic primitive is the foundation; minting is a later layer (§4, Option C).
- **VERIFY itself** (taint analysis, automata, Z3). We only seed the manifest labels it will consume.
- **Per-session LLM-call budgets / cost accounting.** Noted as residual risk (§7.4).
- **Branching/loops** and `SymRef.path` — unrelated tiers.

---

## 3. Background: how the relevant machinery works today

- **Atomic / composite tools** are `manifest.json` + `tool.ts` (an exported `run(input)`), executed in a **sandboxed Node subprocess** (`NodePermissionSandbox`) under the Node permission model with explicit `permissions` (`fsRead`, `fsWrite`, `net`, `netAllowlist`, `env`) and `limits` (timeout, memory). The child has **no ambient authority**: only what the manifest grants.
- **Composite tools** delegate nested calls via an `invokeTool` RPC: the child writes an `invokeTool` stdout frame; the parent services it through the host `onInvokeTool` handler and replies with an `invokeToolResult` stdin frame (`sandbox/stdio-protocol.ts`, `sandbox/runner.ts`, `sandbox/node-permission-sandbox.ts`).
- **Workflow tools** are `workflow.json` (the IR), have **no code**, and run **in-process** via `WorkflowExecutor`, which dispatches each step back through `AgentLoop.dispatchTool`.
- **`AgentLoop.dispatchTool`** already special-cases meta-tools and `kind === "workflow"` in the trusted host; only atomic/composite tools reach the sandbox. The host already holds `opts.llm: LLMProvider` (with `chat` and `generateStructured`); **sandboxed code does not.**
- **Approval** is keyed on the manifest `hash`. Changing the manifest changes the hash and re-triggers the approval gate.

The chosen design reuses every one of these seams.

---

## 4. Options considered

Two orthogonal decisions: **(A) the shape of the capability** and **(B) where the LLM call executes**. The recommendation is A=primitive-first, B=mediated capability.

### 4.1 Decision A — shape of the capability

The decisive constraint is that `/compose` lifts from a trace of **tool calls**. The agent's free-form generation is not in the trace, so for an LLM step to ever appear in a composed workflow, the agent must have performed it **through a tool** at runtime. This tilts the decision toward a real, model-callable tool.

| Option | Description | Pros | Cons |
|---|---|---|---|
| **A1 — Generic primitive** (chosen) | One built-in `llm_generate(instructions, input, outputSchema)` the agent can call mid-task. | Rides existing lift/parameterize/validate unchanged; instructions are a small reusable recipe (data in the IR); minimal surface. | Output weakly typed (schema is per-call data); one privileged built-in. |
| **A2 — Factory-minted specialized tools** | Factory generates `summarize_paper_text` with a fixed prompt + output schema. | Strong per-tool `inputSchema`/`outputShape`; searchable; fixed reviewed prompt; per-tool taint labels. | Nothing in a trace to lift into one (generation is prose, not a `summarize_paper_text` call) → needs a separate authoring action; risks tool explosion. |
| **A3 — Both, primitive first** (direction) | Ship A1 now; later add "freeze this `llm_generate` step's instructions into a named, typed tool" reusing the factory. | Smallest change that closes the gap now; clean upgrade path to A2 where it pays off. | A2's machinery deferred, not free. |

**Chosen: A1, with A3 as the trajectory.** A1 is the smallest change that actually closes the `summarize_paper` gap and keeps the prompt as inspectable *data* in the IR (the Meijer "data, not code" stance).

### 4.2 Decision B — where the LLM call executes

| Option | Description | Pros | Cons |
|---|---|---|---|
| **B1 — Sandbox direct** | A normal `tool.ts` with `net` allowlist (LLM endpoint) + `env` (API key). | No new sandbox machinery; "just a tool". | **Breaks no-ambient-authority**: hands the API key and outbound network to subprocess code. A coerced/poisoned tool could exfiltrate. Highest blast radius. This is the risk the project explicitly avoids. |
| **B2 — Host built-in** | `dispatchTool` special-cases `llm_generate` and calls `opts.llm` directly, never entering the sandbox. | Secret/network stay in host; simplest data path. | Adds another magic name to `dispatchTool` alongside workflow/meta-tools; LLM access is "all or nothing" host behavior rather than a per-tool, hash-gated, approvable capability; the tool stops being a normal sandboxed unit. |
| **B3 — Mediated capability** (chosen) | Tool code in the sandbox calls a host-provided `globalThis.llm(req)` RPC (parallel to `invokeTool`); the host performs the call. | Secret/network stay in the host; the child holds only a function; reuses the proven `invokeTool` plumbing; capability is per-tool, declared in the manifest, hash-gated, and approvable. | Adds one RPC channel (protocol op + runner global + parent handler). |

**Chosen: B3.** It gives the security properties of B2 (no secret/network in the child) while keeping `llm_generate` an ordinary, hash-gated, approvable sandboxed tool, and it generalizes cleanly (any explicitly blessed tool can later request the capability). The cost is a small, well-understood addition that mirrors existing code.

---

## 5. Design

No new IR node, no new step kind. An LLM step is a `tool_call` to a built-in atomic tool, `llm_generate`, whose `tool.ts` does no networking itself — it calls a **mediated `llm` capability** the sandbox parent services using the host's existing `LLMProvider`.

### 5.1 Runtime data flow

```
WorkflowExecutor.executeToolCallStep
  -> dispatchTool("llm_generate", resolvedArgs, depth)
    -> AgentLoop.dispatchTool: kind === atomic
       -> sandbox.execute(tool, args, token, { onInvokeTool, onLlm })   // onLlm only if capability declared
          -> child runner: run(input) calls globalThis.llm(req)
             -> child writes {op:"llm", requestId, req} on stdout
                -> NodePermissionSandbox services it via onLlm(req)
                   -> onLlm calls opts.llm.generateStructured/chat IN THE HOST   // API key + network never enter the child
                <- parent writes {op:"llmResult", requestId, result} on stdin
             <- globalThis.llm resolves
          <- run() returns structured value
    <- ToolResult bound to the step's resultBinding
```

### 5.2 The IR shape (grammar unchanged)

`summarize_paper` lifts/composes to:

```jsonc
{ "kind": "tool_call", "label": "step_1_llm_generate", "tool": "llm_generate",
  "arguments": {
    "instructions": { "kind": "literal", "value": "Summarize key innovations as markdown." },
    "input":        { "kind": "symref",  "ref": "r_0_fetch_webpage_text" },
    "outputSchema": { "kind": "literal", "value": { "type": "string" } }
  },
  "resultBinding": "r_1_llm_generate" }
```

`write-file-text` then consumes `{ "kind": "symref", "ref": "r_1_llm_generate" }` for `content` — replacing the frozen literal. `instructions` is a small recipe literal (promotable to a workflow input); `input` is a real symref so the summary regenerates each run.

### 5.3 Mediated `llm` capability (mirrors `invokeTool`)

**Protocol (`sandbox/stdio-protocol.ts`).** Add two ops and two frame types:

```ts
SANDBOX_STDIO_OP = { ...existing, llm: "llm", llmResult: "llmResult" }

type SandboxChildStdoutLlmFrame   = { op: "llm";       requestId: string; req: LlmCapabilityRequest };
type SandboxChildStdinLlmResultFrame = { op: "llmResult"; requestId: string; result: ToolResult };
```

**Child runner (`sandbox/runner.ts`).** Add `installLlmGlobal()` parallel to `installInvokeToolGlobal()`: installs `globalThis.llm(req)` that writes an `llm` frame and awaits the matching `llmResult` (a `pendingLlm` map identical to `pendingInvokes`). The stdin handler gains an `llmResult` branch.

**Parent (`sandbox/node-permission-sandbox.ts`).** In `handleChildStdoutJsonLine`, add an `llm` branch that calls `opts.onLlm` and writes back an `llmResult` frame — structurally identical to the `invokeTool` branch. Thread `onLlm` through `run(...)` and `stdoutLineOpts`. The existing `timeoutMs` covers the whole run including the round-trip.

**Interface (`sandbox/interface.ts`).** Extend `ExecuteOpts` with `onLlm?: LlmHandler`. The request is **structured and host-controlled**, so a tool cannot smuggle in a system prompt, tool definitions, or `tool_choice`:

```ts
type LlmCapabilityRequest = { instructions: string; input: unknown; schema?: Record<string, unknown> };
type LlmHandler = (req: LlmCapabilityRequest) => Promise<ToolResult>;
```

**Host wiring (`agent/agent-loop.ts`, `dispatchTool`).** Where it already passes `onInvokeTool` to `sandbox.execute`, also pass `onLlm` — **only when** the tool declares the capability (§5.5). The handler is the single place the real model is touched:

```ts
onLlm: async ({ instructions, input, schema }) => {
  const messages = [
    { role: "system", content: LLM_GENERATE_SYSTEM },
    { role: "user",   content: renderInstructionAndInput(instructions, input) },
  ];
  const value = schema
    ? await this.opts.llm.generateStructured({ messages, schemaName: "llm_generate", schema })
    : (await this.opts.llm.chat({ messages })).message.content;
  return { ok: true, value };
}
```

The API key and network live entirely in the host's `LLMProvider`.

### 5.4 The `llm_generate` built-in tool

An ordinary on-disk **atomic** tool, seeded into the registry as a trusted built-in (its `tool.ts` ships in the repo, pre-approved — never factory/LLM-authored). Body is a forwarder:

```ts
export async function run(input) {
  return globalThis.llm({ instructions: input.instructions, input: input.input, schema: input.outputSchema });
}
```

- `permissions`: `net: "none"`, `env: []`, no fs — zero ambient authority.
- `inputSchema`: `{ instructions: string (required), input: any, outputSchema?: object }`.
- `kind`: `"atomic"`. No new tool kind; no `dispatchTool` special-case. The only special thing is the capability.
- `sourceLabels: ["llm_generated"]` (see §7.3).

### 5.5 Gating: the `capabilities` manifest field

A new optional manifest field `capabilities?: string[]` (known set `{"llm"}` for now) is the control that preserves no-ambient-authority:

1. The host passes `onLlm` to `sandbox.execute` **only if** `tool.manifest.capabilities?.includes("llm")`.
2. The parent **refuses** any `llm` frame from a tool that did not declare it, returning a `permission_denied` ToolResult (defense in depth — calling `globalThis.llm` is not enough).
3. `capabilities` is part of the manifest **hash**, so granting LLM access changes the hash and **re-triggers approval** — same trust model as `permissions` today.
4. `factory/static-validator.ts` **forbids LLM-authored drafts** from declaring `capabilities: ["llm"]`. Only the seeded built-in (and, later, explicitly user-blessed minted tools) may hold it.

Net effect: exactly one trusted, reviewed code path can reach the model; it gets no network/secrets; and the IR references it as a plain `tool_call`.

---

## 6. Touchpoints in the existing pipeline

- **Lift (`workflow/lift.ts`) — unchanged.** An `llm_generate` call lifts like any tool: `instructions`/`outputSchema` (no prior-output match) become **literals**; `input` (matches a prior step's value) becomes a **symref**. Non-determinism affects only the runtime *value*, not the lifted IR (lift records args, not output), so "same trace ⇒ byte-identical IR" still holds.
- **Parameterize (`workflow/parameterize.ts`) — unchanged, and the payoff.** `instructions` is a small literal the user can promote to a workflow input (default = original recipe). Short recipe, not a multi-KB frozen output — this is the reuse the parameterization spec wanted, without its "LLM-generated literal as default" problem.
- **Validate (`workflow/validator.ts`) — one addition.** Check that `capabilities` entries are from the known set; keep existing meta-tool/registry/symref checks. `llm_generate` passes as a registered tool.
- **Manifest type (`types.ts`).** Add `capabilities?: string[]`; include it in the hash input.

---

## 7. Security analysis

This section answers the original concern ("a built-in tool that invokes an LLM could pose a security risk") and situates the design within the project's overall stance.

### 7.1 The project's security stance (recap)

Two pillars:

1. **No ambient authority in tool code.** Sandboxed tools get only what their manifest grants (fs/net/env), enforced by the Node permission model and a parent-side net allowlist shim. Capability grants are part of the manifest hash and gated by human approval.
2. **Code/data separation in the IR** (from Meijer, "Guardians of the Agents"). The model emits a *plan* of symbolic references up front; the executor substitutes concrete values at run time. The model does not see concrete data while choosing what to do, and the plan is fixed before any side effect — the same separation that defeats SQL injection, applied to prompt injection.

The design must not weaken either pillar.

### 7.2 Why the mediated capability is safe

**The LLM is a pure data→data transformer, never a planner.** `llm_generate` returns a *value* bound to a result. It cannot choose tools, emit tool calls, or alter control flow: the workflow plan is fixed before execution, and the executor only resolves literals/symrefs. Therefore prompt injection inside `input` (e.g. a poisoned fetched page) can **corrupt the produced value** but **cannot escalate into unauthorized tool calls**. This is exactly the code/data separation of pillar 2: the model is confined to producing data for a slot the plan already decided to fill.

Contrast with **B1 (sandbox-direct)**, the option flagged as risky: a tool holding `net` + the API key could be coerced (by injected content or a poisoned tool) into **exfiltration** — sending data to an attacker endpoint, or leaking the key. The mediated capability removes both primitives from the child:

- **No API key in the child.** The secret lives only in the host `LLMProvider`. `buildChildEnv` never receives it (the tool declares `env: []`).
- **No outbound network in the child.** `llm_generate` declares `net: "none"`, so `--allow-net` is not passed and the net shim grants nothing. The only egress is the structured `llm` RPC to the parent, which goes to the configured model endpoint and returns data — it cannot be retargeted by the tool.
- **Host-controlled prompt envelope.** The capability request is `{ instructions, input, schema }`. The host builds the `system`/`user` roles and forbids the tool from supplying tool definitions or `tool_choice`, so the mediated call cannot be turned into an agentic, tool-calling sub-session.

This upholds pillar 1: the new power is a **declared, hash-gated, approvable capability**, not ambient authority. A tool cannot reach the model unless its manifest says so (and that grant changed its hash and passed approval), and the factory may not mint LLM-authored tools that grant themselves the capability.

### 7.3 Forward-compatibility with VERIFY (taint)

`ToolManifest` already reserves `sourceLabels`, `sinkParams`, `preconditions`, `postconditions`, `frameConditions` for the future VERIFY spec. `llm_generate` sets `sourceLabels: ["llm_generated"]`. These fields are inert today, but seeding them means that when VERIFY lands:

- Taint analysis automatically treats every `llm_generate` output as tainted, with provenance propagating through downstream symrefs.
- A policy can forbid `llm_generated` data from reaching a sink parameter (e.g. an outbound recipient) — catching "the model invented a destination," analogous to the canonical email-exfiltration demo.

No VERIFY code is written now; we only populate labels so the checker works without retrofit.

### 7.4 Residual risks (documented, not solved here)

- **Output corruption.** Injected `input` can still poison the produced value. Mitigation is downstream taint policy (VERIFY) and the fact that the value can only flow where the fixed plan already routes it. Out of scope to *prevent* corruption; in scope to *contain* its blast radius (achieved).
- **Cost / latency / loops.** LLM calls cost tokens and time. The sandbox `timeoutMs` bounds a single round-trip; a per-session LLM-call budget (mirroring the executor's budget hooks) is future work.
- **Capability creep.** If many tools request `capabilities: ["llm"]`, the privileged surface grows. Mitigations: factory ban on self-granting, hash-gated approval per tool, and a small known-capabilities allowlist enforced by the validator.

### 7.5 Net effect on the threat model

| Concern | B1 sandbox-direct | B3 mediated (chosen) |
|---|---|---|
| API key reachable by tool code | Yes | No |
| Arbitrary outbound network from tool | Yes (allowlist) | No (`net: none`) |
| Exfiltration primitive in child | Yes | No |
| LLM can choose/emit tool calls | No (if disciplined) | No (host strips tool defs/choice) |
| Access gated by manifest hash + approval | Partial (via net/env) | Yes (explicit `capabilities`) |
| Output tainted for future VERIFY | Manual | Yes (`sourceLabels`) |

---

## 8. Testing plan

- **`stdio-protocol` / `runner`:** `llm` frame round-trips; `llmResult` resolves the pending promise; malformed frames ignored.
- **`node-permission-sandbox`:** `onLlm` invoked on an `llm` frame and reply written; `llm` frame from a tool **without** the capability → `permission_denied`; timeout still fires if the host never replies.
- **`llm_generate` tool:** forwards args to the capability; returns structured value (via `MockLLMProvider`); `chat` vs `generateStructured` path selected by presence of `outputSchema`.
- **`agent-loop`:** `onLlm` wired **only** when `capabilities` includes `"llm"`; API key / network never placed in child env.
- **`lift`:** a trace containing an `llm_generate` call lifts to literal `instructions`/`outputSchema` + symref `input`; deterministic byte-identical output.
- **`executor` (e2e):** a `summarize_paper`-style workflow (`fetch -> llm_generate -> write-file-text`) runs end to end with `MockLLMProvider`, with `content` resolved from the `llm_generate` binding.
- **`factory/static-validator`:** rejects an LLM-authored draft that declares `capabilities: ["llm"]`.

---

## 9. Open questions

1. **Capability naming.** `capabilities: ["llm"]` vs folding the LLM grant into `permissions` (e.g. `permissions.llm: true`). Leaning toward a separate `capabilities` array to keep `permissions` strictly about OS-level authority (fs/net/env) and leave room for future mediated capabilities.
2. **`outputSchema` default.** When omitted, return the raw assistant string (`chat`). Confirm that weak typing is acceptable for the primitive, deferring strong typing to A2 (minted tools).
3. **Surfacing in `/compose`.** Whether to nudge the agent to route generative work through `llm_generate` (a system-prompt concern) so such steps appear in traces and lift — orthogonal to this mechanism, but required for the capability to be *useful* in composition.
