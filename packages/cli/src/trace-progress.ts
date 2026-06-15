import {
  TRACE_KIND_EXECUTION_DENIED,
  TRACE_KIND_FACTORY_GEN_DRAFT,
  TRACE_KIND_FACTORY_REPAIR_LLM,
  TRACE_KIND_LLM_CALL,
  TRACE_KIND_LLM_SYNTHESIS,
  TRACE_KIND_LLM_SYNTHESIS_START,
  TRACE_KIND_LLM_TURN,
  TRACE_KIND_LLM_TURN_START,
  TRACE_KIND_TOOL_CALL,
  TRACE_KIND_TOOL_CREATED,
  TRACE_KIND_TOOL_DISPATCH_START,
  TRACE_KIND_TOOL_INVOKED,
  TRACE_KIND_TOOL_REJECTED,
  type TraceEvent,
} from "@meta-agent/core";
import { formatShortTime } from "./terminal-theme.ts";

/** Terminal styling hint for a progress line body. */
export const PROGRESS_LINE_STATUS = {
  ok: "ok",
  fail: "fail",
  pending: "pending",
} as const;

export type ProgressLineStatus = (typeof PROGRESS_LINE_STATUS)[keyof typeof PROGRESS_LINE_STATUS];

const TRACE_FALLBACK_NAME = "unknown";
const TRACE_DEFAULT_BODY = "event";
const TOKEN_COUNT_UNKNOWN = "?";

/**
 * Decomposed fields for one stderr progress line (meta header + styled body).
 */
export type ProgressLineParts = {
  /** Short time derived from the trace event timestamp. */
  time: string;
  /** Trace kind slug shown in the dim meta column. */
  label: string;
  /** Optional secondary meta column (e.g. tool name, turn number). */
  detail?: string;
  /** Primary human-readable message. */
  body: string;
  /** Optional color hint for {@link writeProgressLine}. */
  status?: ProgressLineStatus;
};

type LlmUsage = { promptTokens?: number; completionTokens?: number } | null | undefined;

function tokenInfo(usage: LlmUsage): string {
  if (!usage) return "";
  return ` (${usage.promptTokens ?? TOKEN_COUNT_UNKNOWN} in / ${usage.completionTokens ?? TOKEN_COUNT_UNKNOWN} out tokens)`;
}

function traceName(data: Record<string, unknown>): string {
  return String(data.name ?? TRACE_FALLBACK_NAME);
}

/**
 * Maps a {@link TraceEvent} to styled progress-line parts for stderr output.
 *
 * @param e - Trace event from the session tracer observer.
 * @returns Parts consumed by {@link writeProgressLine}.
 */
