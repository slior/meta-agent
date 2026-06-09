import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatToolsCatalog,
  isToolsCommand,
  parseToolsCommand,
  renderTerminalTable,
  summarizeJsonSchema,
  truncate,
} from "./tools-table.ts";
import type { ToolRegistry } from "@meta-agent/core";
import type { ApprovalRecord, Tool, ToolSummary } from "@meta-agent/core";

function mkTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown> = { type: "object" },
  outputShape: Record<string, unknown> = { type: "object" },
): Tool {
  return {
    code: "",
    manifest: {
      name,
      description,
      rationale: "",
      inputSchema,
      outputShape,
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [],
      limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
      hash: "sha256:" + "a".repeat(64),
      createdAt: "2026-04-21T00:00:00Z",
      kind: "atomic",
    },
  };
}

class StubRegistry implements ToolRegistry {
  private tools: Tool[];
  private approvals: Map<string, ApprovalRecord>;

  constructor(tools: Tool[], approvals: Map<string, ApprovalRecord> = new Map()) {
    this.tools = tools;
    this.approvals = approvals;
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

  async get(name: string) {
    return this.tools.find((t) => t.manifest.name === name) ?? null;
  }

  async getApproval(name: string): Promise<ApprovalRecord | null> {
    return this.approvals.get(name) ?? null;
  }

  async save() {
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
}

// --- parsing ---

test("isToolsCommand('/tools')", () => {
  assert.equal(isToolsCommand("/tools"), true);
});

test("isToolsCommand('/tools details')", () => {
  assert.equal(isToolsCommand("/tools details"), true);
});

test("isToolsCommand('/toolsfoo')", () => {
  assert.equal(isToolsCommand("/toolsfoo"), false);
});

test("isToolsCommand('/tools-json')", () => {
  assert.equal(isToolsCommand("/tools-json"), false);
});

test("parseToolsCommand('/tools')", () => {
  assert.deepEqual(parseToolsCommand("/tools"), { ok: true, details: false });
});

test("parseToolsCommand('/tools details')", () => {
  assert.deepEqual(parseToolsCommand("/tools details"), { ok: true, details: true });
});

test("parseToolsCommand('/tools  details')", () => {
  assert.deepEqual(parseToolsCommand("/tools  details"), { ok: true, details: true });
});

test("parseToolsCommand('/tools foo')", () => {
  const result = parseToolsCommand("/tools foo");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.usage, "Usage: /tools [details]");
    assert.ok(!result.usage.endsWith("\n"));
  }
});

// --- formatter ---

test("empty registry", async () => {
  const reg = new StubRegistry([]);
  const out = await formatToolsCatalog(reg);
  assert.equal(out, "No tools registered.");
  assert.ok(!out.endsWith("\n"));
});

test("empty registry with details", async () => {
  const reg = new StubRegistry([]);
  const out = await formatToolsCatalog(reg, { details: true });
  assert.equal(out, "No tools registered.");
});

test("default output has table headers but no Input schema", async () => {
  const reg = new StubRegistry([mkTool("alpha", "Short desc")]);
  const out = await formatToolsCatalog(reg);
  assert.match(out, /Name\s+Built-in\s+Description/);
  assert.ok(!out.includes("Input schema:"));
});

test("details output has table and schema blocks", async () => {
  const reg = new StubRegistry([mkTool("alpha", "Short desc", { type: "object", required: ["url"] }, {})]);
  const out = await formatToolsCatalog(reg, { details: true });
  assert.match(out, /Name\s+Built-in/);
  assert.match(out, /-- alpha --/);
  assert.match(out, /Input schema:/);
  assert.match(out, /Output schema:/);
  assert.match(out, /"type": "object"/);
});

test("truncated description shows Description line in details", async () => {
  const longDesc = "A".repeat(60);
  const reg = new StubRegistry([mkTool("long-desc-tool", longDesc)]);
  const out = await formatToolsCatalog(reg, { details: true });
  assert.match(out, /-- long-desc-tool --/);
  assert.match(out, new RegExp(`Description: ${longDesc}`));
  assert.ok(!out.match(/-- long-desc-tool --.*Description:/));
});

test("short description omits Description line in details", async () => {
  const reg = new StubRegistry([mkTool("short-tool", "Brief.")]);
  const out = await formatToolsCatalog(reg, { details: true });
  assert.match(out, /-- short-tool --/);
  assert.ok(!out.includes("Description:"));
});

test("built-in vs user tool", async () => {
  const approvals = new Map<string, ApprovalRecord>([
    [
      "builtin-tool",
      {
        hash: "sha256:" + "a".repeat(64),
        approvedAt: "1970-01-01T00:00:00.000Z",
        approvedBy: "builtin",
        alwaysApprove: true,
      },
    ],
  ]);
  const reg = new StubRegistry(
    [mkTool("builtin-tool", "Built-in tool"), mkTool("user-tool", "User tool")],
    approvals,
  );
  const out = await formatToolsCatalog(reg);
  const builtinLine = out.split("\n").find((l) => l.startsWith("builtin-tool"));
  const userLine = out.split("\n").find((l) => l.startsWith("user-tool"));
  assert.ok(builtinLine?.includes("yes"));
  assert.ok(userLine?.includes("no"));
});

test("schema summaries show required and any", async () => {
  const reg = new StubRegistry([
    mkTool("fetch", "Fetches URL", { type: "object", required: ["url"] }, {}),
  ]);
  const out = await formatToolsCatalog(reg);
  assert.match(out, /required: url/);
  assert.match(out, /\bany\b/);
});

test("alphabetical sort", async () => {
  const reg = new StubRegistry([
    mkTool("zebra", "Z tool"),
    mkTool("alpha", "A tool"),
  ]);
  const out = await formatToolsCatalog(reg);
  const alphaIdx = out.indexOf("alpha");
  const zebraIdx = out.indexOf("zebra");
  assert.ok(alphaIdx < zebraIdx);
});

test("column alignment with long description", () => {
  const longDesc = "X".repeat(100);
  const table = renderTerminalTable(
    ["Name", "Built-in", "Description", "Input summary", "Output summary"],
    [
      ["tool-one", "no", longDesc, "object", "any"],
      ["tool-two", "yes", "Short", "string", "object"],
    ],
  );
  const lines = table.split("\n");
  const row1 = lines[2]!;
  const row2 = lines[3]!;
  assert.equal(row1.length, row2.length);
  const descCell = truncate(longDesc, 50);
  assert.equal(descCell.length, 50);
  assert.ok(descCell.endsWith("..."));
  assert.ok(row1.includes(descCell));
});

test("truncate uses ASCII ellipsis", () => {
  assert.equal(truncate("hello world", 8), "hello...");
  assert.ok(!truncate("hello world", 8).includes("\u2026"));
});

test("summarizeJsonSchema empty object", () => {
  assert.equal(summarizeJsonSchema({}), "any");
});

test("summarizeJsonSchema with required", () => {
  assert.equal(
    summarizeJsonSchema({ type: "object", required: ["instructions", "url"] }),
    "object (required: instructions, url)",
  );
});

test("renderTerminalTable uses ASCII hyphen separator", () => {
  const table = renderTerminalTable(["A", "B"], [["1", "2"]]);
  assert.ok(table.includes("-".repeat(10)));
  assert.ok(!table.includes("\u2500"));
});
