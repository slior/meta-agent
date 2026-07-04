# Configuration

The meta-agent CLI reads a single **JSON** configuration file. By default it looks for `./config/meta-agent.json`. Pass a different path with `--config <path>` or `-c <path>`.

## How paths and environment work

**Config file location**

- The path you pass to `--config` (or the default) is resolved from the **current working directory** (the directory you run the command from).

**Relative paths inside the JSON**

- Every relative path in the config file (`workspace`, `toolsDir`, `tracesDir`) is resolved against the **directory that contains the config file**, not the current working directory.
- If you run the CLI from another folder but point at the same config, those paths still refer to locations next to (or under) the config file.

**Environment files**

- The CLI loads `.env` from the **current working directory** first.
- It then loads `.env` from the **same directory as the config file** (the `dirname` of the path passed to `-c`).
- Variables already set in your shell are **not** overwritten by either file.

**API key**

- The key is read from `process.env[<llm.apiKeyEnv>]` after the `.env` files are applied. If that variable is missing, the CLI exits with an error.

## What is in the file vs what is not

| Source | Purpose |
|--------|---------|
| **JSON config** | LLM endpoint, model, paths, `yolo`, `maxTurns`, sandbox limits. |
| **CLI flags** | Config file path, `yolo` override, debug on/off (see below). |
| **Environment** | API key (name comes from config), `META_AGENT_DEBUG`, optional `META_AGENT_SANDBOX_DEBUG`. |

