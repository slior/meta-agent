import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodePermissionSandbox } from "./node-permission-sandbox.ts";
import { PERMISSIONS_NET, TOOL_ERROR_KIND, type Tool } from "../types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

/** Default sandbox tool timeout used by {@link mkTool} when not overridden. */
const DEFAULT_SANDBOX_TEST_TIMEOUT_MS = 5000;

function mkTool(
  name: string,
  perms: Partial<Tool["manifest"]["permissions"]> = {},
  timeoutMs = DEFAULT_SANDBOX_TEST_TIMEOUT_MS,
): Tool {
  return {
    code: "",
    manifest: {
      name, description: "d", rationale: "r",
      inputSchema: { type: "object" }, outputShape: { type: "object" },
      permissions: {
        fsRead: [],
        fsWrite: [],
        net: PERMISSIONS_NET.NONE,
        netAllowlist: [],
        env: [],
        ...perms,
      },
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
        net: PERMISSIONS_NET.NONE,
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
    if (!r.ok) {
      const allowed = new Set<string>([
        TOOL_ERROR_KIND.PERMISSION_DENIED,
        TOOL_ERROR_KIND.RUNTIME_ERROR,
      ]);
      assert.ok(allowed.has(r.error.kind));
    }
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
  if (!r.ok) assert.equal(r.error.kind, TOOL_ERROR_KIND.PERMISSION_DENIED);
});

/** Loopback bind host used by net allowlist e2e tests. */
const LOOPBACK_HOST = "127.0.0.1";

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, LOOPBACK_HOST, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function fetchToolCode(url: string): string {
  return `export async function run(){ const r = await fetch(${JSON.stringify(url)}); return { status: r.status, body: await r.text() }; }`;
}

test("sandbox allows fetch to an allowlisted loopback host", async () => {
  const { server, port } = await startServer((_req, res) => {
    res.statusCode = 200;
    res.end("hello");
  });
  try {
    const sb = new NodePermissionSandbox({ workspace: FIXTURES });
    const tool = mkTool("net-ok", { net: PERMISSIONS_NET.ALLOWLIST, netAllowlist: [LOOPBACK_HOST] });
    tool.code = fetchToolCode(`http://${LOOPBACK_HOST}:${port}/`);
    const r = await sb.execute(tool, {});
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, { status: 200, body: "hello" });
  } finally {
    server.close();
  }
});

test("sandbox blocks fetch to a host not in the allowlist", async () => {
  const { server, port } = await startServer((_req, res) => {
    res.statusCode = 200;
    res.end("hello");
  });
  try {
    const sb = new NodePermissionSandbox({ workspace: FIXTURES });
    const tool = mkTool("net-deny", {
      net: PERMISSIONS_NET.ALLOWLIST,
      netAllowlist: ["api.allowed.com"],
    });
    tool.code = fetchToolCode(`http://${LOOPBACK_HOST}:${port}/`);
    const r = await sb.execute(tool, {});
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.kind, TOOL_ERROR_KIND.PERMISSION_DENIED);
  } finally {
    server.close();
  }
});

test("sandbox fetch does not auto-follow redirects to unchecked hosts", async () => {
  const { server, port } = await startServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader("location", "http://evil.invalid/");
    res.end();
  });
  try {
    const sb = new NodePermissionSandbox({ workspace: FIXTURES });
    const tool = mkTool("net-redirect", {
      net: PERMISSIONS_NET.ALLOWLIST,
      netAllowlist: [LOOPBACK_HOST],
    });
    tool.code = fetchToolCode(`http://${LOOPBACK_HOST}:${port}/`);
    const r = await sb.execute(tool, {});
    assert.equal(r.ok, true);
    if (r.ok) assert.equal((r.value as { status: number }).status, 302);
  } finally {
    server.close();
  }
});
