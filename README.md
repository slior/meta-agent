# meta-agent

A local, TypeScript meta-agent that **creates, composes, and invokes its own tools on demand**. When the agent encounters a capability gap, it authors a new tool (as a small TypeScript file), runs it through static checks and a sandboxed smoke test, surfaces it for human approval, and persists it to a local registry for future reuse.

Every tool runs in a fresh Node subprocess with `--permission` flags derived from a declared manifest, so the agent can only touch the filesystem, network, or environment variables it has explicitly been granted access to. Human approval gates the creation of new tools and (by default) the first execution of anything with elevated permissions.

See [`docs/meta-tool-design.md`](docs/meta-tool-design.md) for the full design rationale, [`docs/tool-permissions.md`](docs/tool-permissions.md) for a detailed explanation of the tool permission and approval model (including `--yolo`).

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

- **Node.js ≥ 25.0** (required for the permission model’s `--allow-net` flag used by the sandbox, plus TypeScript-on-the-fly loading). A `.nvmrc` pins `25.0.0`.
- An OpenAI-compatible API endpoint + API key.

Why 25+: tools are TypeScript source loaded via Node's `--experimental-transform-types` (no transpile step), and the sandbox relies on `--permission` plus `--allow-fs-read` / `--allow-fs-write` and, for network tools, [`--allow-net`](https://nodejs.org/api/cli.html#allow-net) (available from Node 25.0.0 onward).

## Installation

```bash
git clone <this-repo> meta-agent
cd meta-agent
nvm use            # picks up 25.0.0 from .nvmrc
npm install
```

Verify the setup:

```bash
npm run typecheck
npm test
```

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
- `--debug` — enable low-level debug logging to **stderr** (raw OpenAI chat completion payloads today; may include prompts, tool arguments, and user content). Off by default.
- `--no-debug` — force debug off for this process (overrides `META_AGENT_DEBUG`). If both `--debug` and `--no-debug` are passed, `--debug` wins.

When neither flag is passed, debug follows **`META_AGENT_DEBUG`**: enabled only when set to `1`, `true`, or `yes` (case-insensitive). Any other value is treated as off. This variable is not read from the JSON config file.

**Security:** do not enable debug in shared logs or CI unless you accept leaking conversation content.

## Configuration

Full reference (every JSON field, CLI flags, environment variables, defaults, and how they interact): [`docs/configuration.md`](docs/configuration.md). Permission and approval model (gates, `yolo`, tool manifests): [`docs/tool-permissions.md`](docs/tool-permissions.md).

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
