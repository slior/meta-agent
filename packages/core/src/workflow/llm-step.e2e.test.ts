import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowExecutor } from "./executor.ts";
import { Tracer } from "../tracer.ts";
import { NodePermissionSandbox } from "../sandbox/node-permission-sandbox.ts";
import { MockLLMProvider } from "../llm/mock-provider.ts";
import { buildLLMGenerateTool, LLM_GENERATE_NAME } from "../agent/builtins.ts";
import { CHAT_ROLE } from "../llm/LLMProvider.ts";
import { toolError } from "../errors.ts";
import type { Workflow } from "./types.ts";
import type { ToolResult } from "../types.ts";

const WF: Workflow = {
  schemaVersion: 1,
  name: "summarize-once",
  description: "",
  goal: "",
  inputs: [],
  steps: [
    {
      kind: "tool_call",
      label: "step_0_llm_generate",
      tool: LLM_GENERATE_NAME,
      arguments: {
        instructions: { kind: "literal", value: "Summarize the input." },
        input: { kind: "literal", value: "a long passage about RIG" },
      },
      resultBinding: "r_0_llm_generate",
    },
  ],
  return: { source: { kind: "symref", ref: "r_0_llm_generate" } },
};

test("workflow step produces a value through the mediated llm capability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llm-e2e-"));
  try {
    const tracer = await Tracer.open(join(dir, "traces"), "s");
    const mock = new MockLLMProvider().onChat((req) => {
      const user = req.messages.find((m) => m.role === CHAT_ROLE.user);
      assert.match((user as { content: string }).content, /Summarize the input/);
      return { message: { role: "assistant", content: "SHORT SUMMARY" } };
    });
    const sandbox = new NodePermissionSandbox({ workspace: dir });
    const tool = buildLLMGenerateTool();

    const dispatch = async (name: string, args: unknown): Promise<ToolResult> => {
      if (name !== LLM_GENERATE_NAME) return toolError("unknown_tool", name);
      return sandbox.execute(tool, args, {
        onLLM: async (cap) => {
          const resp = await mock.chat({
            messages: [{ role: CHAT_ROLE.user, content: `${cap.instructions}` }],
          });
          return { ok: true, value: resp.message.content ?? "" };
        },
      });
    };

    const exec = new WorkflowExecutor({ tracer });
    const out = await exec.run(WF, {}, dispatch, 0);
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.value, "SHORT SUMMARY");
    await tracer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
