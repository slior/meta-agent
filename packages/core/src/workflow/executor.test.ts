import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowExecutor } from "./executor.ts";
import { Tracer, TRACE_KIND_WORKFLOW_STEP_END, type TraceEvent } from "../tracer.ts";
import type { Workflow } from "./types.ts";
import type { ToolResult } from "../types.ts";

async function makeTracer(): Promise<{ tracer: Tracer; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "exec-"));
  const tracer = await Tracer.open(join(dir, "traces"), "s");
  return { tracer, dir };
}

const TWO_STEP: Workflow = {
  schemaVersion: 1,
  name: "two-step",
  description: "",
  goal: "",
  inputs: [],
  steps: [
    {
      kind: "tool_call",
      label: "first",
      tool: "produce",
      arguments: { x: { kind: "literal", value: 1 } },
      resultBinding: "a",
    },
    {
      kind: "tool_call",
      label: "second",
      tool: "consume",
      arguments: { y: { kind: "symref", ref: "a" } },
      resultBinding: "b",
    },
  ],
  return: { source: { kind: "symref", ref: "b" } },
};

test("executor: happy path; SymRef resolves to prior result", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const calls: Array<{ name: string; args: unknown }> = [];
    const dispatch = async (name: string, args: unknown): Promise<ToolResult> => {
      calls.push({ name, args });
      if (name === "produce") return { ok: true, value: { from: "produce" } };
      if (name === "consume") return { ok: true, value: { echoed: args } };
      return { ok: false, error: { kind: "unknown_tool", message: name } };
    };
    const exec = new WorkflowExecutor({ tracer });
    const out = await exec.run(TWO_STEP, {}, dispatch, 0);
    assert.equal(out.ok, true);
    if (out.ok) assert.deepEqual(out.value, { echoed: { y: { from: "produce" } } });
    assert.deepEqual(calls, [
      { name: "produce", args: { x: 1 } },
      { name: "consume", args: { y: { from: "produce" } } },
    ]);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor: fail-fast on step error", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const dispatch = async (): Promise<ToolResult> => ({
      ok: false,
      error: { kind: "runtime_error", message: "boom" },
    });
    const exec = new WorkflowExecutor({ tracer });
    const out = await exec.run(TWO_STEP, {}, dispatch, 0);
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.error.kind, "runtime_error");
      const details = out.error.details as { workflow: string; failedStep: string };
      assert.equal(details.workflow, "two-step");
      assert.equal(details.failedStep, "first");
    }
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor: null return yields {ok:true, value:null}", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const wf: Workflow = { ...TWO_STEP, return: null };
    const dispatch = async (): Promise<ToolResult> => ({ ok: true, value: 42 });
    const exec = new WorkflowExecutor({ tracer });
    const out = await exec.run(wf, {}, dispatch, 0);
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.value, null);
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor: runtime defense for unbound symref", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const wf: Workflow = {
      ...TWO_STEP,
      steps: [
        {
          kind: "tool_call",
          label: "first",
          tool: "consume",
          arguments: { y: { kind: "symref", ref: "ghost" } },
          resultBinding: "b",
        },
      ],
    };
    const dispatch = async (): Promise<ToolResult> => ({ ok: true, value: null });
    const exec = new WorkflowExecutor({ tracer });
    const out = await exec.run(wf, {}, dispatch, 0);
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.error.kind, "schema_violation");
      const details = out.error.details as { code?: string };
      assert.equal(details.code, "unbound_symref_runtime");
    }
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor: seeds required input from runtimeInputs", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const wf: Workflow = {
      schemaVersion: 1, name: "p", description: "", goal: "",
      inputs: [{ name: "url", schema: { type: "string" }, required: true }],
      steps: [{ kind: "tool_call", label: "s0", tool: "echo",
        arguments: { url: { kind: "symref", ref: "url" } }, resultBinding: "r0" }],
      return: { source: { kind: "symref", ref: "r0" } },
    };
    const dispatch = async (_n: string, args: unknown): Promise<ToolResult> => ({ ok: true, value: args });
    const exec = new WorkflowExecutor({ tracer });
    const res = await exec.run(wf, { url: "https://a" }, dispatch, 0);
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value, { url: "https://a" });
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor: optional input falls back to default when omitted", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const wf: Workflow = {
      schemaVersion: 1, name: "p", description: "", goal: "",
      inputs: [{ name: "path", schema: { type: "string" }, required: false, default: "./d.md" }],
      steps: [{ kind: "tool_call", label: "s0", tool: "echo",
        arguments: { path: { kind: "symref", ref: "path" } }, resultBinding: "r0" }],
      return: { source: { kind: "symref", ref: "r0" } },
    };
    const dispatch = async (_n: string, args: unknown): Promise<ToolResult> => ({ ok: true, value: args });
    const exec = new WorkflowExecutor({ tracer });
    const res = await exec.run(wf, {}, dispatch, 0);
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value, { path: "./d.md" });
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor: missing required input fails", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const wf: Workflow = {
      schemaVersion: 1, name: "p", description: "", goal: "",
      inputs: [{ name: "url", schema: { type: "string" }, required: true }],
      steps: [{ kind: "tool_call", label: "s0", tool: "echo",
        arguments: { url: { kind: "symref", ref: "url" } }, resultBinding: "r0" }],
      return: null,
    };
    const dispatch = async (): Promise<ToolResult> => ({ ok: true, value: null });
    const exec = new WorkflowExecutor({ tracer });
    const res = await exec.run(wf, {}, dispatch, 0);
    assert.equal(res.ok, false);
    if (!res.ok) {
      const details = res.error.details as { code?: string; workflow?: string; input?: string };
      assert.equal(details.code, "missing_required_input");
      assert.equal(details.workflow, "p");
      assert.equal(details.input, "url");
    }
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor: optional input uses supplied value when provided, not default", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const exec = new WorkflowExecutor({ tracer });
    const wf: Workflow = {
      schemaVersion: 1, name: "p", description: "", goal: "",
      inputs: [{ name: "path", schema: { type: "string" }, required: false, default: "./d.md" }],
      steps: [{ kind: "tool_call", label: "s0", tool: "echo",
        arguments: { path: { kind: "symref", ref: "path" } }, resultBinding: "r0" }],
      return: { source: { kind: "symref", ref: "r0" } },
    };
    const dispatch = async (_n: string, args: unknown) => ({ ok: true as const, value: args });
    const res = await exec.run(wf, { path: "/custom" }, dispatch, 0);
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value, { path: "/custom" });
  } finally {
    await tracer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor: failed step emits errorKind in TRACE_KIND_WORKFLOW_STEP_END", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exec-err-"));
  try {
    const events: TraceEvent[] = [];
    const tracer = await Tracer.open(join(dir, "traces"), "s", {
      observers: [(e) => events.push(e)],
    });

    const dispatch = async (): Promise<ToolResult> => ({
      ok: false,
      error: { kind: "runtime_error", message: "boom" },
    });
    const exec = new WorkflowExecutor({ tracer });
    await exec.run(TWO_STEP, {}, dispatch, 0);

    const stepEndEvent = events.find(
      (e) => e.kind === TRACE_KIND_WORKFLOW_STEP_END && e.data.ok === false,
    );
    assert.ok(stepEndEvent, "expected a failed workflow-step-end event");
    assert.equal(stepEndEvent.data.errorKind, "runtime_error");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executor resolves a symref with path projection", async () => {
  const { tracer, dir } = await makeTracer();
  try {
    const wf: Workflow = {
      schemaVersion: 1, name: "wf", description: "", goal: "", inputs: [],
      steps: [
        { kind: "tool_call", label: "s0", tool: "fetch", arguments: {}, resultBinding: "r_0_fetch" },
        { kind: "tool_call", label: "s1", tool: "echo", arguments: { input: { kind: "symref", ref: "r_0_fetch", path: "text" } }, resultBinding: "r_1_echo" },
      ],
      return: { source: { kind: "symref", ref: "r_1_echo" } },
    };
    const seen: Array<{ name: string; args: unknown }> = [];
    const dispatch = async (name: string, args: unknown): Promise<ToolResult> => {
      seen.push({ name, args });
      if (name === "fetch") return { ok: true, value: { text: "HELLO", title: "t" } };
      return { ok: true, value: (args as { input: unknown }).input };
    };
    const res = await new WorkflowExecutor({ tracer }).run(wf, {}, dispatch, 0);
    assert.equal(res.ok, true);
    assert.equal((res as { ok: true; value: unknown }).value, "HELLO");
    assert.deepEqual(seen[1]!.args, { input: "HELLO" });
  } finally {
    await tracer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
