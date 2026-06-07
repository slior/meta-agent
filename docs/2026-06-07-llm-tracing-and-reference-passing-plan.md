# LLM Call Tracing and Reference-Based Data Passing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit full LLM request/response into the trace, and make the agent pass prior tool outputs to later tools as *references* (so data-transformation chains lift into workflows with bound symrefs instead of frozen literals).

**Architecture:** Two phases. **1a (observability):** a `TracingLLMProvider` decorator wraps the host `LLMProvider` and logs a new `llm-call` trace event with full content; call sites tag their phase. **1b (reference passing):** at the agent boundary (depth 0) tool outputs are stored in a session `ResultStore` and fed back to the model as a `{ ref, shape, preview }` handle; the model references prior outputs with a `{ "$ref", "path"? }` sentinel; the host resolves sentinels to concrete values before execution and records the unresolved form; `liftFromTrace` reads the recorded references (translating runtime binding ids to slice-local ids) and emits projected symrefs.

**Tech Stack:** TypeScript (ESM, `node --experimental-transform-types`), `node:test` + `node:assert/strict`, Ajv, monorepo workspaces (`@meta-agent/core`, `@meta-agent/cli`).

**Spec:** [`2026-06-07-llm-tracing-and-reference-passing-design.md`](./2026-06-07-llm-tracing-and-reference-passing-design.md)

## Conventions (apply to every task)

- **Run core tests:** from `packages/core`: `npm test` (runs `node --test ... 'src/**/*.test.ts'`).
  - Single file: `node --test --experimental-transform-types --no-warnings src/agent/result-store.test.ts`
- **Typecheck:** from repo root: `npm run typecheck` (`tsc -b packages/core packages/cli`).
- **Test imports:** `import { test } from "node:test";` and `import assert from "node:assert/strict";`.
- **Commit** after each task's tests pass. Use the message shown in the task's final step.
- Do **not** edit `.test.ts` expectations to make a real bug pass; fix the code.

---

## File Structure

**New files**
- `packages/core/src/agent/result-store.ts` — sentinel type + guard, `ResultStore`, `resolveRefs`, `describeForModel`, size/preview constants, `sanitizeBinding`. One responsibility: the runtime reference machinery (pure + a tiny stateful store).
- `packages/core/src/agent/result-store.test.ts` — unit tests for the above.
- `packages/core/src/llm/tracing-provider.ts` — `TracingLLMProvider` decorator.
- `packages/core/src/llm/tracing-provider.test.ts` — unit tests for the decorator.
- `packages/core/src/agent/reference-flow.test.ts` — integration test for depth-0 ref resolution + elision in `AgentLoop`.
- `packages/core/src/workflow/reference-lift.e2e.test.ts` — end-to-end: invocations with sentinels → lift → validate → execute.

**Modified files**
- `packages/core/src/tracer.ts` — add `TRACE_KIND_LLM_CALL`, `LLM_TRACE_PHASE`.
- `packages/core/src/index.ts` — export the new symbols + `TracingLLMProvider`.
- `packages/core/src/llm/interface.ts` — add optional `traceTag` to `ChatRequest` and `StructuredRequest`.
- `packages/core/src/agent/agent-loop.ts` — phase tags; `ResultStore` field; depth-0 resolve/store/record; elision; `ToolInvokedEvent.binding`.
- `packages/core/src/factory/factory.ts` — phase tags on the two `generateStructured` calls.
- `packages/core/src/workflow/types.ts` — un-reserve `SymRef.path`.
- `packages/core/src/workflow/validator.ts` — accept `symref.path`.
- `packages/core/src/workflow/executor.ts` — resolve projected symrefs.
- `packages/core/src/workflow/lift.ts` — `Invocation.binding`; sentinel → symref translation; `ref_out_of_slice` error.
- `packages/core/src/agent/system-prompt.ts` — reference contract.
- `packages/core/src/agent/builtins.ts` — `llm_generate` description nudge toward `$ref`.
- `packages/cli/src/repl.ts` — wrap `llm` with `TracingLLMProvider`; thread `binding` into `InvocationRecord`.
- `packages/cli/src/compose.ts` — carry `binding` into the lift slice.
- `packages/cli/src/trace-progress.ts` — short line for `llm-call`.

---

# PHASE 1a — Observability (independent; ship first)

## Task 1: Trace kind + phase constants + request tag

**Files:**
- Modify: `packages/core/src/tracer.ts`
- Modify: `packages/core/src/llm/interface.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add the trace kind and phase enum to `tracer.ts`**

Add after the existing `TRACE_KIND_FACTORY_REPAIR_LLM` declaration (around line 30):

```ts
/** `TraceEvent.kind` carrying the full request/response of one host LLM call (content, not just usage). */
export const TRACE_KIND_LLM_CALL = "llm-call" as const;

/** Attribution tag for an {@link TRACE_KIND_LLM_CALL} event, identifying which host path made the call. */
export const LLM_TRACE_PHASE = {
  orchestration: "orchestration",
  synthesis: "synthesis",
  capability: "capability",
  factoryDraft: "factory-draft",
  factoryRepair: "factory-repair",
  unknown: "unknown",
} as const;
export type LlmTracePhase = (typeof LLM_TRACE_PHASE)[keyof typeof LLM_TRACE_PHASE];
```

- [ ] **Step 2: Add `traceTag` to the request types in `llm/interface.ts`**

In `ChatRequest` (after `toolChoice`) and `StructuredRequest` (after `schema`), add the optional field:

```ts
export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?:
    | (typeof CHAT_TOOL_CHOICE)[keyof typeof CHAT_TOOL_CHOICE]
    | { type: typeof CHAT_TOOL_TYPE.function; function: { name: string } };
  /** Optional attribution tag surfaced into the `llm-call` trace event. */
  traceTag?: string;
};

export type StructuredRequest = {
  messages: ChatMessage[];
  schemaName: string;
  schema: Record<string, unknown>;
  /** Optional attribution tag surfaced into the `llm-call` trace event. */
  traceTag?: string;
};
```

- [ ] **Step 3: Export the new symbols from `index.ts`**

In the `export { ... } from "./tracer.ts";` block, add `TRACE_KIND_LLM_CALL,` and `LLM_TRACE_PHASE,`. In the `export type { ... } from "./tracer.ts";` line add `LlmTracePhase`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tracer.ts packages/core/src/llm/interface.ts packages/core/src/index.ts
git commit -m "feat(trace): add llm-call trace kind, phase enum, and request traceTag"
```

---

## Task 2: `TracingLLMProvider` decorator

