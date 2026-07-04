import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodePermissionSandbox } from "./node-permission-sandbox.ts";
import type { Tool } from "../types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

function mkTool(name: string, perms: Partial<Tool["manifest"]["permissions"]> = {}, timeoutMs = 5000): Tool {
  return {
    code: "",
    manifest: {
      name, description: "d", rationale: "r",
      inputSchema: { type: "object" }, outputShape: { type: "object" },
      permissions: { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [], ...perms },
      dependencies: [], limits: { timeoutMs, maxOldSpaceSizeMb: 256 },
      hash: "sha256:" + "a".repeat(64), createdAt: "x", kind: "atomic",
    },
  };
}

test("sandbox returns success for ok-tool", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const tool = mkTool("ok", { fsRead: [FIXTURES] });
  const r = await sb.execute(tool, { x: 3 }, { toolPath: join(FIXTURES, "ok-tool.ts") });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { doubled: 6 });
});

test("sandbox normalizes missing fsWrite so execute does not throw", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const base = mkTool("ok", { fsRead: [FIXTURES] });
  const tool: Tool = {
    ...base,
    manifest: {
      ...base.manifest,
      permissions: {
        fsRead: [FIXTURES],
        net: "none",
        netAllowlist: [],
        env: [],
      } as unknown as Tool["manifest"]["permissions"],
    },
  };
  const r = await sb.execute(tool, { x: 3 }, { toolPath: join(FIXTURES, "ok-tool.ts") });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { doubled: 6 });
});

test("sandbox blocks fs-write when permission not granted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-"));
  try {
    const sb = new NodePermissionSandbox({ workspace: dir });
    const tool = mkTool("w", { fsRead: [FIXTURES] });
    const r = await sb.execute(tool, { path: join(dir, "out.txt"), content: "hi" }, { toolPath: join(FIXTURES, "write-tool.ts") });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(["permission_denied", "runtime_error"].includes(r.error.kind));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sandbox allows fs-write when permission granted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-"));
  try {
    const sb = new NodePermissionSandbox({ workspace: dir });
    const tool = mkTool("w", { fsRead: [FIXTURES, dir], fsWrite: [dir] });
    const r = await sb.execute(tool, { path: join(dir, "out.txt"), content: "hi" }, { toolPath: join(FIXTURES, "write-tool.ts") });
    assert.equal(r.ok, true);
    const body = await readFile(join(dir, "out.txt"), "utf8");
    assert.equal(body, "hi");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sandbox enforces timeout", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const tool = mkTool("slow", { fsRead: [FIXTURES] }, 300);
  const r = await sb.execute(tool, {}, { toolPath: join(FIXTURES, "slow-tool.ts") });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "timeout");
});

test("sandbox enforces depth cap on invokeTool recursion", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES, maxDepth: 2 });
  const tool = mkTool("ok", { fsRead: [FIXTURES] });
  const r = await sb.execute(tool, { x: 1 }, {
    toolPath: join(FIXTURES, "ok-tool.ts"),
    depth: 3,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "depth_exceeded");
});

const LLM_FIXTURE = join(FIXTURES, "llm-tool.ts");

test("sandbox routes llm frame to onLLM handler", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const tool = mkTool("llm", { fsRead: [FIXTURES] });
  const r = await sb.execute(tool, { instructions: "go", input: 1 }, {
    toolPath: LLM_FIXTURE,
    onLLM: async (req) => ({ ok: true, value: `ok:${req.instructions}` }),
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, "ok:go");
});

test("sandbox denies llm capability when no onLLM handler is wired", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const tool = mkTool("llm", { fsRead: [FIXTURES] });
  const r = await sb.execute(tool, { instructions: "go" }, { toolPath: LLM_FIXTURE });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "permission_denied");
});
