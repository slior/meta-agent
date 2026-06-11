import { test } from "node:test";
import assert from "node:assert/strict";
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
import { formatTraceEventParts, PROGRESS_LINE_STATUS } from "./trace-progress.ts";

const DEFAULT_TS = "2026-06-11T12:04:05.123Z";

function makeEvent(
  kind: string,
  data: Record<string, unknown> = {},
  ts = DEFAULT_TS,
): TraceEvent {
  return { ts, sessionId: "s", kind, data };
}

test("formatTraceEventParts: all cases use formatted time", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_LLM_TURN_START, { turn: 1 }));
  assert.equal(parts.time, "12:04:05");
});

test("formatTraceEventParts: LLM_TURN_START", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_LLM_TURN_START, { turn: 2 }));
  assert.equal(parts.label, "llm-turn-start");
  assert.equal(parts.detail, "2");
  assert.match(parts.body, /LLM request/);
  assert.match(parts.body, /…/);
  assert.equal(parts.status, PROGRESS_LINE_STATUS.pending);
});

test("formatTraceEventParts: LLM_SYNTHESIS_START", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_LLM_SYNTHESIS_START));
  assert.equal(parts.label, "llm-synthesis-start");
  assert.match(parts.body, /final answer/i);
  assert.equal(parts.status, PROGRESS_LINE_STATUS.pending);
});

test("formatTraceEventParts: TOOL_DISPATCH_START", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_TOOL_DISPATCH_START, { name: "read_file" }));
  assert.equal(parts.label, "tool-dispatch-start");
  assert.equal(parts.detail, "read_file");
  assert.match(parts.body, /Running/);
  assert.equal(parts.status, PROGRESS_LINE_STATUS.pending);
});

test("formatTraceEventParts: FACTORY_REPAIR_LLM", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_FACTORY_REPAIR_LLM));
  assert.equal(parts.label, "factory-repair-llm");
  assert.match(parts.body, /Repairing/);
  assert.equal(parts.status, PROGRESS_LINE_STATUS.pending);
});

test("formatTraceEventParts: LLM_TURN with tokens", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_LLM_TURN, {
    turn: 3,
    usage: { promptTokens: 100, completionTokens: 50 },
  }));
  assert.equal(parts.label, "llm-turn");
  assert.equal(parts.detail, "3");
  assert.match(parts.body, /100 in/);
  assert.match(parts.body, /50 out/);
  assert.equal(parts.status, undefined);
});

test("formatTraceEventParts: LLM_SYNTHESIS with tokens", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_LLM_SYNTHESIS, {
    usage: { promptTokens: 10, completionTokens: 20 },
  }));
  assert.equal(parts.label, "llm-synthesis");
  assert.match(parts.body, /10 in/);
  assert.match(parts.body, /20 out/);
});

test("formatTraceEventParts: TOOL_CALL ok", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_TOOL_CALL, { name: "read_file", ok: true }));
  assert.equal(parts.label, "tool-call");
  assert.equal(parts.detail, "read_file");
  assert.equal(parts.status, PROGRESS_LINE_STATUS.ok);
});

test("formatTraceEventParts: TOOL_CALL fail with error", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_TOOL_CALL, {
    name: "bad_tool",
    ok: false,
    result: { ok: false, error: { kind: "runtime_error", message: "boom" } },
  }));
  assert.equal(parts.status, PROGRESS_LINE_STATUS.fail);
  assert.match(parts.body, /runtime_error/);
  assert.match(parts.body, /boom/);
});

test("formatTraceEventParts: TOOL_INVOKED success", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_TOOL_INVOKED, { name: "read_file", duration: 42, ok: true }));
  assert.equal(parts.label, "tool-invoked");
  assert.equal(parts.detail, "read_file");
  assert.match(parts.body, /42ms/);
  assert.equal(parts.status, PROGRESS_LINE_STATUS.ok);
});

test("formatTraceEventParts: TOOL_INVOKED fail", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_TOOL_INVOKED, { name: "x", duration: 1, ok: false }));
  assert.equal(parts.status, PROGRESS_LINE_STATUS.fail);
});

test("formatTraceEventParts: EXECUTION_DENIED", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_EXECUTION_DENIED, { name: "rm", reason: "policy" }));
  assert.equal(parts.label, "execution-denied");
  assert.match(parts.body, /policy/);
  assert.equal(parts.status, PROGRESS_LINE_STATUS.fail);
});

test("formatTraceEventParts: tool-rejected", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_TOOL_REJECTED, { name: "bad", reason: "invalid" }));
  assert.equal(parts.label, TRACE_KIND_TOOL_REJECTED);
  assert.match(parts.body, /invalid/);
  assert.equal(parts.status, PROGRESS_LINE_STATUS.fail);
});

test("formatTraceEventParts: tool-created", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_TOOL_CREATED, { name: "new_tool" }));
  assert.equal(parts.label, TRACE_KIND_TOOL_CREATED);
  assert.equal(parts.detail, "new_tool");
  assert.match(parts.body, /saved/);
  assert.equal(parts.status, PROGRESS_LINE_STATUS.ok);
});

test("formatTraceEventParts: factory-gen-draft", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_FACTORY_GEN_DRAFT));
  assert.equal(parts.label, TRACE_KIND_FACTORY_GEN_DRAFT);
  assert.match(parts.body, /Generating/);
  assert.equal(parts.status, PROGRESS_LINE_STATUS.pending);
});

test("formatTraceEventParts: LLM_CALL", () => {
  const parts = formatTraceEventParts(makeEvent(TRACE_KIND_LLM_CALL, { phase: "orchestration", method: "chat" }));
  assert.equal(parts.label, "llm-call");
  assert.match(parts.detail ?? "", /chat/);
  assert.match(parts.detail ?? "", /orchestration/);
});

test("formatTraceEventParts: default unknown kind", () => {
  const parts = formatTraceEventParts(makeEvent("workflow-start", {}));
  assert.equal(parts.label, "workflow-start");
  assert.equal(parts.body, "event");
});
