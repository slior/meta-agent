import type { DebugEvent, DebugSink } from "@meta-agent/core";
import { writeDebugEvent } from "./terminal-write.ts";

/** Env values treated as debug-on for {@link resolveDebugEnabled}. */
const ENV_DEBUG_TRUTHY = {
  one: "1",
  true: "true",
  yes: "yes",
} as const;

/**
 * Values subset from `parseArgs` for `--debug` / `--no-debug`.
 */
export type DebugCliValues = {
  debug?: boolean;
  "no-debug"?: boolean;
};

/**
 * Resolves whether project debug mode is on.
 * If either CLI flag is present, CLI wins: `--debug` forces on; `--no-debug` forces off when `--debug` was not passed.
 * Otherwise uses `META_AGENT_DEBUG` (truthy: 1, true, yes — case-insensitive).
 *
 * @param values - Parsed CLI flag values.
 * @param metaAgentDebug - Raw `META_AGENT_DEBUG` env string, if set.
 * @returns Whether structured LLM debug output should be enabled.
 */
export function resolveDebugEnabled(values: DebugCliValues, metaAgentDebug: string | undefined): boolean {
  if (values.debug === true) return true;
  if (values["no-debug"] === true) return false;
  return envDebugTruthy(metaAgentDebug);
}

function envDebugTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === ENV_DEBUG_TRUTHY.one || v === ENV_DEBUG_TRUTHY.true || v === ENV_DEBUG_TRUTHY.yes;
}

/**
 * Creates a {@link DebugSink} that writes structured debug blocks to stderr.
 *
 * @returns Sink forwarding events to {@link writeDebugEvent}.
 */
export function createStderrDebugSink(): DebugSink {
  return (event: DebugEvent) => {
    writeDebugEvent(event.kind, event.data, new Date().toISOString());
  };
}
