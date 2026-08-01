import { test } from "node:test";
import assert from "node:assert/strict";
import { HybridToolIndex } from "./hybrid-index.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";
import type { ApprovalRecord, ToolSummary } from "../types.ts";
import { isCodeTool, type CodeTool, type Tool, type WorkflowTool } from "../tool.ts";
import { makeConsistentCodeTool } from "../testing/tool-fixtures.ts";

const TOOL_CODE = "export async function run(){return {};}";

function mkTool(name: string, description: string, rationale = ""): Tool {
  return makeConsistentCodeTool(
    {
      name, description, rationale,
      inputSchema: { type: "object" }, outputShape: { type: "object" },
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
      dependencies: [], limits: { timeoutMs: 30000, maxOldSpaceSizeMb: 256 },
      createdAt: "2026-04-21T00:00:00Z", kind: "atomic",
    },
    TOOL_CODE,
  );
}

class StubRegistry implements ToolRegistry {
  private tools: Tool[];
  constructor(tools: Tool[]) { this.tools = tools; }
  rootDir() { return "/tmp"; }
  async list(): Promise<ToolSummary[]> {
    return this.listSync();
  }
  listSync(): ToolSummary[] {
    return this.tools.map((t) => ({
      name: t.manifest.name, description: t.manifest.description,
      hash: t.manifest.hash, kind: t.manifest.kind,
    }));
  }
  async getKind(name: string) { return this.tools.find((t) => t.manifest.name === name)?.manifest.kind ?? null; }
  async getManifest(name: string) { return this.tools.find((t) => t.manifest.name === name)?.manifest ?? null; }
  async getCode(name: string): Promise<CodeTool | null> {
    const t = this.tools.find((x) => x.manifest.name === name);
    return t && isCodeTool(t) ? t : null;
  }
  async getWorkflow(): Promise<WorkflowTool | null> { return null; }
  async getApproval(_n: string): Promise<ApprovalRecord | null> { return null; }
  async saveCode() { throw new Error("stub"); }
  async saveWorkflow() { throw new Error("stub"); }
  async delete() { throw new Error("stub"); }
  async getDependents() { return []; }
  async has(n: string) { return this.tools.some((t) => t.manifest.name === n); }
  integrityReport() { return []; }
}

test("catalog returns name + short description", async () => {
  const reg = new StubRegistry([
    mkTool("web-fetch", "Fetches a URL and returns the body as text."),
    mkTool("csv-parse", "Parses CSV strings into row objects."),
  ]);
  const idx = await HybridToolIndex.open(reg);
  const cat = idx.catalog();
  assert.equal(cat.length, 2);
  assert.ok(cat.some((e) => e.name === "web-fetch" && e.shortDescription.includes("Fetches")));
});

test("find ranks by token overlap and exact name match", async () => {
  const reg = new StubRegistry([
    mkTool("csv-parse", "Parses CSV strings."),
    mkTool("web-fetch", "Fetches a URL."),
    mkTool("json-extract", "Extracts values from JSON via JSONPath."),
  ]);
  const idx = await HybridToolIndex.open(reg);
  const results = await idx.find("parse csv");
  assert.equal(results[0]!.name, "csv-parse");
  assert.ok(results[0]!.score > (results[1]?.score ?? 0));
});

test("find is case-insensitive and tokenizes kebab-case names", async () => {
  const reg = new StubRegistry([ mkTool("csv-parse", "ignored") ]);
  const idx = await HybridToolIndex.open(reg);
  const results = await idx.find("CSV");
  assert.equal(results[0]!.name, "csv-parse");
});

test("find respects k limit", async () => {
  const reg = new StubRegistry([
    mkTool("a", "foo bar"),
    mkTool("b", "foo bar baz"),
    mkTool("c", "foo bar baz qux"),
  ]);
  const idx = await HybridToolIndex.open(reg);
  assert.equal((await idx.find("foo", { k: 2 })).length, 2);
});

test("catalog maxEntries truncates", async () => {
  const reg = new StubRegistry(
    Array.from({ length: 50 }, (_, i) => mkTool(`t${i}`, `desc ${i}`))
  );
  const idx = await HybridToolIndex.open(reg);
  assert.equal(idx.catalog({ maxEntries: 10 }).length, 10);
});