**Files:**
- Create: `packages/core/src/llm/tracing-provider.ts`
- Test: `packages/core/src/llm/tracing-provider.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/llm/tracing-provider.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TracingLLMProvider } from "./tracing-provider.ts";
import { LLM_TRACE_PHASE, TRACE_KIND_LLM_CALL, type TraceEvent } from "../tracer.ts";
import type { LLMProvider } from "./interface.ts";
import { CHAT_ROLE } from "./interface.ts";

function fakeTracer(sink: TraceEvent[]) {
  // Minimal Tracer-compatible shim: only `log` is used by the decorator.
  return { log: (kind: string, data: Record<string, unknown>) => sink.push({ ts: "", sessionId: "", kind, data }) };
}

const inner: LLMProvider = {
  async chat() {
    return { message: { role: CHAT_ROLE.assistant, content: "hi", tool_calls: undefined }, usage: { promptTokens: 3, completionTokens: 1 } };
  },
  async generateStructured() {
    return { a: 1 } as never;
  },
};

test("TracingLLMProvider logs chat request+response with phase", async () => {
  const sink: TraceEvent[] = [];
  const p = new TracingLLMProvider(inner, fakeTracer(sink) as never);
  const resp = await p.chat({ messages: [{ role: CHAT_ROLE.user, content: "yo" }], traceTag: LLM_TRACE_PHASE.orchestration });
  assert.equal(resp.message.content, "hi");
  assert.equal(sink.length, 1);
  assert.equal(sink[0]!.kind, TRACE_KIND_LLM_CALL);
  assert.equal(sink[0]!.data.phase, "orchestration");
  assert.equal(sink[0]!.data.method, "chat");
  assert.deepEqual((sink[0]!.data.request as { messages: unknown }).messages, [{ role: "user", content: "yo" }]);
  assert.equal((sink[0]!.data.response as { content: string }).content, "hi");
});

test("TracingLLMProvider logs generateStructured with structured response and unknown phase default", async () => {
  const sink: TraceEvent[] = [];
  const p = new TracingLLMProvider(inner, fakeTracer(sink) as never);
  const out = await p.generateStructured<{ a: number }>({ messages: [], schemaName: "S", schema: {} });
  assert.deepEqual(out, { a: 1 });
  assert.equal(sink[0]!.data.phase, "unknown");
  assert.equal(sink[0]!.data.method, "generateStructured");
  assert.deepEqual((sink[0]!.data.response as { structured: unknown }).structured, { a: 1 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-transform-types --no-warnings src/llm/tracing-provider.test.ts` (from `packages/core`)
Expected: FAIL — cannot find module `./tracing-provider.ts`.

- [ ] **Step 3: Implement `tracing-provider.ts`**

Create `packages/core/src/llm/tracing-provider.ts`:

```ts
import type { ChatRequest, ChatResponse, LLMProvider, StructuredRequest } from "./interface.ts";
import { LLM_TRACE_PHASE, TRACE_KIND_LLM_CALL, type Tracer } from "../tracer.ts";

/**
 * Decorates an {@link LLMProvider}, logging the full request and response of every
 * call as a {@link TRACE_KIND_LLM_CALL} trace event. This is the single seam through
 * which all host LLM calls pass, so wrapping once captures orchestration, synthesis,
 * the mediated llm_generate capability, and factory calls. The `phase` is taken from
 * the request's `traceTag` (defaulting to "unknown").
 */
export class TracingLLMProvider implements LLMProvider {
  constructor(private readonly inner: LLMProvider, private readonly tracer: Tracer) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const resp = await this.inner.chat(req);
    this.tracer.log(TRACE_KIND_LLM_CALL, {
      phase: req.traceTag ?? LLM_TRACE_PHASE.unknown,
      method: "chat",
      request: { messages: req.messages, tools: req.tools ?? null, toolChoice: req.toolChoice ?? null },
      response: { content: resp.message.content ?? null, tool_calls: resp.message.tool_calls ?? null },
      usage: resp.usage ?? null,
    });
    return resp;
  }

  async generateStructured<T>(req: StructuredRequest): Promise<T> {
    const value = await this.inner.generateStructured<T>(req);
    this.tracer.log(TRACE_KIND_LLM_CALL, {
      phase: req.traceTag ?? LLM_TRACE_PHASE.unknown,
      method: "generateStructured",
      request: { messages: req.messages, schemaName: req.schemaName },
      response: { structured: value },
      usage: null,
    });
    return value;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-transform-types --no-warnings src/llm/tracing-provider.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Export from `index.ts`**

Add next to the `OpenAIProvider` export (around line 23):

```ts
export { TracingLLMProvider } from "./llm/tracing-provider.ts";
```

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` → PASS.

```bash
git add packages/core/src/llm/tracing-provider.ts packages/core/src/llm/tracing-provider.test.ts packages/core/src/index.ts
git commit -m "feat(trace): TracingLLMProvider decorator emitting full llm-call events"
```

---

## Task 3: Tag call sites + wire decorator + CLI progress line

**Files:**
- Modify: `packages/core/src/agent/agent-loop.ts:173-176` (orchestration), `:279-282` (synthesis), `:404-414` (capability)
- Modify: `packages/core/src/factory/factory.ts:351` and `:365`
- Modify: `packages/cli/src/repl.ts`
- Modify: `packages/cli/src/trace-progress.ts`

- [ ] **Step 1: Import the phase enum in `agent-loop.ts`**

In the `from "../tracer.ts"` import block (around lines 16-26), add `LLM_TRACE_PHASE,`.

- [ ] **Step 2: Tag the orchestration chat** (`agent-loop.ts` ~line 173)

```ts
    const resp = await this.opts.llm.chat({
      messages: [{ role: CHAT_ROLE.system, content: system }, ...messages],
      tools,
      traceTag: LLM_TRACE_PHASE.orchestration,
    });
```

- [ ] **Step 3: Tag the synthesis chat** (`agent-loop.ts` ~line 279)

```ts
    const syn = await this.opts.llm.chat({
      messages: [{ role: CHAT_ROLE.system, content: FINAL_SYNTHESIS_SYSTEM }, ...messages],
      toolChoice: CHAT_TOOL_CHOICE.none,
      traceTag: LLM_TRACE_PHASE.synthesis,
    });
```

- [ ] **Step 4: Tag the capability calls in `runLlmCapability`** (`agent-loop.ts` ~lines 410, 413)

```ts
      if (req.schema) {
        const value = await this.opts.llm.generateStructured({ messages, schemaName: "llm_generate", schema: req.schema, traceTag: LLM_TRACE_PHASE.capability });
        return { ok: true, value };
      } else {
        const resp = await this.opts.llm.chat({ messages, traceTag: LLM_TRACE_PHASE.capability });
        return { ok: true, value: resp.message.content ?? "" };
      }
```

- [ ] **Step 5: Tag the factory calls** (`factory.ts` lines 351, 365)

Import `LLM_TRACE_PHASE` from `../tracer.ts` (add to the existing tracer import in `factory.ts`). Then:

`genDraft` (line 351):
```ts
    return this.opts.llm.generateStructured<ToolDraft>({
      messages: [{ role: CHAT_ROLE.system, content: systemPrompt }],
      schemaName: "ToolDraft",
      schema: DRAFT_SCHEMA,
      traceTag: LLM_TRACE_PHASE.factoryDraft,
    });
```

`repair` (line 365):
```ts
    return this.opts.llm.generateStructured<ToolDraft>({
      messages: [
        { role: CHAT_ROLE.system, content: "Produce a corrected ToolDraft." },
        { role: CHAT_ROLE.user, content: repairPrompt(previous, errors) },
      ],
      schemaName: "ToolDraft",
      schema: DRAFT_SCHEMA,
      traceTag: LLM_TRACE_PHASE.factoryRepair,
    });
```
(Keep the existing trailing properties of each call; only add `traceTag`.)

- [ ] **Step 6: Wrap the provider in `repl.ts`**

