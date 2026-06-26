# LLM Tool Calls in the Workflow IR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workflow step produce a value by invoking the LLM, modeled as a `tool_call` to a built-in `llm_generate` tool that is backed by a mediated, network-less sandbox capability.

**Architecture:** A new `llm` RPC channel mirrors the existing `invokeTool` channel: sandboxed tool code calls `globalThis.llm(req)`, the parent services it via a host `onLlm` handler that calls the host `LLMProvider`. `llm_generate` is an ordinary atomic tool declaring a new, hash-gated `capabilities: ["llm"]`; the host only wires `onLlm` for tools that declare it, and the parent refuses the capability otherwise. No new IR node or step kind.

**Tech Stack:** TypeScript (strict, Node ≥ 25), `node:test` + `node:assert/strict`, Ajv. No new dependencies.

**Spec:** [`docs/2026-06-05-llm-tool-call-design.md`](2026-06-05-llm-tool-call-design.md)

---

## File Structure

**Modify:**
- `packages/core/src/types.ts` — add `capabilities?: string[]` to `ToolManifest`; add `TOOL_CAPABILITY` / `KNOWN_TOOL_CAPABILITIES`.
- `packages/core/src/sandbox/stdio-protocol.ts` — add `llm` / `llmResult` ops + frame types.
- `packages/core/src/sandbox/runner.ts` — install `globalThis.llm`; handle `llmResult` stdin frame.
- `packages/core/src/sandbox/interface.ts` — add `onLlm` + `LlmCapabilityRequest` / `LlmHandler` to `ExecuteOpts`.
- `packages/core/src/sandbox/node-permission-sandbox.ts` — service the `llm` stdout frame via `onLlm`; thread it through.
- `packages/core/src/agent/agent-loop.ts` — wire `onLlm` (only when the tool declares the capability); host LLM handler.
- `packages/core/src/factory/static-validator.ts` — forbid authored drafts from declaring `capabilities`.
- `packages/core/src/workflow/validator.ts` — reject a step whose callee declares an unknown capability.
- `packages/core/src/agent/system-prompt.ts` — nudge the agent to route generation through `llm_generate`.
- `packages/core/src/index.ts` — export the new built-in helpers.
- `packages/cli/src/repl.ts` — seed the built-in at startup.

**Create:**
- `packages/core/src/agent/builtins.ts` — `llm_generate` tool definition + `seedBuiltins(registry)`.
- `packages/core/src/sandbox/fixtures/llm-tool.ts` — test fixture that calls `globalThis.llm`.
- `packages/core/src/hash.test.ts`, `packages/core/src/sandbox/stdio-protocol.test.ts`, `packages/core/src/agent/builtins.test.ts`, `packages/core/src/workflow/llm-step.e2e.test.ts` — new tests.

**Test command (from `packages/core`):** `npm test`
**Typecheck (from repo root):** `npm run typecheck`

---

## Task 1: `capabilities` manifest field + capability catalog

**Files:**
- Modify: `packages/core/src/types.ts`
- Test: `packages/core/src/hash.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/hash.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTool } from "./hash.ts";
import { KNOWN_TOOL_CAPABILITIES, TOOL_CAPABILITY } from "./types.ts";

const BASE = {
  name: "t", description: "d", rationale: "r",
  inputSchema: { type: "object" }, outputShape: {},
  permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  dependencies: [], limits: { timeoutMs: 1000, maxOldSpaceSizeMb: 256 },
  createdAt: "1970-01-01T00:00:00.000Z", kind: "atomic",
} as const;

test("known capabilities include llm", () => {
  assert.equal(TOOL_CAPABILITY.llm, "llm");
  assert.ok(KNOWN_TOOL_CAPABILITIES.has("llm"));
});

test("capabilities participate in the tool hash", () => {
  const a = hashTool("code", { ...BASE });
  const b = hashTool("code", { ...BASE, capabilities: ["llm"] });
  assert.notEqual(a, b);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` (in `packages/core`)
Expected: FAIL — `TOOL_CAPABILITY`/`KNOWN_TOOL_CAPABILITIES` not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`, after the `TOOL_KIND` block, add:

```ts
/** Mediated, host-serviced capabilities a tool may declare in its manifest. */
export const TOOL_CAPABILITY = {
  llm: "llm",
} as const;

export type ToolCapability = (typeof TOOL_CAPABILITY)[keyof typeof TOOL_CAPABILITY];

