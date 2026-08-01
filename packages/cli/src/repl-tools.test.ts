import { test } from "node:test";
import assert from "node:assert/strict";
import { handleToolsCommand } from "./tools-table.ts";
import type { ToolRegistry } from "@meta-agent/core";
import { isCodeTool } from "@meta-agent/core";
import type { ApprovalRecord, Tool, ToolSummary } from "@meta-agent/core";
import { makeConsistentCodeTool } from "./testing/code-tool-fixture.ts";

const TOOL_CODE = "export async function run(){return {};}";

function mkTool(name: string, description: string): Tool {
  return makeConsistentCodeTool(
    {
      name,
      description,
      rationale: "",
      inputSchema: { type: "object", required: ["url"] },
      outputShape: { type: "string" },
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [],
      limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
      createdAt: "2026-04-21T00:00:00Z",
      kind: "atomic",
    },
    TOOL_CODE,
  );
}

class StubRegistry implements ToolRegistry {
  private tools: Tool[];

  constructor(tools: Tool[]) {
    this.tools = tools;
  }

  rootDir() {
    return "/tmp";
  }

  async list(): Promise<ToolSummary[]> {
    return this.listSync();
  }

  listSync(): ToolSummary[] {
    return this.tools.map((t) => ({
      name: t.manifest.name,
      description: t.manifest.description,
      hash: t.manifest.hash,
      kind: t.manifest.kind,
    }));
  }

  async getKind(name: string) {
    return this.tools.find((t) => t.manifest.name === name)?.manifest.kind ?? null;
  }

  async getManifest(name: string) {
    return this.tools.find((t) => t.manifest.name === name)?.manifest ?? null;
  }

  async getCode(name: string) {
    const t = this.tools.find((x) => x.manifest.name === name);
    return t && isCodeTool(t) ? t : null;
  }

  async getApproval(_name: string): Promise<ApprovalRecord | null> {
    return null;
  }

  async saveCode() {
    throw new Error("stub");
  }

  async saveWorkflow() {
    throw new Error("stub");
  }

  async delete() {
    throw new Error("stub");
  }

  async getDependents() {
    return [];
  }

  async has(n: string) {
    return this.tools.some((t) => t.manifest.name === n);
  }

  async getWorkflow() {
    return null;
  }

  integrityReport() {
    return [];
  }
}

test("handleToolsCommand('/tools') returns table without trailing blank line", async () => {
  const reg = new StubRegistry([mkTool("my-fetch-tool", "Fetches a URL and returns body as text.")]);
  const output = await handleToolsCommand(reg, "/tools");
  assert.ok(output.includes("my-fetch-tool"));
  assert.ok(!output.includes("Input schema:"));
  assert.ok(!output.endsWith("\n"));
  const lines = output.split("\n");
  assert.notEqual(lines.at(-1), "");
});

test("handleToolsCommand('/tools details') includes detail section", async () => {
  const reg = new StubRegistry([mkTool("my-fetch-tool", "Fetches a URL.")]);
  const output = await handleToolsCommand(reg, "/tools details");
  assert.ok(output.includes("Input schema:"));
  assert.ok(output.includes("-- my-fetch-tool --"));
});

test("handleToolsCommand('/tools foo') returns usage", async () => {
  const reg = new StubRegistry([]);
  const output = await handleToolsCommand(reg, "/tools foo");
  assert.equal(output, "Usage: /tools [details]");
});
