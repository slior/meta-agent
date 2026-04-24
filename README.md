# meta-agent

A local, TypeScript meta-agent that **creates, composes, and invokes its own tools on demand**. When the agent encounters a capability gap, it authors a new tool (as a small TypeScript file), runs it through static checks and a sandboxed smoke test, surfaces it for human approval, and persists it to a local registry for future reuse.

Every tool runs in a fresh Node subprocess with `--permission` flags derived from a declared manifest, so the agent can only touch the filesystem, network, or environment variables it has explicitly been granted access to. Human approval gates the creation of new tools and (by default) the first execution of anything with elevated permissions.

See [`docs/meta-tool-design.md`](docs/meta-tool-design.md) for the full design rationale and [`docs/v1-implementation-plan.md`](docs/v1-implementation-plan.md) for the task-by-task implementation history.

## Features

- **Dynamic tool creation** — agent proposes, LLM drafts, system validates → smoke-tests → human-approves → persists.
- **Local filesystem registry** — tools live under `./tools/<name>/{tool.ts, manifest.json, approval.json}`; no database required.
- **Hybrid tool discovery** — a compact catalog is always in the prompt; an explicit `find_tool` meta-tool performs BM25-lite ranking for larger registries.
- **Node `--permission` sandbox** — per-tool fs read/write, net allowlist, timeouts, output-byte caps, composite recursion depth cap.
- **Tiered human-in-the-loop approval** — low-risk tools run without friction; elevated-risk tools always prompt; `--yolo` to disable (not recommended).
- **Composition** — atomic tools can be chained into composite tools via an `invokeTool(name, args)` RPC; recursion runs in fresh sandboxed subprocesses.
- **OpenAI-compatible LLMs** — works with OpenAI, OpenAI-compatible gateways, and local runtimes (Ollama, vLLM, LM Studio) via `baseURL`.
- **JSONL tracing** — every LLM turn, tool call, and approval decision is appended to `./traces/<session>.jsonl`.

## Requirements

- **Node.js ≥ 22.7** (the sandbox and TypeScript source loading both rely on features in this range). A `.nvmrc` pins `22.22.2`.
- An OpenAI-compatible API endpoint + API key.

Why 22.7+: tools are TypeScript source loaded via Node's `--experimental-transform-types` (no transpile step), and the sandbox relies on the `--permission` flag and `--allow-fs-read` / `--allow-fs-write` controls.

## Installation

```bash
git clone <this-repo> meta-agent
cd meta-agent
nvm use            # picks up 22.22.2 from .nvmrc
npm install
```

Verify the setup:

```bash
npm run typecheck
npm test
```

You should see 64 passing tests in `@meta-agent/core` and 2 in `@meta-agent/cli`.

## Quickstart

1. **Copy the example config** to a path the CLI will read by default:

   ```bash
   mkdir -p config
   cp config/meta-agent.example.json config/meta-agent.json
   ```

2. **Provide your API key** (the env var name must match `llm.apiKeyEnv` in the config; the default is `OPENAI_API_KEY`). The CLI loads `.env` from the current working directory first, then `.env` next to the config file (`dirname` of the path passed to `-c`), without overriding variables already set in the shell. Alternatively:

   ```bash
   export OPENAI_API_KEY=sk-...
   ```

3. **Start the REPL:**

   ```bash
   npm run cli
   ```

4. **Try it:**

   ```
   > /tools
   []
   > count the number of lines in package.json
   ```

   On first request, the agent will find no matching tool, call `find_tool`, then `propose_new_tool`. You will be shown the proposed tool's code, permissions, smoke-test input/output, and asked to approve. After approval, the tool is saved under `./tools/` and invoked. Subsequent sessions will reuse it.

### REPL commands

- `/tools` — list everything in the registry.
- `/compose` — pick a contiguous slice of the session's successful tool calls and turn them into a reusable composite tool.
- `/exit` — quit. Traces are flushed to `./traces/<session>.jsonl`.

Anything else you type becomes a task for the agent.

### CLI flags

- `--config <path>` / `-c <path>` — path to the config JSON (default `./config/meta-agent.json`).
- `--yolo` — skip human approval for tool execution (creation always prompts). Use with care — tools can still only do what their manifest declares, but this removes the interactive gate.

## Configuration

The CLI reads a single JSON file (default `./config/meta-agent.json`, override with `--config`). All relative paths inside it are resolved against the **config file's directory**, not the CWD.

Example (from [`config/meta-agent.example.json`](config/meta-agent.example.json)):

```json
{
  "llm": {
    "baseURL": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "workspace": "./workspace",
  "toolsDir": "./tools",
  "tracesDir": "./traces",
  "yolo": false,
  "maxTurns": 20,
  "sandbox": {
    "maxDepth": 8,
    "maxOutputBytes": 1048576
  }
}
```

### LLM

- `llm.model` (**required**) — model name the provider expects, e.g. `gpt-4o-mini`, `gpt-4.1-mini`, `llama3.1:8b-instruct`, etc.
- `llm.apiKeyEnv` (**required**) — name of the environment variable that holds the API key. The CLI reads `process.env[<apiKeyEnv>]` after loading optional `.env` files (see Quickstart) and errors out if it is unset.
- `llm.baseURL` (optional) — OpenAI-compatible endpoint. Omit for `https://api.openai.com/v1`. Common alternatives:
  - OpenAI: leave unset or `https://api.openai.com/v1`
  - [Ollama](https://ollama.com/) locally: `http://localhost:11434/v1` (set `OPENAI_API_KEY=ollama` or anything non-empty)
  - [vLLM](https://github.com/vllm-project/vllm): `http://localhost:8000/v1`
  - OpenAI-compatible gateways: whatever the gateway publishes

### Paths

- `workspace` — the directory the sandbox grants read access to by default. Set this to the project you want the agent to operate on.
- `toolsDir` — where the registry persists generated tools.
- `tracesDir` — where session JSONL traces are written.

### Agent & sandbox

- `maxTurns` — soft cap on LLM turns per user request (default 20).
- `yolo` — if `true`, skip the human approval prompt on tool execution (tool creation still prompts). Can also be toggled per-invocation with `--yolo`.
- `sandbox.maxDepth` — maximum depth of composite `invokeTool` recursion (default 8).
- `sandbox.maxOutputBytes` — per-invocation stdout/stderr byte cap before the child is killed and the call fails with `output_truncated` (default 1 MiB).

### Tool-level permissions

Per-tool permissions are declared in each tool's `manifest.json` and authored by the LLM at creation time (then reviewed at the approval gate). They control what the sandbox grants to that specific tool: `fsRead`, `fsWrite`, `net` (`"none"` or `"allowlist"`) + `netAllowlist`, and `env` (environment variable names). These are not set in the CLI config — they're intrinsic to each tool and surfaced for review at the approval gate.

## Project layout

```
packages/core/   interfaces + implementations (registry, index, sandbox, approval, LLM, factory, agent loop)
packages/cli/    REPL, approval TUI, config loader, bin entry
config/          example config
docs/            design spec + implementation plan
```

## Development

```bash
npm run typecheck    # tsc -b across both packages
npm test             # all workspace tests
npm test -w @meta-agent/core
npm test -w @meta-agent/cli
```
