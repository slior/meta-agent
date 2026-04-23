import {
  TRACE_KIND_EXECUTION_DENIED,
  TRACE_KIND_LLM_SYNTHESIS,
  TRACE_KIND_LLM_TURN,
  TRACE_KIND_TOOL_CALL,
  TRACE_KIND_TOOL_INVOKED,
  type TraceEvent,
} from "@meta-agent/core";

/**
 * Maps a TraceEvent to a short human-readable progress line for stderr output.
 * Returns null if the event should be silently skipped.
 */
export function formatTraceEvent(e: TraceEvent): string | null {
  switch (e.kind) {
    case TRACE_KIND_LLM_TURN: {
      const turn = e.data.turn as number;
      const usage = e.data.usage as { promptTokens?: number; completionTokens?: number } | null;
      const tokenInfo = usage
        ? ` (${usage.promptTokens ?? "?"} in / ${usage.completionTokens ?? "?"} out tokens)`
        : "";
      return `[meta-agent] LLM turn ${turn} complete${tokenInfo}`;
    }
    case TRACE_KIND_LLM_SYNTHESIS: {
      const usage = e.data.usage as { promptTokens?: number; completionTokens?: number } | null;
      const tokenInfo = usage
        ? ` (${usage.promptTokens ?? "?"} in / ${usage.completionTokens ?? "?"} out tokens)`
        : "";
      return `[meta-agent] Final answer synthesis complete${tokenInfo}`;
    }
    case TRACE_KIND_TOOL_CALL: {
      const name = String(e.data.name ?? "unknown");
      const ok = e.data.ok as boolean;
      let line = `[meta-agent] Tool call: ${name} → ${ok ? "ok" : "failed"}`;
      if (!ok) {
        const res = e.data.result as { ok?: boolean; error?: { kind?: string; message?: string } } | undefined;
        if (res && res.ok === false && res.error?.message) {
          const kind = res.error.kind ?? "error";
          line += ` — ${kind}: ${res.error.message}`;
        }
      }
      return line;
    }
    case TRACE_KIND_TOOL_INVOKED: {
      const name = String(e.data.name ?? "unknown");
      const ms = e.data.duration as number;
      const ok = e.data.ok as boolean;
      return `[meta-agent] Executed tool "${name}" in ${ms}ms — ${ok ? "success" : "failed"}`;
    }
    case TRACE_KIND_EXECUTION_DENIED: {
      const name = String(e.data.name ?? "unknown");
      const reason = String(e.data.reason ?? "");
      return `[meta-agent] Execution denied: "${name}"${reason ? ` — ${reason}` : ""}`;
    }
    case "tool-rejected": {
      const name = String(e.data.name ?? "unknown");
      const reason = String(e.data.reason ?? "");
      return `[meta-agent] Tool creation failed: "${name}"${reason ? ` — ${reason}` : ""}`;
    }
    case "tool-created": {
      const name = String(e.data.name ?? "unknown");
      return `[meta-agent] New tool created and saved: "${name}"`;
    }
    case "factory-gen-draft": {
      return `[meta-agent] Generating tool code…`;
    }
    default: {
      return `[meta-agent] ${e.kind}`;
    }
  }
}