The tracer must exist before the provider. Move the `tracer`/`sessionId` creation (currently lines 44-50) **above** the `const llm = ...` block, then wrap:

```ts
  const sessionId = Date.now().toString(36);
  const tracer = await Tracer.open(config.tracesDir, sessionId, {
    observers: [(e) => {
      const line = formatTraceEvent(e);
      if (line) process.stderr.write(line + "\n");
    }],
  });

  const llm = new TracingLLMProvider(
    new OpenAIProvider({
      apiKey,
      ...(config.llm.baseURL !== undefined ? { baseURL: config.llm.baseURL } : {}),
      model: config.llm.model,
      ...(config.debug ? { debug: createStderrDebugSink() } : {}),
    }),
    tracer,
  );
```

Add `TracingLLMProvider` to the import from `@meta-agent/core` at the top of `repl.ts`. Remove the now-duplicate `sessionId`/`tracer` block that previously sat below.

- [ ] **Step 7: Add a CLI progress line for `llm-call`**

In `trace-progress.ts`, add `TRACE_KIND_LLM_CALL,` to the import from `@meta-agent/core`, and add a case before `default:`:

```ts
    case TRACE_KIND_LLM_CALL: {
      const phase = String(e.data.phase ?? "unknown");
      const method = String(e.data.method ?? "chat");
      return `[meta-agent] LLM ${method} (${phase}) recorded`;
    }
```

- [ ] **Step 8: Typecheck + run full core tests**

Run: `npm run typecheck` → PASS.
Run (from `packages/core`): `npm test` → PASS (existing suite unaffected).

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/agent/agent-loop.ts packages/core/src/factory/factory.ts packages/cli/src/repl.ts packages/cli/src/trace-progress.ts
git commit -m "feat(trace): tag llm call phases and wire TracingLLMProvider in the REPL"
```

---

# PHASE 1b — Reference-based data passing

## Task 4: `ResultStore` + sentinel + resolveRefs + describeForModel

**Files:**
- Create: `packages/core/src/agent/result-store.ts`
- Test: `packages/core/src/agent/result-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/agent/result-store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ResultStore, isRefSentinel, resolveRefs, describeForModel,
  ELISION_MAX_BYTES, sanitizeBinding,
} from "./result-store.ts";

test("isRefSentinel accepts {$ref} and {$ref,path}, rejects others", () => {
  assert.equal(isRefSentinel({ $ref: "r_0_x" }), true);
  assert.equal(isRefSentinel({ $ref: "r_0_x", path: "text" }), true);
  assert.equal(isRefSentinel({ $ref: "r_0_x", path: 3 }), false);
  assert.equal(isRefSentinel({ $ref: "r_0_x", extra: 1 }), false);
  assert.equal(isRefSentinel({ ref: "r_0_x" }), false);
  assert.equal(isRefSentinel("r_0_x"), false);
  assert.equal(isRefSentinel(null), false);
});

test("resolveRefs substitutes whole-value and projected refs", () => {
  const store = new ResultStore();
  store.put("r_0_fetch", { text: "BODY", title: "T" });
  const out = resolveRefs(
    { content: { $ref: "r_0_fetch" }, input: { $ref: "r_0_fetch", path: "text" }, lit: 5 },
    store,
  );
  assert.equal(out.ok, true);
  assert.deepEqual((out as { ok: true; value: unknown }).value, {
    content: { text: "BODY", title: "T" }, input: "BODY", lit: 5,
  });
});

test("resolveRefs reports unknown ref and missing path", () => {
  const store = new ResultStore();
  store.put("r_0_fetch", { text: "BODY" });
  const a = resolveRefs({ x: { $ref: "r_9_nope" } }, store);
  assert.equal(a.ok, false);
  assert.match((a as { ok: false; error: string }).error, /unknown ref 'r_9_nope'/);
  const b = resolveRefs({ x: { $ref: "r_0_fetch", path: "missing" } }, store);
  assert.equal(b.ok, false);
  assert.match((b as { ok: false; error: string }).error, /no key 'missing'/);
});

test("resolveRefs passes non-object args through unchanged", () => {
  const store = new ResultStore();
  const out = resolveRefs("just-a-string", store);
  assert.deepEqual(out, { ok: true, value: "just-a-string" });
});

test("describeForModel inlines small values and elides large ones", () => {
  const small = describeForModel({ a: 1 }, "r_0_x") as Record<string, unknown>;
  assert.equal(small.ref, "r_0_x");
  assert.deepEqual(small.value, { a: 1 });
  assert.equal("preview" in small, false);

  const big = { text: "x".repeat(ELISION_MAX_BYTES + 50) };
  const elided = describeForModel(big, "r_1_fetch") as Record<string, unknown>;
  assert.equal(elided.ref, "r_1_fetch");
  assert.equal("value" in elided, false);
  assert.deepEqual(elided.shape, { type: "object", keys: ["text"] });
  assert.equal(typeof elided.preview, "string");
});

test("sanitizeBinding lowercases and replaces non-word chars", () => {
  assert.equal(sanitizeBinding("Fetch-Webpage-Text"), "fetch_webpage_text");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-transform-types --no-warnings src/agent/result-store.test.ts`
Expected: FAIL — cannot find module `./result-store.ts`.

- [ ] **Step 3: Implement `result-store.ts`**

Create `packages/core/src/agent/result-store.ts`:

```ts
/** Max serialized bytes of a tool output before it is elided to a handle for the model. */
export const ELISION_MAX_BYTES = 1024;

/** Max characters of a previewed (elided) value shown to the model. */
export const PREVIEW_CHARS = 200;

/** Identifier-safe binding name (mirrors the workflow validator's BINDING_NAME rules). */
export function sanitizeBinding(name: string): string {
  return name.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
}

/** A model-emitted reference to a prior tool output, optionally projecting one top-level key. */
export type RefSentinel = { $ref: string; path?: string };

/** Type guard: a value is a reference sentinel iff it has a string `$ref` and only `$ref`/`path` keys. */
export function isRefSentinel(v: unknown): v is RefSentinel {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.$ref !== "string") return false;
  for (const k of Object.keys(o)) {
    if (k !== "$ref" && k !== "path") return false;
  }
  if ("path" in o && typeof o.path !== "string") return false;
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Session-scoped map of result binding id -> the tool's full output value. */
export class ResultStore {
  private readonly map = new Map<string, unknown>();
  put(binding: string, value: unknown): void { this.map.set(binding, value); }
  get(binding: string): { has: true; value: unknown } | { has: false } {
    return this.map.has(binding) ? { has: true, value: this.map.get(binding) } : { has: false };
  }
  keys(): string[] { return [...this.map.keys()]; }
}

export type ResolveResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Resolves top-level {@link RefSentinel} argument values against the store, applying single-key
 * `path` projection. Non-object args and non-sentinel values pass through unchanged. Returns a
 * structured error (unknown ref or missing key) so the caller can surface it to the model.
 */
export function resolveRefs(args: unknown, store: ResultStore): ResolveResult {
  if (!isPlainObject(args)) return { ok: true, value: args };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!isRefSentinel(v)) { out[k] = v; continue; }
    const got = store.get(v.$ref);
    if (!got.has) {
      return { ok: false, error: `unknown ref '${v.$ref}'; available: ${store.keys().join(", ") || "(none)"}` };
    }
    if (v.path === undefined) { out[k] = got.value; continue; }
    if (!isPlainObject(got.value) || !(v.path in got.value)) {
      const keys = isPlainObject(got.value) ? Object.keys(got.value).join(", ") : "(not an object)";
      return { ok: false, error: `ref '${v.$ref}' has no key '${v.path}'; keys: ${keys}` };
    }
    out[k] = got.value[v.path];
  }
  return { ok: true, value: out };
}