/** The set of capability strings the host understands and is willing to service. */
export const KNOWN_TOOL_CAPABILITIES: ReadonlySet<string> = new Set(Object.values(TOOL_CAPABILITY));
```

In the `ToolManifest` type, add the field right below `kind: ToolKind;`:

```ts
  kind: ToolKind;
  /** Mediated host capabilities this tool may use (e.g. "llm"). Part of the hash. */
  capabilities?: string[];
```

(No change to `hash.ts` is needed: `hashTool` canonical-JSONs the whole manifest-without-hash, so `capabilities` is included automatically.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/hash.test.ts
git commit -m "feat(types): add manifest capabilities field and catalog"
```

---

## Task 2: `llm` / `llmResult` stdio protocol frames

**Files:**
- Modify: `packages/core/src/sandbox/stdio-protocol.ts`
- Test: `packages/core/src/sandbox/stdio-protocol.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/sandbox/stdio-protocol.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SANDBOX_STDIO_OP } from "./stdio-protocol.ts";

test("protocol defines llm and llmResult ops", () => {
  assert.equal(SANDBOX_STDIO_OP.llm, "llm");
  assert.equal(SANDBOX_STDIO_OP.llmResult, "llmResult");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `SANDBOX_STDIO_OP.llm` is `undefined`.

- [ ] **Step 3: Implement**

In `packages/core/src/sandbox/stdio-protocol.ts`, extend the op map and add frame types. Replace the `SANDBOX_STDIO_OP` object with:

```ts
export const SANDBOX_STDIO_OP = {
  args: "args",
  invokeTool: "invokeTool",
  invokeToolResult: "invokeToolResult",
  llm: "llm",
  llmResult: "llmResult",
  result: "result",
} as const;
```

Add a request type near the top (after the imports):

```ts
/** Structured, host-controlled request for the mediated `llm` capability. */
export type LlmCapabilityRequest = { instructions: string; input: unknown; schema?: Record<string, unknown> };
```

Add the two frame types and extend the unions. After `SandboxChildStdoutInvokeToolFrame`:

```ts
/** Child → parent on the child stdout pipe (`llm` capability request). */
export type SandboxChildStdoutLlmFrame = {
  op: typeof SANDBOX_STDIO_OP.llm;
  requestId: string;
  req: LlmCapabilityRequest;
};
```

Update the stdout union:

```ts
export type SandboxChildStdoutFrame =
  | SandboxChildStdoutInvokeToolFrame
  | SandboxChildStdoutLlmFrame
  | SandboxChildStdoutResultFrame;
```

After `SandboxChildStdinInvokeToolResultFrame`:

```ts
/** Parent → child on the child stdin pipe (`llm` capability reply). */
export type SandboxChildStdinLlmResultFrame = {
  op: typeof SANDBOX_STDIO_OP.llmResult;
  requestId: string;
  result: ToolResult;
};
```

Update the stdin union:

```ts
export type SandboxChildStdinFrame =
  | SandboxChildStdinArgsFrame
  | SandboxChildStdinInvokeToolResultFrame
  | SandboxChildStdinLlmResultFrame;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sandbox/stdio-protocol.ts packages/core/src/sandbox/stdio-protocol.test.ts
git commit -m "feat(sandbox): add llm/llmResult protocol frames"
```

---

## Task 3: Runner installs `globalThis.llm`

**Files:**
- Modify: `packages/core/src/sandbox/runner.ts`
- Create: `packages/core/src/sandbox/fixtures/llm-tool.ts`
- Test: `packages/core/src/sandbox/runner.test.ts`

- [ ] **Step 1: Create the fixture**

```ts
// packages/core/src/sandbox/fixtures/llm-tool.ts
export async function run(input: { instructions: string; input?: unknown }): Promise<unknown> {
  const g = globalThis as unknown as { llm: (req: unknown) => Promise<unknown> };
  return g.llm({ instructions: input.instructions, input: input.input });
}
```

- [ ] **Step 2: Write the failing test**

Append to `packages/core/src/sandbox/runner.test.ts`:

```ts
const LLM = join(__dirname, "fixtures/llm-tool.ts");

function runChildWithLlm(
  toolPath: string,
  args: unknown,
  reply: (req: unknown) => unknown,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", RUNNER, toolPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let buf = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
      buf += c.toString();
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame.op === "llm") {
          const result = { ok: true, value: reply(frame.req) };
          child.stdin.write(JSON.stringify({ op: "llmResult", requestId: frame.requestId, result }) + "\n");
        }
      }
    });
    child.on("close", (code) => resolve({ stdout, code }));
    child.stdin.write(JSON.stringify({ op: "args", args }) + "\n");
  });
}

