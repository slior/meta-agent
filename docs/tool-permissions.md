# Tool Permission Model

This document explains how tool permissions work in `meta-agent`, from first principles to real execution flows.

It covers:
- how permissions are defined when a tool is created
- how permissions are enforced when a tool is invoked
- how global approval policy interacts with per-tool permissions
- how configuration is set (manifest, config file, CLI flags)
- what the user sees in the CLI
- what changes in YOLO mode

## Table of Contents

- [High-level goal, principles, and rationale](#high-level-goal-principles-and-rationale)
- [Two permission axes (important mental model)](#two-permission-axes-important-mental-model)
- [Where permissions are set](#where-permissions-are-set)
- [Permission model during tool creation](#permission-model-during-tool-creation)
- [Permission model during tool invocation](#permission-model-during-tool-invocation)
- [What the user sees](#what-the-user-sees)
- [YOLO mode in detail](#yolo-mode-in-detail)
- [End-to-end flows (simple to advanced)](#end-to-end-flows-simple-to-advanced)
- [Practical configuration examples](#practical-configuration-examples)
- [Summary checklist](#summary-checklist)

---

## High-level goal, principles, and rationale

The permission model exists to balance two needs:
- **Power:** tools can do real work (read files, write files, call APIs, use env vars).
- **Safety:** each tool only gets explicit, minimal capabilities.

The design follows these principles:
- **Deny by default:** if a permission is not explicitly declared, it is not granted.
- **Per-tool capability boundaries:** each tool has its own permission manifest.
- **Runtime enforcement by sandbox:** permissions are enforced in a separate Node subprocess using `--permission` flags.
- **Human approval gates:** tool creation and/or execution may require user approval, depending on risk and mode.
- **Auditability:** approval decisions and tool manifests are persisted on disk and traced in JSONL logs.

The key idea: there are **two layers** that work together.

1. **Capability layer (manifest + sandbox):** what the tool is technically allowed to do.
2. **Approval layer (policy + prompts):** when the user must explicitly approve a creation or run.

These are related but different:
- A tool may be *capable* of network access (manifest says so), but still be blocked at runtime by approval prompts.
- In YOLO mode, Gate 2/3 execution prompts are bypassed; Gate 1 creation review still prompts. Capability boundaries still apply.

---

## Two permission axes (important mental model)

### A. Capability permissions (declared in each tool)

Each tool manifest includes:

```json
{
  "permissions": {
    "fsRead": [],
    "fsWrite": [],
    "net": "none",
    "netAllowlist": [],
    "env": []
  }
}
```

Meaning:
- `fsRead`: absolute paths this tool may read.
- `fsWrite`: absolute paths this tool may write.
- `net`: network mode:
  - `"none"`: no network permission granted.
  - `"allowlist"`: network enabled (`--allow-net`) and restricted by a host allowlist enforced over the
    global `fetch()`. Requires a non-empty `netAllowlist`.
- `netAllowlist`: allowed hostnames when `net = "allowlist"`. Must contain at least one host.

Network access is **fetch-only**: tools reach the network through the global `fetch()`. Direct HTTP client
modules (`node:http`, `node:https`, `undici`, `node:fetch`) are forbidden and rejected by static validation.
- `env`: env var names to expose to the child process.

### B. Approval permissions (policy decisions before execution)

Even if a tool has declared capabilities, execution can still be gated by:
- risk tier (low / medium / elevated)
- whether this tool/hash was already approved
- session cache
- `alwaysApprove` decision at Gate 1
- YOLO mode

---

## Where permissions are set

There are three configuration surfaces, each with a different purpose.

## 3.1 Tool manifest (per-tool, strongest for capability)

Set during tool creation (`ToolDraft.permissions`), then persisted to:
- `tools/<tool-name>/manifest.json`

This is where actual capability permissions live.

Important: these are **not** set in global CLI config. They are intrinsic to each tool.

## 3.2 Global config (`config/meta-agent.json`)

Global policy and runtime knobs:

```json
{
  "workspace": "./workspace",
  "yolo": false,
  "sandbox": {
    "maxDepth": 8,
    "maxOutputBytes": 1048576
  }
}
```

Relevant to permission behavior:
- `workspace`: used by risk-tier logic (`inside workspace` vs `outside workspace`) and always included in read allowlist.
- `yolo`: bypasses Gate 2/3 execution approval prompts (Gate 1 creation review always prompts).
- `sandbox.maxDepth`: composite recursion guard.
- `sandbox.maxOutputBytes`: output cap guard.

## 3.3 CLI flag override

CLI flag:
- `--yolo`

Behavior:
- if passed, it overrides config and sets `cfg.yolo = true` at startup.

---

## Permission model during tool creation

Creation path: `propose_new_tool` / `propose_composite_tool` -> factory -> validation -> smoke test -> Gate 1 -> save.

### 4.1 Draft stage

The factory asks the LLM for a `ToolDraft` containing:
- code
- input/output schemas
- permissions
- smoke test input

### 4.2 Normalization (defensive defaulting)

`normalizePermissions()` ensures malformed/missing fields become safe defaults:
- empty arrays for fs/env lists
- `net` defaults to `"none"`

So malformed drafts become more restrictive, not more permissive.

### 4.3 Static permission checks

Before any run, static validator enforces:
- permission block shape is valid
- imports match declared permissions:
  - filesystem modules require `fsRead` or `fsWrite`
  - network client modules (`node:http`, `node:https`, `undici`, `node:fetch`) are forbidden; use the global `fetch()`
- forbidden modules are blocked (`child_process`, `worker_threads`, `vm`, etc.)

### 4.4 Smoke test under declared permissions

The draft is run in sandbox **with its own declared permissions**.

This catches mismatch early:
- if code tries to do something undeclared, smoke test fails
- repair loop can fix code or permissions

### 4.5 Gate 1 approval

User sees and approves/rejects:
- name, description, rationale
- full schema
- full permissions block
- code
- smoke test input/output

Decision options:
- approve
- always approve
- reject

If approved, tool and approval are persisted:
- `tool.ts`
- `manifest.json`
- `approval.json`

---

## Permission model during tool invocation

Invocation path: lookup tool -> validate input schema -> approval policy -> sandbox execution.

### 5.1 Risk tier classification

`TieredApprovalPolicy.riskTier()` classifies tool permissions:

- **low**
  - no net
  - no writes
  - no env
  - reads only inside workspace
- **medium**
  - writes inside workspace and/or non-secret env reads
- **elevated**
  - any network
  - any fs path outside workspace (read or write)
  - env var names matching `TOKEN|KEY|SECRET|PASS`

### 5.2 Approval decision behavior (non-YOLO)

For execution:
- low: auto-approve
- if `approval.alwaysApprove = true`: auto-approve
- session-approved hash cached: auto-approve
- else: prompt Gate 2/3

If `approval.hash` does not match `manifest.hash`, it prompts again (drift protection).

### 5.3 Sandbox enforcement mapping

If approved, sandbox spawns child process with flags derived from manifest:

- base flags:
  - `--permission`
  - `--experimental-transform-types`
  - `--no-addons`
- fs read:
  - always includes workspace + runner/tool directories
  - plus `permissions.fsRead[]`
- fs write:
  - `permissions.fsWrite[]`
- net:
  - add `--allow-net` if `net !== "none"`
- env:
  - only whitelisted names copied from parent env
- limits:
  - `--max-old-space-size` from manifest limits
  - timeout and output caps enforced by parent

### 5.4 Network allowlist behavior

When `net = "allowlist"`:
- `netAllowlist` must be non-empty (enforced by static validation).
- child gets `--allow-net` (coarse enable).
- the runner installs a `fetch` host allowlist shim based on `netAllowlist`; `fetch` is the only network
  client available to tools (`node:http`/`node:https`/`undici`/`node:fetch` imports are rejected).
- the shim disables `WebSocket` and `EventSource`, so allowlist-mode network access is fetch-only.
- the shim checks `string`, `URL`, and `Request` inputs, and forces `redirect: "manual"` so a request cannot
  auto-follow a 3xx to an unchecked host — a tool must re-`fetch` the target, which is re-validated.
- a blocked host is returned to the agent as a `permission_denied` error.
- if allowlist mode is active but the list is empty, the shim blocks every request (fail closed).

Important nuance:
- the host allowlist is enforced at the app layer (the `fetch` shim), not the OS socket layer.
- it is meaningful and audited, but not equivalent to a kernel-level network jail; a socket-level jail is
  future hardening (see `meta-tool-design.md` §10).

### 5.5 Composite tools and permission isolation

Composites call `invokeTool(...)`.

Security invariant:
- each nested call re-enters full approval + sandbox flow
- no ambient permission inheritance from parent composite

So a composite cannot "lend" extra permissions to dependencies.

---

## What the user sees

## 6.1 Gate 1 (creation)

CLI prints a full review section:
- tool metadata
- input/output schema
- explicit permissions list
- full code block
- smoke test details

Then prompts:
- `[a]pprove`
- `[A]lways-approve`
- `[r]eject`

## 6.2 Gate 2/3 (execution)

CLI prints:
- tool name
- risk tier
- invocation args
- full permissions JSON

Then prompts:
- `[a]pprove-once`
- `[s]ession-approve`
- `[r]eject`

## 6.3 Progress and audit signals

User also sees progress lines (stderr), for example:
- tool call success/failure
- execution denied
- tool created / rejected

And persistent artifacts:
- `tools/<name>/approval.json` (who approved, hash, alwaysApprove)
- `traces/<session>.jsonl` (execution/denial events)

---

## YOLO mode in detail

YOLO can be enabled two ways:
- config: `"yolo": true`
- CLI: `--yolo` (overrides config for this run)

Implementation behavior:
- **Gate 1 reviewDraft:** always prompts — yolo does not skip Gate 1 creation review.
- **Gate 2/3 checkExecution:** auto-approve without prompts.

YOLO removes execution prompts (Gate 2/3); Gate 1 creation review is always interactive.

What YOLO **does not** bypass:
- Gate 1 creation review (always prompts)
- static draft validation
- schema validation at invocation time
- sandbox capability boundaries (manifest-derived flags still apply)
- runtime limits (timeout, output cap, recursion depth)

In short:
- normal mode  = **capability boundaries + Gate 1 review + Gate 2/3 execution prompts**
- YOLO mode    = **capability boundaries + Gate 1 review** (execution runs without Gate 2/3 prompts)

This is why YOLO speeds up the execution loop while preserving the human review of generated tool code.

---

## End-to-end flows (simple to advanced)

## Flow 1: low-risk read-only tool (simple baseline)

1. Tool created with:
   - `fsRead: ["/abs/workspace/path"]`
   - no write/net/env
2. Gate 1 approved once.
3. Runtime risk tier = low.
4. Invocations auto-approve and run without Gate 2 prompts.

Why: capability is narrow and non-destructive.

## Flow 2: workspace writer tool (medium risk)

Example manifest permissions:

```json
{
  "fsRead": ["/Users/liors/dev/meta-agent/workspace"],
  "fsWrite": ["/Users/liors/dev/meta-agent/workspace/out"],
  "net": "none",
  "netAllowlist": [],
  "env": []
}
```

Behavior:
1. First execution prompts Gate 2/3 (unless `alwaysApprove` exists).
2. User chooses session approve.
3. Same hash runs auto-approved for the rest of the session.

## Flow 3: network + API key tool (elevated risk)

Example:

```json
{
  "fsRead": [],
  "fsWrite": [],
  "net": "allowlist",
  "netAllowlist": ["api.openai.com"],
  "env": ["OPENAI_API_KEY"]
}
```

Behavior:
1. Elevated tier due to network and `KEY` env name.
2. Gate 2/3 prompt shown with args + permissions.
3. Unless prior `alwaysApprove`, prompts continue per policy.

## Flow 4: hash drift after code/manifest change

1. Tool was approved with hash `H1`.
2. Tool code or manifest changes -> hash becomes `H2`.
3. Runtime detects mismatch (`approval.hash !== manifest.hash`).
4. Execution prompts again (re-authorization for changed behavior).

This protects against silent drift.

## Flow 5: composite tool calls dependencies

1. Composite tool gets invoked.
2. Child requests `invokeTool("dep", args)`.
3. Parent re-enters dependency execution path:
   - schema validate
   - approval check
   - sandbox run with dependency's own permissions

Result: no permission laundering through composition.

## Flow 6: same elevated tool in YOLO mode

1. Start CLI with `--yolo`.
2. Tool creation: Gate 1 prompt shown as normal — yolo does not skip it.
3. Tool execution: no Gate 2/3 prompt.
4. Tool still constrained by manifest:
   - if host not in `netAllowlist`, fetch shim blocks
   - undeclared env vars are unavailable
   - undeclared fs paths denied by Node permission flags

---

## Practical configuration examples

## 9.1 Standard safe default

`config/meta-agent.json`:

```json
{
  "workspace": "./workspace",
  "toolsDir": "./tools",
  "tracesDir": "./traces",
  "yolo": false,
  "sandbox": { "maxDepth": 8, "maxOutputBytes": 1048576 }
}
```

Use this for normal operation with interactive approvals.

## 9.2 Temporary fast iteration (YOLO)

Command:

```bash
npm run cli -- --config ./config/meta-agent.json --yolo
```

Use only when you intentionally accept no approval prompts during that run.

## 9.3 Tool-level minimal permissions pattern

Prefer:
- narrow path lists in `fsRead`/`fsWrite`
- `net: "none"` unless required
- smallest possible `netAllowlist`
- exact env var names only when needed

This keeps both risk tier and blast radius low.

---

## Summary checklist

When reasoning about a tool execution, ask:
1. What does the manifest allow (capability layer)?
2. What does policy require right now (approval layer)?
3. Is hash unchanged from approval record?
4. Is this normal mode or YOLO mode?
5. For composites, are dependencies being checked independently?

If you can answer these five, you can predict permission behavior correctly.