function shapeOf(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (isPlainObject(value)) return { type: "object", keys: Object.keys(value) };
  if (typeof value === "string") return { type: "string", length: value.length };
  return { type: typeof value };
}

/**
 * Builds the object placed into the model's tool message for a depth-0 tool result. Small values are
 * inlined verbatim (with a `ref` so they can still be referenced); large values are elided to a
 * `{ ok, ref, shape, preview }` handle so the model never receives the full bytes.
 */
export function describeForModel(value: unknown, binding: string): unknown {
  const serialized = JSON.stringify(value) ?? "null";
  if (serialized.length <= ELISION_MAX_BYTES) {
    return { ok: true, ref: binding, value };
  }
  const truncated = serialized.slice(0, PREVIEW_CHARS);
  return {
    ok: true,
    ref: binding,
    shape: shapeOf(value),
    preview: serialized.length > PREVIEW_CHARS ? `${truncated}…` : truncated,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-transform-types --no-warnings src/agent/result-store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/result-store.ts packages/core/src/agent/result-store.test.ts
git commit -m "feat(agent): result store, ref sentinel resolution, and output elision helpers"
```

---

## Task 5: Turn on `SymRef.path` (types + validator)

**Files:**
- Modify: `packages/core/src/workflow/types.ts:36-41`
- Modify: `packages/core/src/workflow/validator.ts:50, 193-212`
- Test: `packages/core/src/workflow/validator.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/workflow/validator.test.ts`, reusing the file's existing module-level `fakeRegistry(tools)` and `ATOMIC(name, schema?)` helpers (defined at the top of that file):

```ts
test("validator: symref with single-key path is accepted", async () => {
  const reg = fakeRegistry({ "fetch-webpage-text": ATOMIC("fetch-webpage-text", {}), "write-file-text": ATOMIC("write-file-text", {}) });
  const wf: Workflow = {
    schemaVersion: 1, name: "wf", description: "", goal: "", inputs: [],
    steps: [
      { kind: "tool_call", label: "s0", tool: "fetch-webpage-text", arguments: {}, resultBinding: "r_0_fetch" },
      { kind: "tool_call", label: "s1", tool: "write-file-text", arguments: { content: { kind: "symref", ref: "r_0_fetch", path: "text" } }, resultBinding: "r_1_write" },
    ],
    return: { source: { kind: "symref", ref: "r_1_write" } },
  };
  const res = await validate(wf, reg);
  assert.equal(res.ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-transform-types --no-warnings src/workflow/validator.test.ts`
Expected: FAIL — error `symref_path_not_supported_in_v1`.

- [ ] **Step 3: Un-reserve `SymRef.path` in `types.ts`**

Replace lines 36-41:

```ts
export type SymRef = {
  kind: typeof ARG_KIND.symref;
  ref: string;
  /** Optional single top-level key projection of the referenced value. */
  path?: string;
};
```

- [ ] **Step 4: Accept `path` in the validator**

In `validator.ts`, update the doc bullet (line 50) from "SymRef.path is not used (reserved for future tiers)." to "SymRef.path (single-key projection) is accepted; if present it must be a non-empty string.". Replace `validateSymRefArgument` (lines 197-212):

```ts
function validateSymRefArgument(
  errors: ValidationError[],
  step: Step, argName: string,
  arg: SymRefArgument, argPtr: string,
  bindings: ReadonlySet<string>, ): void {
  if (!bindings.has(arg.ref)) {
    pushStepValidationError(
      errors,
      step, argPtr,
      "unbound_symref", `argument '${argName}' references unbound name '${arg.ref}'`,
    );
  }
  const path = (arg as Argument & { path?: unknown }).path;
  if (path !== undefined && (typeof path !== "string" || path.length === 0)) {
    pushStepValidationError(errors, step, argPtr, "invalid_symref_path", "SymRef.path must be a non-empty string");
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --experimental-transform-types --no-warnings src/workflow/validator.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` → PASS.

```bash
git add packages/core/src/workflow/types.ts packages/core/src/workflow/validator.ts packages/core/src/workflow/validator.test.ts
git commit -m "feat(workflow): accept single-key SymRef.path in IR and validator"
```

---

## Task 6: Executor resolves projected symrefs

**Files:**
- Modify: `packages/core/src/workflow/executor.ts:182-186`
- Test: `packages/core/src/workflow/executor.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/workflow/executor.test.ts`, reusing the file's existing module-level `makeTracer()` helper (returns `{ tracer, dir }`) and `rm` import:

```ts
test("executor resolves a symref with path projection", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const wf: Workflow = {
      schemaVersion: 1, name: "wf", description: "", goal: "", inputs: [],
      steps: [
        { kind: "tool_call", label: "s0", tool: "fetch", arguments: {}, resultBinding: "r_0_fetch" },
        { kind: "tool_call", label: "s1", tool: "echo", arguments: { input: { kind: "symref", ref: "r_0_fetch", path: "text" } }, resultBinding: "r_1_echo" },
      ],
      return: { source: { kind: "symref", ref: "r_1_echo" } },
    };
    const seen: Array<{ name: string; args: unknown }> = [];
    const dispatch = async (name: string, args: unknown): Promise<ToolResult> => {
      seen.push({ name, args });
      if (name === "fetch") return { ok: true, value: { text: "HELLO", title: "t" } };
      return { ok: true, value: (args as { input: unknown }).input };
    };
    const res = await new WorkflowExecutor({ tracer }).run(wf, {}, dispatch, 0);
    assert.equal(res.ok, true);
    assert.equal((res as { ok: true; value: unknown }).value, "HELLO");
    assert.deepEqual(seen[1]!.args, { input: "HELLO" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-transform-types --no-warnings src/workflow/executor.test.ts`
Expected: FAIL — `echo` receives `{ input: { text: "HELLO", title: "t" } }` (whole object) instead of `"HELLO"`, so the returned value is the object, not `"HELLO"`.

- [ ] **Step 3: Implement projection in `resolveArgument`**

Replace `resolveArgument` (lines 182-186) in `executor.ts`:

```ts
function resolveArgument(arg: Argument, env: ReadonlyMap<string, unknown>): { bound: true; value: unknown } | { bound: false } {
  if (arg.kind === ARG_KIND.literal) return { bound: true, value: arg.value };
  if (!env.has(arg.ref)) return { bound: false };
  const base = env.get(arg.ref);
  if (arg.path === undefined) return { bound: true, value: base };
  if (typeof base !== "object" || base === null || Array.isArray(base) || !(arg.path in (base as Record<string, unknown>))) {
    return { bound: false };
  }
  return { bound: true, value: (base as Record<string, unknown>)[arg.path] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-transform-types --no-warnings src/workflow/executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow/executor.ts packages/core/src/workflow/executor.test.ts
git commit -m "feat(workflow): executor resolves projected (path) symrefs"
```

---

## Task 7: Lift reads recorded references

**Files:**
- Modify: `packages/core/src/workflow/lift.ts:15-21` (Invocation), `:41-54` (errors/result types), `:107-206` (lift logic)
- Test: `packages/core/src/workflow/lift.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/workflow/lift.test.ts` (reuse the file's existing `toolsByName` fixtures; add tools named to match, or reuse `FETCH`/`FILTER` by giving them the names below):

```ts
test("lift: $ref sentinel arg becomes a symref with path; out-of-slice ref errors", () => {
  const slice = [
    { name: "fetch", args: {}, ok: true as const, value: { text: "BODY" }, binding: "r_0_fetch" },
    {
      name: "summarize",
      args: { input: { $ref: "r_0_fetch", path: "text" } },
      ok: true as const, value: "SUMMARY", binding: "r_1_summarize",
    },
  ];
  const out = liftFromTrace({ slice, name: "wf", description: "d", goal: "g", toolsByName: TOOLS_BY_NAME });
  assert.equal(out.ok, true);
  const step1 = (out as { ok: true; workflow: { steps: Array<{ arguments: Record<string, unknown> }> } }).workflow.steps[1]!;
  assert.deepEqual(step1.arguments.input, { kind: "symref", ref: "r_0_fetch", path: "text" });

  // Selecting only the second invocation makes the ref point outside the slice.
  const out2 = liftFromTrace({ slice: [slice[1]!], name: "wf", description: "d", goal: "g", toolsByName: TOOLS_BY_NAME });
  assert.equal(out2.ok, false);
  assert.equal((out2 as { ok: false; errors: Array<{ code: string }> }).errors[0]!.code, "ref_out_of_slice");
});

test("lift: runtime binding ids are translated to slice-local ids", () => {
  const slice = [
    { name: "fetch", args: {}, ok: true as const, value: { text: "BODY" }, binding: "r_7_fetch" },
    { name: "summarize", args: { input: { $ref: "r_7_fetch", path: "text" } }, ok: true as const, value: "S", binding: "r_8_summarize" },
  ];
  const out = liftFromTrace({ slice, name: "wf", description: "d", goal: "g", toolsByName: TOOLS_BY_NAME });
  assert.equal(out.ok, true);
  const wf = (out as { ok: true; workflow: { steps: Array<{ resultBinding: string; arguments: Record<string, { ref?: string }> }> } }).workflow;
  assert.equal(wf.steps[0]!.resultBinding, "r_0_fetch");
  assert.equal(wf.steps[1]!.arguments.input!.ref, "r_0_fetch"); // translated from r_7_fetch
});
```

> Add a `TOOLS_BY_NAME` record (or extend the existing fixtures) mapping `"fetch"` and `"summarize"` to `Tool` objects shaped like the file's existing `FETCH` fixture (only `manifest.name`/`permissions` matter for lift).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --experimental-transform-types --no-warnings src/workflow/lift.test.ts`
Expected: FAIL — `input` lifts to a `literal` (containing the sentinel object), and there is no `ref_out_of_slice` error.

- [ ] **Step 3: Add `binding` to `Invocation`** (`lift.ts` lines 15-21)

```ts
export type Invocation = {
  name: string;
  args: unknown;
  ok: boolean;
  /** Present iff ok === true. */
  value: unknown;
  /** Runtime result-binding id assigned when the invocation ran (used to translate `$ref`s). */
  binding?: string;
};
```

- [ ] **Step 4: Add the error code and thread errors out of step lifting** (`lift.ts`)

Import the sentinel guard at the top of `lift.ts`:

```ts
import { isRefSentinel } from "../agent/result-store.ts";
```

Change `LiftedStepsResult` (lines 50-54) to carry errors:

```ts
type LiftedStepsResult = {
  steps: ToolCallStep[];
  literalFallbacks: LiteralFallback[];
  errors: LiftError[];
};
```

In `liftFromTrace` (after computing `liftStepsFromInvocations`, ~line 119) short-circuit on errors:

```ts
  const { steps, literalFallbacks, errors } = liftStepsFromInvocations(successes);
  if (errors.length > 0) return { ok: false, errors };
```

- [ ] **Step 5: Rewrite `liftStepsFromInvocations` and `liftStepArguments`** (`lift.ts` lines 157-206)

```ts
function liftStepsFromInvocations(successes: Invocation[]): LiftedStepsResult {
  const steps: ToolCallStep[] = [];
  const bindingByValue = new Map<string, string>();
  const runtimeToLocal = new Map<string, string>();
  const literalFallbacks: LiteralFallback[] = [];
  const errors: LiftError[] = [];

  for (let i = 0; i < successes.length; i++) {
    const inv = successes[i]!;
    const safe = sanitize(inv.name);
    const label = `step_${i}_${safe}`;
    const binding = `r_${i}_${safe}`;
    // Map the runtime binding (what the agent referenced) to this slice-local binding.
    runtimeToLocal.set(inv.binding ?? binding, binding);

    const args = liftStepArguments(inv.args, bindingByValue, runtimeToLocal, label, literalFallbacks, errors);

    steps.push({ kind: STEP_KIND.tool_call, label, tool: inv.name, arguments: args, resultBinding: binding });

    const ck = canonicalJson(inv.value);
    if (!bindingByValue.has(ck)) bindingByValue.set(ck, binding);
  }

  return { steps, literalFallbacks, errors };
}

function liftStepArguments(
  rawArgs: unknown,
  bindingByValue: ReadonlyMap<string, string>,
  runtimeToLocal: ReadonlyMap<string, string>,
  stepLabel: string,
  literalFallbacks: LiteralFallback[],
  errors: LiftError[],
): Record<string, Argument> {
  const args: Record<string, Argument> = {};
  for (const [k, v] of Object.entries((rawArgs ?? {}) as Record<string, unknown>)) {
    if (isRefSentinel(v)) {
      const local = runtimeToLocal.get(v.$ref);
      if (local === undefined) {
        errors.push({ code: "ref_out_of_slice", message: `step '${stepLabel}' argument '${k}' references '${v.$ref}', which is before the selected slice; widen the slice` });
        // Emit a placeholder symref so step shape is well-formed; the error aborts the lift anyway.
        args[k] = { kind: ARG_KIND.symref, ref: v.$ref, ...(v.path !== undefined ? { path: v.path } : {}) };
        continue;
      }
      args[k] = { kind: ARG_KIND.symref, ref: local, ...(v.path !== undefined ? { path: v.path } : {}) };
      continue;
    }
    const ck = canonicalJson(v);
    const hit = bindingByValue.get(ck);
    if (hit !== undefined) {
      args[k] = { kind: ARG_KIND.symref, ref: hit };
    } else {
      args[k] = { kind: ARG_KIND.literal, value: v };
      literalFallbacks.push({ stepLabel, argName: k, canonicalValue: ck });
    }
  }
  return args;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test --experimental-transform-types --no-warnings src/workflow/lift.test.ts`
Expected: PASS (including the pre-existing lift tests, which still pass because sentinel-free args take the unchanged value-match branch).

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck` → PASS.

```bash
git add packages/core/src/workflow/lift.ts packages/core/src/workflow/lift.test.ts
git commit -m "feat(workflow): lift recorded references into projected symrefs with slice-local translation"
```

---

## Task 8: AgentLoop — store, resolve, elide, record at depth 0

**Files:**
- Modify: `packages/core/src/agent/agent-loop.ts` (`ToolInvokedEvent` ~line 69; `processOneToolCall` lines 213-240; `dispatchTool` lines 431-474; new fields + helper)
- Test: `packages/core/src/agent/reference-flow.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/core/src/agent/reference-flow.test.ts`. This drives a real `AgentLoop` (real `FsToolRegistry` + `NodePermissionSandbox`, scripted `MockLLMProvider`) following the exact dependency-construction pattern in `agent-loop.test.ts`. The two tools are real sandboxed code: `fetch` returns an object, `summarize` echoes its input (so its returned value proves the resolved string reached it). The model (turn 1) invokes `fetch`, (turn 2) invokes `summarize` with a `$ref` to the fetch result, (turn 3) stops.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./agent-loop.ts";
import { MockLLMProvider } from "../llm/mock-provider.ts";
import { FsToolRegistry } from "../registry/fs-registry.ts";
import { HybridToolIndex } from "../index-store/hybrid-index.ts";
import { NodePermissionSandbox } from "../sandbox/node-permission-sandbox.ts";
import { TieredApprovalPolicy } from "../approval/tiered-policy.ts";
import { Tracer } from "../tracer.ts";
import { ToolFactory } from "../factory/factory.ts";
import { hashTool } from "../hash.ts";
import { CHAT_ROLE, CHAT_TOOL_TYPE, type ChatResponse } from "../llm/interface.ts";
import { META_FN } from "./meta-tools.ts";
import type { ApprovalRecord, Tool } from "../types.ts";

function toolWith(name: string, code: string): { tool: Tool; approval: ApprovalRecord } {
  const manifestNoHash = {
    name, description: `desc ${name}`, rationale: "r",
    inputSchema: { type: "object" as const }, outputShape: {},
    permissions: { fsRead: [], fsWrite: [], net: "none" as const, netAllowlist: [], env: [] },
    dependencies: [], limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
    createdAt: "2026-04-21T00:00:00Z", kind: "atomic" as const,
  };
  const hash = hashTool(code, manifestNoHash);
  return {
    tool: { code, manifest: { ...manifestNoHash, hash } },
    approval: { hash, approvedAt: "2026-04-21T00:00:00Z", approvedBy: "test", alwaysApprove: true },
  };
}

function asst(content: string | null, toolCalls?: Array<{ id: string; name: string; args: unknown }>): ChatResponse {
  return {
    message: {
      role: CHAT_ROLE.assistant, content,
      ...(toolCalls ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: CHAT_TOOL_TYPE.function, function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
    },
  };
}

test("agent passes a $ref to a later tool; recorded args keep the sentinel, tool sees resolved value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ref-flow-"));
  try {
    const registry = await FsToolRegistry.open(join(dir, "tools"));
    const fetch = toolWith("fetch", `export async function run(){ return { text: "FULL BODY TEXT", title: "T" }; }`);
    const summarize = toolWith("summarize", `export async function run(i){ return i; }`);
    await registry.save(fetch.tool, fetch.approval);
    await registry.save(summarize.tool, summarize.approval);
    const index = await HybridToolIndex.open(registry);
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const prompter = { promptGate1: async () => { throw new Error("no"); }, promptGate23: async () => { throw new Error("no"); } };
    const approval = new TieredApprovalPolicy(prompter, { workspace: dir });
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const factory = new ToolFactory({ llm: new MockLLMProvider(), registry, sandbox, approval, tracer, tombstoned: new Set() });

    const llm = new MockLLMProvider()
      .onChat(() => asst(null, [{ id: "c1", name: META_FN.invokeTool, args: { name: "fetch", args: {} } }]))
      .onChat(() => asst(null, [{ id: "c2", name: META_FN.invokeTool, args: { name: "summarize", args: { input: { $ref: "r_0_fetch", path: "text" } } } }]))
      .onChat(() => asst(null, [{ id: "c3", name: META_FN.stop, args: { reason: "done" } }]))
      .onChat(() => asst("done"));

    const invocations: Array<{ name: string; args: unknown; binding?: string; value?: unknown }> = [];
    const agent = new AgentLoop({
      llm, registry, index, sandbox, approval, factory, tracer, maxTurns: 10,
      onToolInvoked: (ev) => invocations.push({ name: ev.name, args: ev.args, binding: ev.binding, value: ev.value }),
    });
    await agent.run("summarize the page");
    await tracer.close();

    const fetchInv = invocations.find((i) => i.name === "fetch")!;
    assert.equal(fetchInv.binding, "r_0_fetch");
    const sumInv = invocations.find((i) => i.name === "summarize")!;
    assert.deepEqual(sumInv.args, { input: { $ref: "r_0_fetch", path: "text" } }); // unresolved sentinel kept for lift
    assert.deepEqual(sumInv.value, { input: "FULL BODY TEXT" }); // echo proves the tool received the resolved value
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

> Binding id reasoning: `fetch` is the first successful depth-0 invocation → `invocationSeq` 0 → `sanitizeBinding("fetch")` → `r_0_fetch`, which the scripted turn 2 references. The 4th `onChat` feeds the post-stop synthesis pass (a solo `stop` with prior tool results triggers one synthesis `chat`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-transform-types --no-warnings src/agent/reference-flow.test.ts`
Expected: FAIL — without resolution, `summarize` receives `{ input: { $ref: ... } }` (Ajv may also reject), and `ev.binding` is `undefined`.

- [ ] **Step 3: Add imports + fields + helper to `agent-loop.ts`**

Add to the `result-store.ts` import (new import line near the top):

```ts
import { ResultStore, describeForModel, resolveRefs, sanitizeBinding } from "./result-store.ts";
```

Extend `ToolInvokedEvent` (line 69):

```ts
export type ToolInvokedEvent = { name: string; args: unknown; ok: boolean; durationMs: number; value?: unknown; binding?: string };
```

Add private fields to the `AgentLoop` class (next to the other private fields such as `ajv`/`executor`):

```ts
  private readonly resultStore = new ResultStore();
  private invocationSeq = 0;
  private lastDepth0Binding: string | null = null;
```

Add a private helper method to the class:

```ts
  /** Stores a successful depth-0 tool result under a fresh binding and remembers it for elision. */
  private storeDepth0Result(name: string, result: ToolResult): string | null {
    if (!result.ok) { this.lastDepth0Binding = null; return null; }
    const binding = `r_${this.invocationSeq++}_${sanitizeBinding(name)}`;
    this.resultStore.put(binding, result.value);
    this.lastDepth0Binding = binding;
    return binding;
  }
```

- [ ] **Step 4: Resolve refs + store/record at depth 0 in `dispatchTool`**

Replace `dispatchTool` (lines 431-474) with:

```ts
  private async dispatchTool(name: string, args: unknown, task: Task, depth: number): Promise<ToolResult> {
    const tool = await this.opts.registry.get(name);
    if (!tool) return toolError("unknown_tool", `no tool named '${name}'`);

    // At the agent boundary (depth 0), arguments may carry { $ref } sentinels pointing at prior
    // results the agent never saw in full. Resolve them to concrete values before validation/execution;
    // keep the unresolved form (`recordArgs`) for lift.
    const recordArgs = args;
    let effectiveArgs = args;
    if (depth === 0) {
      const resolved = resolveRefs(args, this.resultStore);
      if (!resolved.ok) return toolError("schema_violation", resolved.error);
      effectiveArgs = resolved.value;
    }

    // Workflow tools run in-process via WorkflowExecutor
    if (tool.manifest.kind === TOOL_KIND.workflow) {
      const wf = await this.opts.registry.getWorkflow(name);
      if (!wf) return toolError("unknown_tool", `workflow '${name}' not found`);
      const schema = tool.manifest.inputSchema as Record<string, unknown>;
      const input = coerceStringifiedJsonInput(effectiveArgs, rootJsonSchemaKind(schema));
      if (!this.ajv.validate(schema, input)) {
        return toolError("schema_violation", `input does not match schema: ${this.ajv.errorsText()}`);
      }
      const result = await this.executor.run(wf, input as Record<string, unknown>, async (toolName, toolArgs, d) => {
        return this.dispatchTool(toolName, toolArgs, task, d);
      }, depth);
      if (depth === 0) this.storeDepth0Result(name, result); // store a handle for the model; not added to invocations (matches prior behavior)
      return result;
    }

    const schema = tool.manifest.inputSchema as Record<string, unknown>;
    const input = coerceStringifiedJsonInput(effectiveArgs, rootJsonSchemaKind(schema));

    const valid = this.ajv.validate(tool.manifest.inputSchema, input);
    if (!valid) return toolError("schema_violation", `input does not match schema: ${this.ajv.errorsText()}`);

    const approval = await this.opts.registry.getApproval(name);
    const decision = await this.opts.approval.checkExecution(tool, input, approval);
    if (decision.decision === APPROVAL_DECISION.reject) {
      this.opts.tracer.log(TRACE_KIND_EXECUTION_DENIED, { name, reason: decision.reason });
      return toolError("rejected_by_user", decision.reason);
    }

    const wantsLlm = tool.manifest.capabilities?.includes(TOOL_CAPABILITY.llm) ?? false;
    const started = Date.now();
    const result = await this.opts.sandbox.execute(tool, input, decision.token, {
      depth,
      onInvokeTool: (subName, subArgs) => this.dispatchTool(subName, subArgs, task, depth + 1),
      ...(wantsLlm ? { onLLM: (req) => this.runLlmCapability(req) } : {}),
    });
    const durationMs = Date.now() - started;
    this.opts.tracer.log(TRACE_KIND_TOOL_INVOKED, { name, duration: durationMs, ok: result.ok });
    if (depth === 0) {
      const binding = this.storeDepth0Result(name, result);
      this.opts.onToolInvoked?.({ name, args: recordArgs, ok: result.ok, durationMs, value: result.ok ? result.value : undefined, ...(binding !== null ? { binding } : {}) });
    } else {
      this.opts.onToolInvoked?.({ name, args: input, ok: result.ok, durationMs, value: result.ok ? result.value : undefined });
    }
    if (result.ok) task.invokedThisSession.add(name);
    return result;
  }
```

- [ ] **Step 5: Elide invoke_tool results to the model in `processOneToolCall`**

Replace the message push in `processOneToolCall` (lines 234-238) with:

```ts
    const isInvoke = call.function.name === META_FN.invokeTool;
    const content =
      isInvoke && result.ok && this.lastDepth0Binding !== null
        ? JSON.stringify(describeForModel(result.ok ? result.value : null, this.lastDepth0Binding))
        : JSON.stringify(result);
    this.lastDepth0Binding = null;
    messages.push({
      role: CHAT_ROLE.tool,
      tool_call_id: call.id,
      content,
    });
    return { done: false, invokeFailed, emptyFind };
```

> Rationale: `lastDepth0Binding` is set by `dispatchTool` during the awaited `dispatch` call just above (the loop is sequential, one tool call fully handled before the next), so it reflects this call's result. `find_tool`/`list_tools`/`stop` are not `invoke_tool`, so they serialize in full as before.

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test --experimental-transform-types --no-warnings src/agent/reference-flow.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full agent test file to catch regressions**

Run: `node --test --experimental-transform-types --no-warnings src/agent/agent-loop.test.ts`
Expected: PASS. If a test asserted the exact tool-message JSON for an `invoke_tool` result, update it: small results now appear as `{ ok: true, ref: "r_N_<tool>", value: <original> }`. (Large results become `{ ok, ref, shape, preview }`.) This is the intended elision; adjust the expectation to match.

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck` → PASS.

```bash
git add packages/core/src/agent/agent-loop.ts packages/core/src/agent/reference-flow.test.ts
git commit -m "feat(agent): store depth-0 results, resolve \$ref args, and elide outputs to handles"
```

---

## Task 9: Thread `binding` through the CLI invocation record

**Files:**
- Modify: `packages/cli/src/compose.ts:4, 32`
- Modify: `packages/cli/src/repl.ts:59`

- [ ] **Step 1: Add `binding` to `InvocationRecord`** (`compose.ts` line 4)

```ts
export type InvocationRecord = { name: string; args: unknown; ok: boolean; value?: unknown; binding?: string };
```

- [ ] **Step 2: Carry `binding` into the lift slice** (`compose.ts` line 32)

```ts
  const liftSlice = slice.map((s) => ({ name: s.name, args: s.args, ok: s.ok, value: s.value ?? null, ...(s.binding !== undefined ? { binding: s.binding } : {}) }));
```

- [ ] **Step 3: Record `binding` from the event** (`repl.ts` line 59)

```ts
    onToolInvoked: (ev) => invocations.push({ name: ev.name, args: ev.args, ok: ev.ok, value: ev.value, binding: ev.binding }),
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/compose.ts packages/cli/src/repl.ts
git commit -m "feat(cli): carry runtime result binding into the compose lift slice"
```

---

## Task 10: System prompt + builtin description teach the reference contract

**Files:**
- Modify: `packages/core/src/agent/system-prompt.ts:36`
- Modify: `packages/core/src/agent/builtins.ts:39-54`
- Test: `packages/core/src/agent/system-prompt.test.ts`

- [ ] **Step 1: Write/extend the failing test**

In `packages/core/src/agent/system-prompt.test.ts`, add an assertion that the prompt documents the reference contract:

```ts
test("system prompt explains the $ref reference contract", () => {
  const p = renderSystemPrompt({ catalog: [] });
  assert.match(p, /\$ref/);
  assert.match(p, /previous tool/i);
});
```

(Keep the file's existing import of `renderSystemPrompt`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-transform-types --no-warnings src/agent/system-prompt.test.ts`
Expected: FAIL — prompt does not mention `$ref`.

- [ ] **Step 3: Replace workflow-guidance point 8** (`system-prompt.ts` line 36)

```ts
8. Non-trivial tool results are returned to you as a handle: \`{ "ok": true, "ref": "<binding>", "shape": {...}, "preview": "..." }\`. The full value is NOT in the message — only the \`ref\` and a partial preview. To use a previous tool's output (whole value or one top-level field) as an argument to a later tool, pass a reference, never retyped or summarized text: \`{ "$ref": "<binding>", "path": "<optional top-level key>" }\`. Example: after a fetch bound to \`r_0_fetch_webpage_text\`, summarize it with \`${META_FN.invokeTool}("llm_generate", { instructions: "...", input: { "$ref": "r_0_fetch_webpage_text", "path": "text" } })\`. To transform data (summarize, rewrite, classify, extract), call \`llm_generate\` with the \`$ref\` as \`input\` — do not produce the transformed text yourself. This keeps generated values as real, referenceable tool results so they compose and lift into workflows.
```

- [ ] **Step 4: Update the `llm_generate` description** (`builtins.ts` lines 39-42 and the `input` property description lines 52-54)

Description string:
```ts
    description:
      "Generate a value with the language model from an instruction and raw input data. " +
      "Pass the prior tool's output by reference as input ({ \"$ref\": \"<binding>\", \"path\": \"<optional key>\" }); do not pre-summarize or excerpt. " +
      "Returns the model's output (a string unless outputSchema is given).",
```

`input` property description:
```ts
        input: {
          description:
            "Raw data to transform (any JSON value). When chaining tools, pass the prior tool's result by reference ({ \"$ref\": \"<binding>\", \"path\"? }) unchanged—do not pre-summarize.",
        },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test --experimental-transform-types --no-warnings src/agent/system-prompt.test.ts`
Expected: PASS.

> Note: `builtins.ts` changes the `llm_generate` manifest text, which changes its hash. The built-in is re-seeded with `alwaysApprove: true`, so this is fine; no test asserts the old hash. If `builtins.test.ts` pins a hash literal, update it to the new value printed by the failing test.

- [ ] **Step 6: Run the full core suite + typecheck**

Run (from `packages/core`): `npm test` → PASS.
Run: `npm run typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent/system-prompt.ts packages/core/src/agent/builtins.ts packages/core/src/agent/system-prompt.test.ts
git commit -m "feat(agent): teach the \$ref reference contract in the system prompt and llm_generate"
```

---

## Task 11: End-to-end — sentinel invocations lift, validate, and execute

**Files:**
- Test: `packages/core/src/workflow/reference-lift.e2e.test.ts`

- [ ] **Step 1: Write the end-to-end test**

Create `packages/core/src/workflow/reference-lift.e2e.test.ts`. It builds a 3-invocation slice that mirrors `summarize_online_paper` (fetch → llm_generate with `$ref`→ write with `$ref`), lifts it, validates it against a registry, and executes it with a stub dispatcher — asserting the summarize step receives the projected fetch field and the workflow returns the write result.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { liftFromTrace } from "./lift.ts";
import { validate } from "./validator.ts";
import { WorkflowExecutor } from "./executor.ts";
import type { Tool } from "../types.ts";

function atomicTool(name: string): Tool {
  return {
    manifest: {
      name, description: "", rationale: "", inputSchema: {}, outputShape: {},
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [], limits: { timeoutMs: 1000, maxOldSpaceSizeMb: 64 },
      hash: "sha256:0", createdAt: "2026-01-01T00:00:00.000Z", kind: "atomic",
    },
    code: "",
  };
}

function registryOf(tools: Tool[]) {
  const byName = new Map(tools.map((t) => [t.manifest.name, t]));
  return { get: async (n: string) => byName.get(n) ?? null } as never; // validator only calls get()
}

const noopTracer = () => ({ log() {} }) as never;

test("e2e: fetch -> llm_generate(\$ref.text) -> write(\$ref) lifts, validates, executes", async () => {
  const fetchVal = { text: "LONG BODY", title: "T", url: "u" };
  const slice = [
    { name: "fetch_webpage_text", args: { url: "u" }, ok: true as const, value: fetchVal, binding: "r_0_fetch_webpage_text" },
    { name: "llm_generate", args: { instructions: "summarize", input: { $ref: "r_0_fetch_webpage_text", path: "text" } }, ok: true as const, value: "THE SUMMARY", binding: "r_1_llm_generate" },
    { name: "write_file_text", args: { path: "out.md", content: { $ref: "r_1_llm_generate" } }, ok: true as const, value: { written: true }, binding: "r_2_write_file_text" },
  ];
  const tools = [atomicTool("fetch_webpage_text"), atomicTool("llm_generate"), atomicTool("write_file_text")];
  const toolsByName = Object.fromEntries(tools.map((t) => [t.manifest.name, t]));

  const lifted = liftFromTrace({ slice, name: "summarize_online_paper", description: "d", goal: "g", toolsByName });
  assert.equal(lifted.ok, true);
  const wf = (lifted as { ok: true; workflow: import("./types.ts").Workflow }).workflow;
  assert.deepEqual(wf.steps[1]!.arguments.input, { kind: "symref", ref: "r_0_fetch_webpage_text", path: "text" });
  assert.deepEqual(wf.steps[2]!.arguments.content, { kind: "symref", ref: "r_1_llm_generate" });

  const valid = await validate(wf, registryOf(tools));
  assert.equal(valid.ok, true);

  const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = async (name: string, args: unknown) => {
    seen.push({ name, args: args as Record<string, unknown> });
    if (name === "fetch_webpage_text") return { ok: true as const, value: fetchVal };
    if (name === "llm_generate") return { ok: true as const, value: "THE SUMMARY" };
    return { ok: true as const, value: { written: true } };
  };
  const res = await new WorkflowExecutor({ tracer: noopTracer() }).run(wf, {}, dispatch, 0);
  assert.equal(res.ok, true);
  assert.deepEqual((res as { ok: true; value: unknown }).value, { written: true });
  assert.deepEqual(seen[1]!.args, { instructions: "summarize", input: "LONG BODY" }); // projected fetch.text
  assert.deepEqual(seen[2]!.args, { path: "out.md", content: "THE SUMMARY" });
});
```

- [ ] **Step 2: Run the test**

Run: `node --test --experimental-transform-types --no-warnings src/workflow/reference-lift.e2e.test.ts`
Expected: PASS (all prior tasks make this green; no new production code needed).

- [ ] **Step 3: Full suite + typecheck**

Run (from `packages/core`): `npm test` → PASS.
Run: `npm run typecheck` → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/workflow/reference-lift.e2e.test.ts
git commit -m "test(workflow): e2e reference lift -> validate -> execute parity"
```

---

## Done — verification checklist

- [ ] From `packages/core`: `npm test` passes (whole suite).
- [ ] From repo root: `npm run typecheck` passes.
- [ ] Manual smoke (optional): run the CLI (`npm run cli`), perform a `fetch → llm_generate → write` task, then `/compose` the slice and confirm the lifted `workflow.json` has `input` as a `symref` with `path: "text"` (not a literal), and the trace `.jsonl` contains `llm-call` events with full `request`/`response`.

## Deviation from spec (recorded)

- Spec §5.4 originally degraded an out-of-slice `$ref` to a literal using the resolved value. To keep `liftFromTrace` a pure function over the slice (no result-store dependency), this plan instead returns a `ref_out_of_slice` lift error ("widen the slice"). The spec was updated to match.
- The optional lift-time "derived literal" diagnostic (spec §9.1) is intentionally **not** implemented (deferred).
