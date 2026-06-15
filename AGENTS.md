# AGENTS.md

## Overview

`meta-agent` is a TypeScript monorepo for a local AI agent that creates, validates, composes, and invokes its own tools. When the agent lacks a capability, it can draft a TypeScript tool, statically validate it, run a sandboxed smoke test, ask for human approval, and persist it in a local registry for reuse.

The runtime is split into:

- [`packages/core/`](packages/core/): agent loop, tool factory, registry, search/index, sandbox, approval policy, workflow execution, LLM adapter, and tracing.
- [`packages/cli/`](packages/cli/): REPL, config loading, approval UI, trace progress rendering, and `/compose`.

Tools run in fresh Node subprocesses with Node permission flags derived from each tool manifest. The project is safety-first: permissions are deny-by-default, approvals are tiered, and traces are written as JSONL.

## Key Documentation

- [`docs/repo_structure.md`](docs/repo_structure.md): the best starting map for the codebase. It describes package boundaries, major modules, ownership rules, dependency direction, runtime data directories, config flow, and common development commands.
- [`docs/configuration.md`](docs/configuration.md): complete reference for the config file created from [`config/meta-agent.example.json`](config/meta-agent.example.json), CLI flags, environment loading, path resolution, sandbox limits, `yolo`, and debug behavior.
- [`docs/tool-permissions.md`](docs/tool-permissions.md): detailed explanation of tool manifests, sandbox capability enforcement, approval gates, risk tiers, YOLO mode, and practical permission examples.
- [`docs/meta-tool-design.md`](docs/meta-tool-design.md): the original design spec for dynamic tool creation, registry/index abstractions, sandboxing, approvals, composition, tracing, and planned extension points.

Prefer linking to these docs instead of duplicating long explanations in new files.

## Runtime And Dependencies

- Use Node.js `>=25.0.0`; [`.nvmrc`](.nvmrc) currently pins Node `25`.
- Use npm workspaces; install dependencies with `npm install` from the repo root.
- Major runtime dependencies are `openai`, `ajv`, `ajv-formats`, `dotenv`, and `picocolors`.
- TypeScript runs directly through Node with `--experimental-transform-types`; there is no emitted JavaScript build artifact.
- The CLI needs an OpenAI-compatible Chat Completions endpoint and an API key env var matching `llm.apiKeyEnv` in the config, usually `OPENAI_API_KEY`.

## Commands

Run from the repo root:

```bash
nvm use
npm install
npm run typecheck
npm test
```

Important scripts:

- `npm run typecheck`: TypeScript project check for [`packages/core`](packages/core/) and [`packages/cli`](packages/cli/). This is the repo's build-equivalent check because [`tsconfig.base.json`](tsconfig.base.json) sets `noEmit`.
- `npm test`: all workspace tests.
- `npm test -w @meta-agent/core`: core package tests.
- `npm test -w @meta-agent/cli`: CLI package tests.
- `npm run cli`: start the local REPL.

## End-To-End And Smoke Testing

Targeted e2e commands:

```bash
npm run test:e2e -w @meta-agent/core
node --test --experimental-transform-types --no-warnings packages/core/src/e2e.test.ts packages/core/src/workflow/*.e2e.test.ts packages/core/src/workflow/e2e-lift.test.ts
```

Manual CLI smoke test:

```bash
cp config/meta-agent.example.json config/meta-agent.json
export OPENAI_API_KEY=sk-...
npm run cli
```

In the REPL, run `/tools`, then try a small task such as `count the number of lines in package.json` against [`package.json`](package.json). The expected flow is tool discovery, optional new tool proposal, static validation, sandbox smoke test, human approval, tool invocation, and trace output under the configured `tracesDir`.

For a faster non-production smoke against a local OpenAI-compatible server, set `llm.baseURL` and `llm.model` in the config created from [`config/meta-agent.example.json`](config/meta-agent.example.json); if the server ignores keys, `OPENAI_API_KEY` still must be non-empty.

## Agent Workflow Notes

- Read [`docs/repo_structure.md`](docs/repo_structure.md) before broad changes; it is the canonical architecture map.
- Keep [`packages/core`](packages/core/) independent from [`packages/cli`](packages/cli/); CLI can import core, but core must not import CLI.
- Follow existing TypeScript style: strict types, small interfaces, explicit `ToolResult`-style failures, and minimal dependencies.
- When generating or cleaning up code, use [`.cursor/skills/code-cleanup/SKILL.md`](.cursor/skills/code-cleanup/SKILL.md) when relevant. It gives the repo-specific pass for constants, repeated unions, magic numbers, extracted helpers, and JSDoc on exported APIs.
- Keep generated tools and runtime test artifacts out of source changes unless the task explicitly asks for them. Default runtime directories are `workspace`, `tools`, and `traces` relative to the config file.
- Do not commit secrets, `.env` files, or real API keys. Config should name env vars, not contain secret values.

## Verification Before Finishing

For most code changes, run:

```bash
npm run typecheck
npm test
```

For focused edits, at minimum run the relevant package test plus `npm run typecheck`. For sandbox, approval, workflow, or agent-loop changes, prefer the full test suite and at least one targeted e2e or CLI smoke check.
