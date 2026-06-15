import { test } from "node:test";
import assert from "node:assert/strict";
import { liftFromTrace } from "./lift.ts";
import { validate } from "./validator.ts";
import { WorkflowExecutor } from "./executor.ts";
import type { Tool } from "../types.ts";

function atomicTool(name: string): Tool {
  return {
    manifest: {
      name, description: "", rationale: "", inputSchema: {}, outputShape: {},
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [], limits: { timeoutMs: 1000, maxOldSpaceSizeMb: 64 },
      hash: "sha256:0", createdAt: "2026-01-01T00:00:00.000Z", kind: "atomic",
    },
    code: "",
  };
}

function registryOf(tools: Tool[]) {
  const byName = new Map(tools.map((t) => [t.manifest.name, t]));
  return { get: async (n: string) => byName.get(n) ?? null } as never;
}

const noopTracer = () => ({ log() {} }) as never;

test("e2e: fetch -> llm_generate($ref.text) -> write($ref) lifts, validates, executes", async () => {
  const fetchVal = { text: "LONG BODY", title: "T", url: "u" };
  const slice = [
    { name: "fetch_webpage_text", args: { url: "u" }, ok: true as const, value: fetchVal, binding: "r_0_fetch_webpage_text" },
    { name: "llm_generate", args: { instructions: "summarize", input: { $ref: "r_0_fetch_webpage_text", path: "text" } }, ok: true as const, value: "THE SUMMARY", binding: "r_1_llm_generate" },
    { name: "write_file_text", args: { path: "out.md", content: { $ref: "r_1_llm_generate" } }, ok: true as const, value: { written: true }, binding: "r_2_write_file_text" },
  ];
  const tools = [atomicTool("fetch_webpage_text"), atomicTool("llm_generate"), atomicTool("write_file_text")];
  const toolsByName = Object.fromEntries(tools.map((t) => [t.manifest.name, t]));

  const lifted = liftFromTrace({ slice, name: "summarize_online_paper", description: "d", goal: "g", toolsByName });
  assert.equal(lifted.ok, true);
  const wf = (lifted as { ok: true; workflow: import("./types.ts").Workflow }).workflow;
  assert.deepEqual(wf.steps[1]!.arguments.input, { kind: "symref", ref: "r_0_fetch_webpage_text", path: "text" });
  assert.deepEqual(wf.steps[2]!.arguments.content, { kind: "symref", ref: "r_1_llm_generate" });

  const valid = await validate(wf, registryOf(tools));
  assert.equal(valid.ok, true);

  const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = async (name: string, args: unknown) => {
    seen.push({ name, args: args as Record<string, unknown> });
    if (name === "fetch_webpage_text") return { ok: true as const, value: fetchVal };
    if (name === "llm_generate") return { ok: true as const, value: "THE SUMMARY" };
    return { ok: true as const, value: { written: true } };
  };
  const res = await new WorkflowExecutor({ tracer: noopTracer() }).run(wf, {}, dispatch, 0);
  assert.equal(res.ok, true);
  assert.deepEqual((res as { ok: true; value: unknown }).value, { written: true });
  assert.deepEqual(seen[1]!.args, { instructions: "summarize", input: "LONG BODY" });
  assert.deepEqual(seen[2]!.args, { path: "out.md", content: "THE SUMMARY" });
});