test("runner services globalThis.llm via llm/llmResult round-trip", async () => {
  const { stdout, code } = await runChildWithLlm(
    LLM,
    { instructions: "say hi", input: "x" },
    (req) => `echo:${(req as { instructions: string }).instructions}`,
  );
  assert.equal(code, 0);
  const last = stdout.trim().split("\n").pop()!;
  const frame = JSON.parse(last);
  assert.equal(frame.op, "result");
  assert.equal(frame.result.ok, true);
  assert.equal(frame.result.value, "echo:say hi");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `globalThis.llm` is not a function; the fixture throws.

- [ ] **Step 4: Implement**

In `packages/core/src/sandbox/runner.ts`:

Add a pending map next to `pendingInvokes`:

```ts
/** Pending `llm` calls keyed by `requestId`; the parent completes each with an `llmResult` stdin line. */
const pendingLlm = new Map<string, (r: ToolResult) => void>();
```

Add the installer after `installInvokeToolGlobal`, and call it:

```ts
/**
 * Installs `globalThis.llm` so a capability-bearing tool can request a host LLM call;
 * each call emits `llm` on stdout and awaits the matching `llmResult` line. Resolves to
 * the produced value, or throws on a failed `ToolResult`.
 */
function installLlmGlobal(): void {
  (globalThis as unknown as { llm: (req: unknown) => Promise<unknown> }).llm =
    async function llm(req: unknown) {
      const requestId = Math.random().toString(36).slice(2);
      writeStdoutFrame({ op: SANDBOX_STDIO_OP.llm, requestId, req } as SandboxChildStdoutFrame);
      const result = await new Promise<ToolResult>((resolve) => pendingLlm.set(requestId, resolve));
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
}

installLlmGlobal();
```

In `handleParentStdinJsonLine`, add a branch alongside the existing `invokeToolResult` branch:

```ts
    } else if (frame.op === SANDBOX_STDIO_OP.llmResult) {
      const cb = pendingLlm.get(frame.requestId);
      pendingLlm.delete(frame.requestId);
      cb?.(frame.result);
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/sandbox/runner.ts packages/core/src/sandbox/fixtures/llm-tool.ts packages/core/src/sandbox/runner.test.ts
git commit -m "feat(sandbox): install mediated globalThis.llm in runner"
```

---

## Task 4: Parent services the `llm` frame via `onLlm` (with gating)

**Files:**
- Modify: `packages/core/src/sandbox/interface.ts`
- Modify: `packages/core/src/sandbox/node-permission-sandbox.ts`
- Test: `packages/core/src/sandbox/node-permission-sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/sandbox/node-permission-sandbox.test.ts`:

```ts
const LLM_FIXTURE = join(FIXTURES, "llm-tool.ts");

test("sandbox routes llm frame to onLlm handler", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const tool = mkTool("llm", { fsRead: [FIXTURES] });
  const r = await sb.execute(tool, { instructions: "go", input: 1 }, "token", {
    toolPath: LLM_FIXTURE,
    onLlm: async (req) => ({ ok: true, value: `ok:${req.instructions}` }),
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, "ok:go");
});

test("sandbox denies llm capability when no onLlm handler is wired", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const tool = mkTool("llm", { fsRead: [FIXTURES] });
  const r = await sb.execute(tool, { instructions: "go" }, "token", { toolPath: LLM_FIXTURE });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "permission_denied");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `onLlm` not in `ExecuteOpts`; the `llm` frame is ignored and the run times out / errors.

- [ ] **Step 3: Implement the interface**

In `packages/core/src/sandbox/interface.ts`, add the request/handler types and the option. After the `InvokeToolHandler` definition:

```ts
import type { LlmCapabilityRequest } from "./stdio-protocol.ts";

/**
 * Handler invoked when a capability-bearing tool calls the mediated `llm` capability.
 * The host performs the model call; the tool never sees network or secrets.
 */
export type LlmHandler = (req: LlmCapabilityRequest) => Promise<ToolResult>;
```

Add to `ExecuteOpts`:

```ts
  /** Handler for the mediated `llm` capability. Wire only for tools that declare `capabilities: ["llm"]`. */
  onLlm?: LlmHandler;
```

(Re-export `LlmCapabilityRequest` from `interface.ts` if convenient: `export type { LlmCapabilityRequest } from "./stdio-protocol.ts";`)

- [ ] **Step 4: Implement the parent handling**

In `packages/core/src/sandbox/node-permission-sandbox.ts`:

Add imports:

```ts
import type { ExecuteOpts, InvokeToolHandler, LlmHandler, Sandbox } from "./interface.ts";
import {
  META_AGENT_NET_ALLOWLIST_ENV,
  SANDBOX_STDIO_OP,
  type SandboxChildStdinArgsFrame,
  type SandboxChildStdinInvokeToolResultFrame,
  type SandboxChildStdinLlmResultFrame,
  type SandboxChildStdoutFrame,
} from "./stdio-protocol.ts";
```

Extend the `opts` parameter of `handleChildStdoutJsonLine` to include `onLlm`:

```ts
  opts: {
    stdin: NodeJS.WritableStream;
    onInvoke: InvokeToolHandler | undefined;
    onLlm: LlmHandler | undefined;
    timer: NodeJS.Timeout;
    resolve: (r: ToolResult) => void;
  },
```

Add an `llm` branch inside `handleChildStdoutJsonLine`, after the `invokeTool` branch:

```ts
  } else if (frame.op === SANDBOX_STDIO_OP.llm) {
    let result: ToolResult;
    try {
      result = opts.onLlm
        ? await opts.onLlm(frame.req)
        : toolError("permission_denied", "tool used the llm capability without it being granted");
    } catch (e) {
      result = toolError("runtime_error", (e as Error).message);
    }
    const reply: SandboxChildStdinLlmResultFrame = {
      op: SANDBOX_STDIO_OP.llmResult,
      requestId: frame.requestId,
      result,
    };
    opts.stdin.write(JSON.stringify(reply) + "\n");
  } else if (frame.op === SANDBOX_STDIO_OP.result) {
```

(The final `else if (frame.op === SANDBOX_STDIO_OP.result)` is the existing branch — keep its body.)

Thread `onLlm` from `execute` → `run` → `stdoutLineOpts`. In `execute`, change the `run` call:

```ts
      return await this.run(tool, args, toolPath, opts.onInvokeTool, opts.onLlm, opts.depth ?? 0);
```

Update the `run` signature:

```ts
  private run(
    tool: Tool,
    args: unknown,
    toolPath: string,
    onInvoke: InvokeToolHandler | undefined,
    onLlm: LlmHandler | undefined,
    _depth: number,
  ): Promise<ToolResult> {
```

Update `stdoutLineOpts`:

```ts
      const stdoutLineOpts = {
        stdin: child.stdin!,
        onInvoke,
        onLlm,
        timer,
        resolve,
      };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS (both new tests)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/sandbox/interface.ts packages/core/src/sandbox/node-permission-sandbox.ts packages/core/src/sandbox/node-permission-sandbox.test.ts
git commit -m "feat(sandbox): service mediated llm capability via onLlm with gating"
```

---

## Task 5: `llm_generate` built-in tool + `seedBuiltins`

**Files:**
- Create: `packages/core/src/agent/builtins.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/agent/builtins.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/agent/builtins.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLlmGenerateTool, LLM_GENERATE_NAME, seedBuiltins } from "./builtins.ts";
import { FsToolRegistry } from "../registry/fs-registry.ts";
import { TOOL_CAPABILITY } from "../types.ts";

test("llm_generate is atomic, declares llm capability, no net/env, taint-labeled", () => {
  const t = buildLlmGenerateTool();
  assert.equal(t.manifest.name, LLM_GENERATE_NAME);
  assert.equal(t.manifest.kind, "atomic");
  assert.deepEqual(t.manifest.capabilities, [TOOL_CAPABILITY.llm]);
  assert.equal(t.manifest.permissions.net, "none");
  assert.deepEqual(t.manifest.permissions.env, []);
  assert.deepEqual(t.manifest.sourceLabels, ["llm_generated"]);
  assert.match(t.manifest.hash, /^sha256:[0-9a-f]{64}$/);
});

test("buildLlmGenerateTool is deterministic", () => {
  assert.equal(buildLlmGenerateTool().manifest.hash, buildLlmGenerateTool().manifest.hash);
});

test("seedBuiltins registers llm_generate once with an always-approve record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seed-"));
  try {
    const reg = await FsToolRegistry.open(dir);
    await seedBuiltins(reg);
    await seedBuiltins(reg); // idempotent
    assert.equal(await reg.has(LLM_GENERATE_NAME), true);
    const approval = await reg.getApproval(LLM_GENERATE_NAME);
    assert.equal(approval?.alwaysApprove, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `./builtins.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/agent/builtins.ts
import { hashTool } from "../hash.ts";
import type { ApprovalRecord, Tool, ToolManifest } from "../types.ts";
import { PERMISSIONS_NET, TOOL_CAPABILITY, TOOL_KIND } from "../types.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";

/** Registry name of the built-in LLM generation primitive. */
export const LLM_GENERATE_NAME = "llm_generate";

/** Fixed timestamp so the built-in hash is deterministic across processes. */
const BUILTIN_EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * Forwarder body. It performs no I/O itself — it round-trips a structured request
 * through the mediated `globalThis.llm` capability the sandbox parent services.
 */
const LLM_GENERATE_CODE = `export async function run(input) {
  const g = globalThis;
  if (typeof g.llm !== "function") throw new Error("llm capability not available");
  return await g.llm({ instructions: input.instructions, input: input.input, schema: input.outputSchema });
}
`;

/** Builds the `llm_generate` built-in tool (manifest + code), with a deterministic hash. */
export function buildLlmGenerateTool(): Tool {
  const manifestNoHash: Omit<ToolManifest, "hash"> = {
    name: LLM_GENERATE_NAME,
    description:
      "Generate a value with the language model from an instruction and an input. " +
      "Returns the model's output (a string unless outputSchema is given).",
    rationale: "Built-in primitive that lets a workflow step produce a value via the LLM, captured as a SymRef-able result.",
    inputSchema: {
      type: "object",
      properties: {
        instructions: { type: "string", description: "What the model should do with the input." },
        input: { description: "The data to operate on (any JSON value)." },
        outputSchema: { type: "object", description: "Optional JSON Schema; when present, structured output is requested." },
      },
      required: ["instructions"],
      additionalProperties: false,
    },
    outputShape: {},
    permissions: { fsRead: [], fsWrite: [], net: PERMISSIONS_NET.none, netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 60_000, maxOldSpaceSizeMb: 256 },
    createdAt: BUILTIN_EPOCH,
    kind: TOOL_KIND.atomic,
    capabilities: [TOOL_CAPABILITY.llm],
    sourceLabels: ["llm_generated"],
  };
  const hash = hashTool(LLM_GENERATE_CODE, manifestNoHash);
  return { manifest: { ...manifestNoHash, hash }, code: LLM_GENERATE_CODE };
}

/** Seeds trusted built-in tools into the registry if absent. Idempotent. */
export async function seedBuiltins(registry: ToolRegistry): Promise<void> {
  if (await registry.has(LLM_GENERATE_NAME)) return;
  const tool = buildLlmGenerateTool();
  const approval: ApprovalRecord = {
    hash: tool.manifest.hash,
    approvedAt: BUILTIN_EPOCH,
    approvedBy: "builtin",
    alwaysApprove: true,
    notes: "Trusted built-in seeded by the host.",
  };
  await registry.save(tool, approval);
}
```

In `packages/core/src/index.ts`, add after the `AgentLoop` export:

```ts
export { buildLlmGenerateTool, seedBuiltins, LLM_GENERATE_NAME } from "./agent/builtins.ts";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/builtins.ts packages/core/src/agent/builtins.test.ts packages/core/src/index.ts
git commit -m "feat(agent): add llm_generate built-in tool and seedBuiltins"
```

---

## Task 6: Wire `onLlm` in `AgentLoop.dispatchTool`

**Files:**
- Modify: `packages/core/src/agent/agent-loop.ts`
- Test: `packages/core/src/workflow/llm-step.e2e.test.ts` covers this end-to-end in Task 10. (No separate unit test here; the wiring is exercised by Task 10.)

- [ ] **Step 1: Implement the host LLM handler**

In `packages/core/src/agent/agent-loop.ts`, add imports:

```ts
import type { LlmCapabilityRequest } from "../sandbox/interface.ts";
import { TOOL_CAPABILITY } from "../types.ts";
import { buildLlmGenerateTool } from "./builtins.ts"; // not strictly needed; omit if unused
```

(Only import what you use — `TOOL_CAPABILITY` and `LlmCapabilityRequest` are required; drop the `builtins` import if unused.)

Add module-level constants near the other prompt constants:

```ts
/** System prompt for the mediated llm_generate capability: the model is a pure data transformer. */
const LLM_GENERATE_SYSTEM =
  "You transform the given INPUT according to the INSTRUCTIONS and return only the result. " +
  "Do not ask questions, do not call tools, do not add commentary.";

/** Renders the user message for an llm capability request. */
function renderLlmInstruction(instructions: string, input: unknown): string {
  const rendered = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  return `${instructions}\n\n--- INPUT ---\n${rendered}`;
}
```

Add a private method on `AgentLoop`:

```ts
  /** Services a sandboxed tool's mediated `llm` capability using the host LLM provider. */
  private async runLlmCapability(req: LlmCapabilityRequest): Promise<ToolResult> {
    const messages: ChatMessage[] = [
      { role: CHAT_ROLE.system, content: LLM_GENERATE_SYSTEM },
      { role: CHAT_ROLE.user, content: renderLlmInstruction(req.instructions, req.input) },
    ];
    try {
      if (req.schema) {
        const value = await this.opts.llm.generateStructured({ messages, schemaName: "llm_generate", schema: req.schema });
        return { ok: true, value };
      }
      const resp = await this.opts.llm.chat({ messages });
      return { ok: true, value: resp.message.content ?? "" };
    } catch (e) {
      return toolError("runtime_error", `llm capability failed: ${(e as Error).message}`);
    }
  }
```

- [ ] **Step 2: Wire it into the atomic/composite sandbox dispatch**

In `dispatchTool`, find the existing `sandbox.execute` call (the atomic/composite path that passes `onInvokeTool`) and add `onLlm` conditionally:

```ts
    const wantsLlm = tool.manifest.capabilities?.includes(TOOL_CAPABILITY.llm) ?? false;
    const started = Date.now();
    const result = await this.opts.sandbox.execute(tool, input, decision.token, {
      depth,
      onInvokeTool: (subName, subArgs) => this.dispatchTool(subName, subArgs, task, depth + 1),
      ...(wantsLlm ? { onLlm: (req) => this.runLlmCapability(req) } : {}),
    });
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck` (repo root)
Expected: PASS (no unused imports; `ChatMessage`, `CHAT_ROLE`, `toolError` are already imported in this file).

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (existing tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/agent-loop.ts
git commit -m "feat(agent): wire host onLlm handler for capability-bearing tools"
```

---

## Task 7: Static validator forbids authored `capabilities`

**Files:**
- Modify: `packages/core/src/factory/static-validator.ts`
- Test: `packages/core/src/factory/static-validator.test.ts` (create if absent; otherwise append)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/factory/static-validator.test.ts  (append if file exists)
import { test } from "node:test";
import assert from "node:assert/strict";
import { staticValidateDraft } from "./static-validator.ts";
import type { ToolDraft } from "../types.ts";

function baseDraft(extra: Record<string, unknown> = {}): ToolDraft {
  return {
    name: "my-tool", description: "d", rationale: "r",
    inputSchema: { type: "object" }, outputShape: { type: "object" },
    permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    code: "export async function run(){ return {}; }",
    dependencies: [], smokeTestInput: {}, kind: "atomic",
    ...extra,
  } as ToolDraft;
}

test("authored drafts may not declare capabilities", () => {
  const r = staticValidateDraft(baseDraft({ capabilities: ["llm"] }), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => /capabilities/.test(e)));
});

test("normal authored draft still validates", () => {
  const r = staticValidateDraft(baseDraft(), { existingNames: new Set(), tombstoned: new Set() });
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — first test: the draft with `capabilities` is accepted.

- [ ] **Step 3: Implement**

In `packages/core/src/factory/static-validator.ts`, add a checker and call it in `staticValidateDraft`:

```ts
function validateNoPrivilegedCapabilities(draft: ToolDraft, errs: string[]): void {
  const caps = (draft as unknown as Record<string, unknown>).capabilities;
  if (Array.isArray(caps) && caps.length > 0) {
    errs.push(
      `capabilities may not be declared by authored tools (got ${JSON.stringify(caps)}); ` +
      "privileged capabilities are reserved for built-ins",
    );
  }
}
```

Call it inside `staticValidateDraft`, after `validatePermissionsBlock(draft.permissions, errs);`:

```ts
  validateNoPrivilegedCapabilities(draft, errs);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/factory/static-validator.ts packages/core/src/factory/static-validator.test.ts
git commit -m "feat(factory): forbid authored tools from declaring capabilities"
```

---

## Task 8: Workflow validator rejects unknown callee capabilities

**Files:**
- Modify: `packages/core/src/workflow/validator.ts`
- Test: `packages/core/src/workflow/validator.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/workflow/validator.test.ts` (mirror the existing test setup in that file for building a registry/workflow; the snippet below shows the assertion shape — reuse the file's existing `baseWorkflow()` / registry helpers):

```ts
test("validator rejects a step whose tool declares an unknown capability", async () => {
  const { registry, workflow } = await setupWithToolCapabilities(["telepathy"]); // helper mirrors existing tests
  const r = await validate(workflow, registry);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.code === "unknown_capability"));
});
```

> Implementer note: `validator.test.ts` already constructs registries with fake tools. Add a small helper there that registers a tool whose `manifest.capabilities = ["telepathy"]` and a one-step workflow that calls it, returning `{ registry, workflow }`. Reuse the file's existing `pushValidationError`/registry patterns rather than inventing new ones.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — no `unknown_capability` error is produced.

- [ ] **Step 3: Implement**

In `packages/core/src/workflow/validator.ts`, import the catalog:

```ts
import { KNOWN_TOOL_CAPABILITIES } from "../types.ts";
```

After the existing callee lookup (`const callee = await registry.get(step.tool);`) and its `unknown_tool` check, add:

```ts
    if (callee?.manifest.capabilities) {
      for (const cap of callee.manifest.capabilities) {
        if (!KNOWN_TOOL_CAPABILITIES.has(cap)) {
          pushStepValidationError(
            errors, step, `${stepPtr}/tool`,
            "unknown_capability", `tool '${step.tool}' declares unknown capability '${cap}'`,
          );
        }
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow/validator.ts packages/core/src/workflow/validator.test.ts
git commit -m "feat(workflow): reject steps calling tools with unknown capabilities"
```

---

## Task 9: System-prompt nudge to route generation through `llm_generate`

**Files:**
- Modify: `packages/core/src/agent/system-prompt.ts`
- Test: `packages/core/src/agent/system-prompt.test.ts` (create if absent; otherwise append)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/agent/system-prompt.test.ts (append if exists)
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSystemPrompt } from "./system-prompt.ts";

test("system prompt instructs routing generation through llm_generate", () => {
  const p = renderSystemPrompt({ catalog: [] });
  assert.match(p, /llm_generate/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — prompt does not mention `llm_generate`.

- [ ] **Step 3: Implement**

In `packages/core/src/agent/system-prompt.ts`, add a guidance line. Insert a new numbered item into the "Workflow guidance" list (after item 7), before the closing backtick template:

```ts
8. When a step's value must be produced by the model itself (summaries, rewrites, classification, extraction), call the \`llm_generate\` tool via ${META_FN.invokeTool} instead of writing that content inline. This keeps generated values as real tool results so they can be composed and reused.
```

(Place it inside the existing template string where items 1–7 are listed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/system-prompt.ts packages/core/src/agent/system-prompt.test.ts
git commit -m "feat(agent): nudge agent to route generation through llm_generate"
```

---

## Task 10: End-to-end — a workflow step generates a value via `llm_generate`

**Files:**
- Create: `packages/core/src/workflow/llm-step.e2e.test.ts`

This exercises the full IR → executor → dispatch → sandbox → mediated capability → host LLM path with a real `NodePermissionSandbox`, the real `llm_generate` tool, and a `MockLLMProvider`.

- [ ] **Step 1: Write the test**

```ts
// packages/core/src/workflow/llm-step.e2e.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowExecutor } from "./executor.ts";
import { Tracer } from "../tracer.ts";
import { NodePermissionSandbox } from "../sandbox/node-permission-sandbox.ts";
import { MockLLMProvider } from "../llm/mock-provider.ts";
import { buildLlmGenerateTool, LLM_GENERATE_NAME } from "../agent/builtins.ts";
import { CHAT_ROLE } from "../llm/interface.ts";
import { toolError } from "../errors.ts";
import type { Workflow } from "./types.ts";
import type { ToolResult } from "../types.ts";

const WF: Workflow = {
  schemaVersion: 1,
  name: "summarize-once",
  description: "",
  goal: "",
  inputs: [],
  steps: [
    {
      kind: "tool_call",
      label: "step_0_llm_generate",
      tool: LLM_GENERATE_NAME,
      arguments: {
        instructions: { kind: "literal", value: "Summarize the input." },
        input: { kind: "literal", value: "a long passage about RIG" },
      },
      resultBinding: "r_0_llm_generate",
    },
  ],
  return: { source: { kind: "symref", ref: "r_0_llm_generate" } },
};

test("workflow step produces a value through the mediated llm capability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llm-e2e-"));
  try {
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const mock = new MockLLMProvider().onChat((req) => {
      const user = req.messages.find((m) => m.role === CHAT_ROLE.user);
      assert.match((user as { content: string }).content, /Summarize the input/);
      return { message: { role: "assistant", content: "SHORT SUMMARY" } };
    });
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const tool = buildLlmGenerateTool();

    const dispatch = async (name: string, args: unknown): Promise<ToolResult> => {
      if (name !== LLM_GENERATE_NAME) return toolError("unknown_tool", name);
      return sandbox.execute(tool, args, "token", {
        onLlm: async (cap) => {
          const resp = await mock.chat({
            messages: [{ role: CHAT_ROLE.user, content: `${cap.instructions}` }],
          });
          return { ok: true, value: resp.message.content ?? "" };
        },
      });
    };

    const exec = new WorkflowExecutor({ tracer });
    const out = await exec.run(WF, {}, dispatch, 0);
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.value, "SHORT SUMMARY");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test`
Expected: PASS. (If it fails, the most likely cause is `onLlm` not threaded through the sandbox — re-check Task 4.)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/workflow/llm-step.e2e.test.ts
git commit -m "test(workflow): e2e llm_generate step through mediated capability"
```

---

## Task 11: Seed the built-in at CLI startup

**Files:**
- Modify: `packages/cli/src/repl.ts`

- [ ] **Step 1: Implement**

In `packages/cli/src/repl.ts`, import `seedBuiltins` from `@meta-agent/core` (add to the existing core import) and call it immediately after the registry is opened, before the index is built (so the built-in is indexed):

```ts
  const registry = await FsToolRegistry.open(config.toolsDir);
  await seedBuiltins(registry);
  const index = await HybridToolIndex.open(registry);
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` (repo root)
Expected: PASS

- [ ] **Step 3: Manual smoke (optional)**

Run the CLI, then `/tools`. Expected: `llm_generate` appears in the catalog.

```bash
npm run cli
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/repl.ts
git commit -m "feat(cli): seed llm_generate built-in at startup"
```

---

## Task 12: Full verification pass

- [ ] **Step 1: Run the whole suite**

Run (repo root): `npm test`
Expected: all packages pass.

- [ ] **Step 2: Typecheck**

Run (repo root): `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Confirm the motivating scenario**

Re-derive the `summarize_paper` flow conceptually: a session that calls `fetch-webpage-text` → `llm_generate(instructions, input=@fetch)` → `write-file-text(content=@llm_generate)` now lifts to an IR where `content` is a `symref`, not a frozen literal. (No code here; this is the acceptance criterion from the spec §1.)

---

## Self-Review

**Spec coverage:**
- Spec §5.3 (mediated `llm` capability): Tasks 2–4.
- Spec §5.4 (`llm_generate` built-in): Task 5.
- Spec §5.5 (gating via `capabilities`, hash, approval, factory ban): Tasks 1, 4 (deny path), 5 (seed approval), 7 (factory ban).
- Spec §6 (lift/parameterize unchanged; validator addition; manifest type): Task 1 (type), Task 8 (validator). Lift/parameterize need no changes (verified by Task 10 using literals/symrefs through the unchanged executor).
- Spec §7.3 (taint seeding `sourceLabels`): Task 5 + assertion in Task 5 test.
- Spec open questions resolved by user: capabilities kept separate (Task 1), raw string when no `outputSchema` (Task 6 `resp.message.content ?? ""`), system-prompt nudge (Task 9).

**Placeholder scan:** Task 8's test references a `setupWithToolCapabilities` helper with an explicit implementer note to build it from the existing `validator.test.ts` registry patterns (the file's helpers are private to it, so the exact code must be derived in-file). All other steps contain complete code.

**Type consistency:** `LlmCapabilityRequest` defined in `stdio-protocol.ts` (Task 2), consumed in `interface.ts` (Task 4) and `agent-loop.ts` (Task 6). `onLlm: LlmHandler` consistent across `interface.ts`, `node-permission-sandbox.ts`, and the `dispatchTool` call site. `TOOL_CAPABILITY.llm` ("llm") consistent across types, builtins, agent-loop, and the catalog. `seedBuiltins` / `buildLlmGenerateTool` / `LLM_GENERATE_NAME` names consistent across builtins, index, CLI, and tests.

**Scope check:** Single subsystem (one capability + one built-in tool). No decomposition needed.