**Debug mode** is not stored in the JSON file. It is controlled only by `--debug`, `--no-debug`, and `META_AGENT_DEBUG` (see [CLI and debug](#cli-and-debug)).

The in-memory `Config` type may also set `debug` after load; that value never comes from parsing the JSON.

## Top-level fields

### `$schema` (optional)

If present, points to a JSON Schema URL or path for editor validation and autocomplete. The CLI does not require it and does not validate the file against a schema at runtime. Other unknown top-level keys are ignored by the loader as long as the file is valid JSON.

### `llm` (object, required structure)

Connection settings for the OpenAI-compatible API.

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `model` | **Yes** | — | Model name as expected by the provider (for example `gpt-4o-mini`, `gpt-4.1-mini`, or a local model id). If missing, the CLI throws an error. |
| `apiKeyEnv` | **Yes** | — | Name of the environment variable that holds the API key. The CLI reads that variable and fails if it is unset or empty. |
| `baseURL` | No | (OpenAI default in the client) | Base URL for the API, including `/v1` if your stack uses that layout. Omit or set to `https://api.openai.com/v1` for OpenAI. For other hosts, set this to the root your OpenAI **client** expects. |

**`llm` interactions**

- `apiKeyEnv` only **names** the variable; the actual secret must be supplied via the shell or `.env`.
- `baseURL` and `model` are sent together to the OpenAI-compatible client. A wrong `baseURL` (missing segment, wrong port) will fail requests even if the key is valid.
- If you enable [project debug](#cli-and-debug), the provider may log request/response details to **stderr**; treat that as sensitive in shared environments.

### `workspace` (string)

Directory the agent treats as the **default filesystem context** for tools: the sandbox uses it, approval logic may use it, and the CLI **creates** it (and parents if needed) on startup if it does not exist.

Default: `"./workspace"` (relative to the config file directory).

### `toolsDir` (string)

Where the **tool registry** lives on disk (generated `tool.ts`, `manifest.json`, and related files). The CLI creates this directory on startup if missing.

Default: `"./tools"`.

### `tracesDir` (string)

Where **JSONL session traces** are written (one file per REPL session).

Default: `"./traces"`.

**Path trio**

- `workspace`, `toolsDir`, and `tracesDir` are independent. They can point to sibling folders or nested paths; the only shared rule is resolution relative to the **config file’s directory**.

### `yolo` (boolean)

When `true`, the tiered approval policy **skips interactive prompts for running tools** that would normally ask the user. **Creating** new tools always goes through the Gate 1 approval flow.

Default: `false`.

**`yolo` interactions**

- The CLI flag `--yolo` **forces** this to on for the process, even if the JSON has `"yolo": false`.
- There is no config-only way to force “more restrictive than the JSON” if the file says `yolo: true`—for that, edit the file or use a different config.

### `maxTurns` (number)

Soft cap on how many **LLM turns** the agent loop will take for a **single** user line in the REPL before it stops and returns a message that the cap was reached.

Default: `20` (same default as the agent loop in core when not overridden).

**Interactions**

- This limits **model rounds**, not tool subprocess count directly. A turn can include multiple tool calls depending on the model and batching.
- It is separate from `sandbox.maxDepth`, which limits **nested composite** `invokeTool` recursion inside tool execution.

### `sandbox` (object)

Runtime limits for the **Node permission sandbox** that runs each tool in a child process.

| Field | Default | Description |
|-------|---------|-------------|
| `maxDepth` | `8` | Maximum depth of **composite** tool recursion (`invokeTool` chains). Exceeding this fails that invocation with a depth error. |
| `maxOutputBytes` | `1048576` (1 MiB) | Maximum combined stdout/stderr size per tool run; if exceeded, the run is treated as failed (truncation). |

**`sandbox` interactions**

- `maxOutputBytes` applies per **child run**, not per REPL session or per LLM turn. Very chatty tools may need a higher value; raising it uses more memory for buffering.
- `maxDepth` only matters for **composite** tools that call other tools. Atomic tools with no `invokeTool` are unaffected by depth.
- The sandbox also receives `workspace` from the top-level key; that controls allowed filesystem scope together with each tool’s manifest (not the JSON config). See [Tool manifests vs CLI config](#tool-manifests-vs-cli-config).

## CLI and debug

These are **not** fields in the JSON file but they strongly affect behavior alongside the file.

| Flag / variable | Effect |
|-----------------|--------|
| `--config` / `-c` | Path to the JSON file (default `./config/meta-agent.json`). |
| `--yolo` | Sets `yolo` to on for this process (overrides `"yolo": false` in JSON). |
| `--debug` | Turns on project debug (stderr logging from the client and related wiring). If both `--debug` and `--no-debug` are passed, **`--debug` wins**. |
| `--no-debug` | Forces project debug off for this process, overriding `META_AGENT_DEBUG` when `--debug` was not passed. |
| `META_AGENT_DEBUG` | If neither `--debug` nor `--no-debug` is used, debug is on only when this is set to `1`, `true`, or `yes` (case-insensitive). Any other value is off. **Not** read from the JSON config. |

When project **debug** is enabled, the REPL also sets `META_AGENT_SANDBOX_DEBUG` to `1` **if it was not already set**, so child tool processes emit extra sandbox diagnostics on stderr. If you set `META_AGENT_SANDBOX_DEBUG` yourself in the environment, that value is left as-is. Sandbox debug lines are separate from the `[meta-agent:debug]` lines from the project debug sink.

**Security note:** debug output can include prompts, tool arguments, and other conversation content. Avoid enabling it in CI logs or shared terminals if that is a concern.

Further detail on permissions and approval (including `yolo` and gates) is in [`tool-permissions.md`](./tool-permissions.md).

## Tool manifests vs CLI config

Per-tool **permissions** (filesystem, network allowlists, environment variable names, timeouts, and so on) are declared in each tool’s `manifest.json` and are **not** duplicated in the main CLI config. The config sets **global** defaults (paths, model, sandbox caps, approval yolo), while each tool carries its own **least-privilege** description used when spawning the sandbox.

## Examples

### Minimal (defaults-friendly)

A small file with only what is strictly required, relying on defaults for paths and limits. Paths below are still relative to the **config file’s** directory.

```json
{
  "llm": {
    "model": "gpt-4o-mini",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

Ensure `OPENAI_API_KEY` is set (or in `.env`). The CLI will create `workspace`, `tools`, and `traces` next to the config file (with default names).

### Typical local project

Name the key variable explicitly and point `workspace` at the repo you are editing. Optional `baseURL` is omitted for OpenAI.

```json
{
  "llm": {
    "model": "gpt-4.1-mini",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "workspace": "./project",
  "toolsDir": "./.meta-agent/tools",
  "tracesDir": "./.meta-agent/traces",
  "yolo": false,
  "maxTurns": 20,
  "sandbox": {
    "maxDepth": 8,
    "maxOutputBytes": 1048576
  }
}
```

`./project` here means “a `project` directory beside `meta-agent.json`.”

### Local OpenAI-compatible server (Ollama example)

`baseURL` targets the local server; many setups still expect a non-empty `apiKey` variable—often a placeholder.

```json
{
  "llm": {
    "baseURL": "http://localhost:11434/v1",
    "model": "llama3.1:8b-instruct",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "workspace": "./workspace",
  "maxTurns": 30
}
```

Set `OPENAI_API_KEY` to any non-empty string if the server ignores it.

### Tighter recursion and larger tool output

Use this when composite tools are deep or single runs produce large logs.

```json
{
  "llm": {
    "model": "gpt-4o-mini",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "maxTurns": 40,
  "sandbox": {
    "maxDepth": 4,
    "maxOutputBytes": 5242880
  }
}
```

`maxDepth: 4` fails composite chains earlier than the default; `maxOutputBytes` allows up to 5 MiB per tool process.

### Advanced: separate disk layout and yolo in config

All paths are resolved from the config file location. `yolo` is on in the file; omit `--yolo` on the command line in this case.

```json
{
  "llm": {
    "baseURL": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKeyEnv": "PRODUCTION_OPENAI_KEY"
  },
  "workspace": "/data/projects/acme",
  "toolsDir": "/data/meta-agent/tools",
  "tracesDir": "/data/meta-agent/traces",
  "yolo": true,
  "maxTurns": 25,
  "sandbox": {
    "maxDepth": 10,
    "maxOutputBytes": 2097152
  }
}
```

Absolute paths are used as given. Point `apiKeyEnv` at a dedicated variable name in production. Remember that `yolo` reduces execution-time prompts; it does not remove creation-time review.

---

## Terminal colors (CLI progress and debug)

While the agent runs, the CLI prints **progress** lines to stderr (always on). With `--debug` or `META_AGENT_DEBUG=1`, **debug** blocks are also printed to stderr.

- Progress lines use colors when the terminal supports them: dim metadata (time, event kind, tool name) and colored status text.
- Tool approval prompts (Gate 1 and Gate 2/3) use dim labels and plain values; choice keys are color-coded: green `[a]` approve, cyan `[s]` session, red `[r]` reject (Gate 1 also has bold green `[A]` always-approve).
- Gate 2/3 approval shows **Arguments** and **Permissions** as indented key-value tables (not raw JSON). Gate 1 uses the same human-readable permissions table.
- Sandbox diagnostic lines (when `META_AGENT_SANDBOX_DEBUG` is enabled, e.g. via project `--debug`) use a magenta `SANDBOX` badge and cyan message; `key=value` details render as an indented Field/Value table. Free-text details (errors, long JSON) stay as indented plain text.
- Trace JSONL files are unaffected — they continue to store raw JSON for args, permissions, and events.
- Debug blocks use a distinct style: a `DEBUG` badge, indented payload, and a visible truncation note when the payload is large.
- Colors respect `NO_COLOR` and non-TTY stderr (via `picocolors`). Set `FORCE_COLOR=1` to force colors when needed.
- Progress timestamps come from trace events (`TraceEvent.ts`). Debug header timestamps are wall-clock capture time at print, not the underlying LLM event time.
- Full LLM payloads remain in trace files; stderr debug output may truncate large JSON.

---

For a full copy-paste template that includes optional `"$schema"`, see [`config/meta-agent.example.json`](../config/meta-agent.example.json).
