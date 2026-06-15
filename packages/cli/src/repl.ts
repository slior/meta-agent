import { mkdir } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import {
  AgentLoop,
  FsToolRegistry,
  HybridToolIndex,
  NodePermissionSandbox,
  OpenAIProvider,
  SANDBOX_DEBUG_ENV,
  seedBuiltins,
  setSandboxDebugSink,
  TieredApprovalPolicy,
  ToolFactory,
  Tracer,
  TracingLLMProvider,
} from "@meta-agent/core";
import type { ReadlinePromisesInterface } from "./approval-tui.ts";
import { CliApprovalPrompter } from "./approval-tui.ts";
import { runComposeInteraction, type InvocationRecord } from "./compose.ts";
import type { Config } from "./config.ts";
import { createStderrDebugSink } from "./resolve-debug.ts";
import { writeSandboxLogLine } from "./sandbox-log-format.ts";
import { formatTraceEventParts } from "./trace-progress.ts";
import { writeProgressLine } from "./terminal-write.ts";
import { handleToolsCommand, isToolsCommand } from "./tools-table.ts";

/** Slash commands handled in the interactive REPL loop. */
const REPL_COMMAND = {
  compose: "/compose",
  exit: "/exit",
} as const;

/** Outcome of handling one REPL input line (loop control, not a user command). */
const REPL_LINE_OUTCOME = {
  continue: "continue",
  exit: "exit",
} as const;

type ReplLineOutcome = (typeof REPL_LINE_OUTCOME)[keyof typeof REPL_LINE_OUTCOME];

const REPL_PROMPT = "> ";

/** Radix for `Date.now()` when generating the trace session id. */
const SESSION_ID_RADIX = 36;

/** Value written to {@link SANDBOX_DEBUG_ENV} when CLI debug mode enables sandbox logging. */
const SANDBOX_DEBUG_ENABLED = "1";

type ReplSession = {
  rl: ReadlinePromisesInterface;
  agent: AgentLoop;
  factory: ToolFactory;
  invocations: InvocationRecord[];
  registry: FsToolRegistry;
  tracer: Tracer;
};

type ToolInvokedCapture = {
  name: string;
  args: unknown;
  ok: boolean;
  value?: unknown;
  binding?: string;
};

function replWelcomeBanner(): string {
  return (
    `meta-agent REPL. Commands: ${REPL_COMMAND.compose}, /tools [details], ${REPL_COMMAND.exit}. ` +
    "Any other line = task for the agent.\n"
  );
}

function registerSandboxLogSink(): void {
  setSandboxDebugSink((message, detail, opts) => writeSandboxLogLine(message, detail, opts));
}

function enableSandboxDebugWhenNeeded(config: Config): void {
  if (config.debug && process.env[SANDBOX_DEBUG_ENV] === undefined) {
    process.env[SANDBOX_DEBUG_ENV] = SANDBOX_DEBUG_ENABLED;
  }
}

async function ensureReplDirectories(config: Config): Promise<void> {
  await mkdir(config.workspace, { recursive: true });
  await mkdir(config.toolsDir, { recursive: true });
  await mkdir(config.tracesDir, { recursive: true });
}

function recordInvocation(invocations: InvocationRecord[], ev: ToolInvokedCapture): void {
  invocations.push({
    name: ev.name,
    args: ev.args,
    ok: ev.ok,
    value: ev.value,
    ...(ev.binding !== undefined ? { binding: ev.binding } : {}),
  });
}

async function createReplSession(config: Config, apiKey: string): Promise<ReplSession> {
  const registry = await FsToolRegistry.open(config.toolsDir);
  await seedBuiltins(registry);
  const index = await HybridToolIndex.open(registry);
  const sandbox = new NodePermissionSandbox({
    workspace: config.workspace,
    maxDepth: config.sandbox.maxDepth,
    maxOutputBytes: config.sandbox.maxOutputBytes,
  });
  const rl = readline.createInterface({ input, output });
  const prompter = new CliApprovalPrompter(rl);
  const approval = new TieredApprovalPolicy(prompter, { workspace: config.workspace, yolo: config.yolo });

  const sessionId = Date.now().toString(SESSION_ID_RADIX);
  const tracer = await Tracer.open(config.tracesDir, sessionId, {
    observers: [(e) => writeProgressLine(formatTraceEventParts(e))],
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

  const invocations: InvocationRecord[] = [];
  const factory = new ToolFactory({
    llm,
    registry,
    sandbox,
    approval,
    tracer,
    tombstoned: new Set(),
  });
  const agent = new AgentLoop({
    llm,
    registry,
    index,
    sandbox,
    approval,
    factory,
    tracer,
    maxTurns: config.maxTurns,
    onToolInvoked: (ev) => recordInvocation(invocations, ev),
  });

  return { rl, agent, factory, invocations, registry, tracer };
}

async function handleReplLine(line: string, session: ReplSession): Promise<ReplLineOutcome> {
  if (line === REPL_COMMAND.exit) return REPL_LINE_OUTCOME.exit;
  if (isToolsCommand(line)) {
    console.log(await handleToolsCommand(session.registry, line));
    return REPL_LINE_OUTCOME.continue;
  }
  if (line === REPL_COMMAND.compose) {
    await runComposeInteraction(session.factory, session.invocations, session.rl);
    return REPL_LINE_OUTCOME.continue;
  }
  const out = await session.agent.run(line);
  console.log(out);
  return REPL_LINE_OUTCOME.continue;
}

/**
 * Runs the interactive meta-agent REPL until the user exits.
 *
 * @param config - Loaded CLI configuration (paths, LLM, sandbox, approval mode).
 * @returns Resolves when the user runs `/exit` or EOF; closes readline and the tracer.
 */
export async function runRepl(config: Config): Promise<void> {
  const apiKey = process.env[config.llm.apiKeyEnv];
  if (!apiKey) throw new Error(`API key env var ${config.llm.apiKeyEnv} is not set`);

  registerSandboxLogSink();
  enableSandboxDebugWhenNeeded(config);
  await ensureReplDirectories(config);

  const session = await createReplSession(config, apiKey);
  console.log(replWelcomeBanner());

  try {
    while (true) {
      const line = (await session.rl.question(REPL_PROMPT)).trim();
      if (!line) continue;
      if ((await handleReplLine(line, session)) === REPL_LINE_OUTCOME.exit) break;
    }
  } finally {
    session.rl.close();
    await session.tracer.close();
  }
}