export function formatTraceEventParts(e: TraceEvent): ProgressLineParts {
  const time = formatShortTime(e.ts);

  switch (e.kind) {
    case TRACE_KIND_LLM_TURN_START: {
      const turn = e.data.turn as number;
      return {
        time,
        label: TRACE_KIND_LLM_TURN_START,
        detail: String(turn),
        body: `LLM request (turn ${turn})…`,
        status: PROGRESS_LINE_STATUS.pending,
      };
    }
    case TRACE_KIND_LLM_SYNTHESIS_START: {
      return {
        time,
        label: TRACE_KIND_LLM_SYNTHESIS_START,
        body: "LLM: final answer…",
        status: PROGRESS_LINE_STATUS.pending,
      };
    }
    case TRACE_KIND_TOOL_DISPATCH_START: {
      const name = traceName(e.data);
      return {
        time,
        label: TRACE_KIND_TOOL_DISPATCH_START,
        detail: name,
        body: `Running "${name}"…`,
        status: PROGRESS_LINE_STATUS.pending,
      };
    }
    case TRACE_KIND_FACTORY_REPAIR_LLM: {
      return {
        time,
        label: TRACE_KIND_FACTORY_REPAIR_LLM,
        body: "Repairing tool draft…",
        status: PROGRESS_LINE_STATUS.pending,
      };
    }
    case TRACE_KIND_LLM_TURN: {
      const turn = e.data.turn as number;
      const usage = e.data.usage as LlmUsage;
      return {
        time,
        label: TRACE_KIND_LLM_TURN,
        detail: String(turn),
        body: `LLM turn ${turn} complete${tokenInfo(usage)}`,
      };
    }
    case TRACE_KIND_LLM_SYNTHESIS: {
      const usage = e.data.usage as LlmUsage;
      return {
        time,
        label: TRACE_KIND_LLM_SYNTHESIS,
        body: `Final answer synthesis complete${tokenInfo(usage)}`,
      };
    }
    case TRACE_KIND_TOOL_CALL: {
      const name = traceName(e.data);
      const ok = e.data.ok as boolean;
      let body = `Tool call: ${name} → ${ok ? "ok" : "failed"}`;
      if (!ok) {
        const res = e.data.result as { ok?: boolean; error?: { kind?: string; message?: string } } | undefined;
        if (res && res.ok === false && res.error?.message) {
          const errKind = res.error.kind ?? "error";
          body += ` — ${errKind}: ${res.error.message}`;
        }
      }
      return {
        time,
        label: TRACE_KIND_TOOL_CALL,
        detail: name,
        body,
        status: ok ? PROGRESS_LINE_STATUS.ok : PROGRESS_LINE_STATUS.fail,
      };
    }
    case TRACE_KIND_TOOL_INVOKED: {
      const name = traceName(e.data);
      const ms = e.data.duration as number;
      const ok = e.data.ok as boolean;
      return {
        time,
        label: TRACE_KIND_TOOL_INVOKED,
        detail: name,
        body: `Executed in ${ms}ms — ${ok ? "success" : "failed"}`,
        status: ok ? PROGRESS_LINE_STATUS.ok : PROGRESS_LINE_STATUS.fail,
      };
    }
    case TRACE_KIND_EXECUTION_DENIED: {
      const name = traceName(e.data);
      const reason = String(e.data.reason ?? "");
      return {
        time,
        label: TRACE_KIND_EXECUTION_DENIED,
        detail: name,
        body: `Execution denied: "${name}"${reason ? ` — ${reason}` : ""}`,
        status: PROGRESS_LINE_STATUS.fail,
      };
    }
    case TRACE_KIND_TOOL_REJECTED: {
      const name = traceName(e.data);
      const reason = String(e.data.reason ?? "");
      return {
        time,
        label: TRACE_KIND_TOOL_REJECTED,
        detail: name,
        body: `Tool creation failed: "${name}"${reason ? ` — ${reason}` : ""}`,
        status: PROGRESS_LINE_STATUS.fail,
      };
    }
    case TRACE_KIND_TOOL_CREATED: {
      const name = traceName(e.data);
      return {
        time,
        label: TRACE_KIND_TOOL_CREATED,
        detail: name,
        body: `New tool created and saved: "${name}"`,
        status: PROGRESS_LINE_STATUS.ok,
      };
    }
    case TRACE_KIND_FACTORY_GEN_DRAFT: {
      return {
        time,
        label: TRACE_KIND_FACTORY_GEN_DRAFT,
        body: "Generating tool code…",
        status: PROGRESS_LINE_STATUS.pending,
      };
    }
    case TRACE_KIND_LLM_CALL: {
      const phase = String(e.data.phase ?? TRACE_FALLBACK_NAME);
      const method = String(e.data.method ?? "chat");
      return {
        time,
        label: TRACE_KIND_LLM_CALL,
        detail: `${method} (${phase})`,
        body: `LLM ${method} (${phase}) recorded`,
      };
    }
    default: {
      return {
        time,
        label: e.kind,
        body: TRACE_DEFAULT_BODY,
      };
    }
  }
}
