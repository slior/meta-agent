import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  AgentLoop, FsToolRegistry, HybridToolIndex, NodePermissionSandbox,
  OpenAIProvider, SANDBOX_DEBUG_ENV, TieredApprovalPolicy, ToolFactory, Tracer,
} from "@meta-agent/core";
import { createStderrDebugSink } from "./resolve-debug.ts";
import { mkdir } from "node:fs/promises";
import { CliApprovalPrompter } from "./approval-tui.ts";
import { runComposeInteraction, type InvocationRecord } from "./compose.ts";
import { formatTraceEvent } from "./trace-progress.ts";
import type { Config } from "./config.ts";

export async function runRepl(config: Config): Promise<void> {
  const apiKey = process.env[config.llm.apiKeyEnv];
  if (!apiKey) throw new Error(`API key env var ${config.llm.apiKeyEnv} is not set`);

  if (config.debug && process.env[SANDBOX_DEBUG_ENV] === undefined) {
    process.env[SANDBOX_DEBUG_ENV] = "1";
  }

  await mkdir(config.workspace, { recursive: true });
  await mkdir(config.toolsDir, { recursive: true });
  await mkdir(config.tracesDir, { recursive: true });

  const registry = await FsToolRegistry.open(config.toolsDir);
  const index = await HybridToolIndex.open(registry);
  const sandbox = new NodePermissionSandbox({
    workspace: config.workspace,
    maxDepth: config.sandbox.maxDepth,
    maxOutputBytes: config.sandbox.maxOutputBytes,
  });
  const rl = readline.createInterface({ input, output });
  const prompter = new CliApprovalPrompter(rl);
  const approval = new TieredApprovalPolicy(prompter, { workspace: config.workspace, yolo: config.yolo });
  const llm = new OpenAIProvider({
    apiKey,
    ...(config.llm.baseURL !== undefined ? { baseURL: config.llm.baseURL } : {}),
    model: config.llm.model,
    ...(config.debug ? { debug: createStderrDebugSink() } : {}),
  });

  const sessionId = Date.now().toString(36);
  const tracer = await Tracer.open(config.tracesDir, sessionId, {
    observers: [(e) => {
      const line = formatTraceEvent(e);
      if (line) process.stderr.write(line + "\n");
    }],
  });
  const invocations: InvocationRecord[] = [];

  const factory = new ToolFactory({
    llm, registry, sandbox, approval, tracer, tombstoned: new Set(),
  });
  const agent = new AgentLoop({
    llm, registry, index, sandbox, approval, factory, tracer,
    maxTurns: config.maxTurns,
    onToolInvoked: (ev) => invocations.push({ name: ev.name, args: ev.args, ok: ev.ok }),
  });

  console.log("meta-agent REPL. Commands: /compose, /tools, /exit. Any other line = task for the agent.\n");
  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) continue;
      if (line === "/exit") break;
      if (line === "/tools") { console.log(JSON.stringify(registry.listSync(), null, 2)); continue; }
      if (line === "/compose") { await runComposeInteraction(factory, invocations, rl); continue; }
      const out = await agent.run(line);
      console.log(out);
    }
  } finally {
    rl.close();
    await tracer.close();
  }
}
