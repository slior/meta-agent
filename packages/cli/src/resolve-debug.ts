import util from "node:util";
import type { DebugEvent, DebugSink } from "@meta-agent/core";

/** Values subset from `parseArgs` for `--debug` / `--no-debug`. */
export type DebugCliValues = {
  debug?: boolean;
  "no-debug"?: boolean;
};

/**
 * Resolves whether project debug mode is on.
 * If either CLI flag is present, CLI wins: `--debug` forces on; `--no-debug` forces off when `--debug` was not passed.
 * Otherwise uses `META_AGENT_DEBUG` (truthy: 1, true, yes — case-insensitive).
 */
export function resolveDebugEnabled(values: DebugCliValues, metaAgentDebug: string | undefined): boolean {
  if (values.debug === true) return true;
  if (values["no-debug"] === true) return false;
  return envDebugTruthy(metaAgentDebug);
}

function envDebugTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Writes one stderr line per event: JSON payload when possible, else bounded `util.inspect`. */
export function createStderrDebugSink(): DebugSink {
  return (event: DebugEvent) => {
    let payload: string;
    try {
      payload = JSON.stringify(event.data);
    } catch {
      payload = util.inspect(event.data, { depth: 6, maxArrayLength: 100, breakLength: 120 });
    }
    process.stderr.write(`[meta-agent:debug] ${event.kind} ${payload}\n`);
  };
}
