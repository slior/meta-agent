import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NodePermissionSandbox } from "./node-permission-sandbox.ts";
import { PERMISSIONS_NET, TOOL_KIND, TOOL_ERROR_KIND, type Permissions } from "../types.ts";
import type { CodeTool } from "../tool.ts";
import { makeConsistentCodeTool } from "../testing/tool-fixtures.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

/** Default sandbox tool timeout used by {@link mkTool} when not overridden. */
const DEFAULT_SANDBOX_TEST_TIMEOUT_MS = 5000;

/**
 * Builds a hash-consistent {@link CodeTool} fixture from the given `code`. Link A verifies
 * `tool.manifest.hash` against the bytes actually executed: `tool.code` when `opts.toolPath`
 * is omitted, or the file at `opts.toolPath` when it is set. Callers exercising a fixture file
 * via `opts.toolPath` must pass that file's exact bytes as `code` (see {@link mkFixtureTool}).
 */
function mkTool(
  name: string,
  perms: Partial<Permissions> = {},
  timeoutMs = DEFAULT_SANDBOX_TEST_TIMEOUT_MS,
  code = "",
): CodeTool {
  return makeConsistentCodeTool(
    {
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
      createdAt: "x", kind: TOOL_KIND.ATOMIC,
    },
    code,
  );
}

/**
 * Builds a hash-consistent {@link CodeTool} whose `code` is the on-disk bytes of `fixturePath`,
 * so that executing it via `{ toolPath: fixturePath }` satisfies Link A (which hashes the bytes
 * actually executed, not `tool.code`, whenever `toolPath` is set).
 */
function mkFixtureTool(
  name: string,
  fixturePath: string,
  perms: Partial<Permissions> = {},
  timeoutMs = DEFAULT_SANDBOX_TEST_TIMEOUT_MS,
): CodeTool {
  return mkTool(name, perms, timeoutMs, readFileSync(fixturePath, "utf8"));
}

const OK_TOOL_PATH = join(FIXTURES, "ok-tool.ts");

test("sandbox returns success for ok-tool", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const tool = mkFixtureTool("ok", OK_TOOL_PATH, { fsRead: [FIXTURES] });
  const r = await sb.execute(tool, { x: 3 }, { toolPath: OK_TOOL_PATH });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { doubled: 6 });
});

test("sandbox denies execution when toolPath content does not match the approved hash (Link A)", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  // `tool` is internally hash-consistent (its own code matches its own manifest hash), but the
  // file at `toolPath` has different bytes — Link A must hash what actually runs, not `tool.code`.
  const tool = mkTool("mismatched-path", { fsRead: [FIXTURES] }, DEFAULT_SANDBOX_TEST_TIMEOUT_MS, "export async function run(){ return 1; }");
  const r = await sb.execute(tool, { x: 3 }, { toolPath: OK_TOOL_PATH });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, TOOL_ERROR_KIND.PERMISSION_DENIED);
});

test("sandbox executes a verified snapshot instead of reopening toolPath (Link A TOCTOU)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-source-"));
  const toolPath = join(await realpath(dir), "source.ts");
  const code = "export async function run() { return import.meta.url; }";
  await writeFile(toolPath, code, "utf8");
  try {
    const sb = new NodePermissionSandbox({ workspace: dir });
    const tool = mkTool("snapshot-source", {}, DEFAULT_SANDBOX_TEST_TIMEOUT_MS, code);
    const r = await sb.execute(tool, {}, { toolPath });
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok) assert.notEqual(r.value, pathToFileURL(toolPath).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sandbox normalizes missing fsWrite so execute does not throw", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const malformedPermissions = {
    fsRead: [FIXTURES],
    net: PERMISSIONS_NET.NONE,
    netAllowlist: [],
    env: [],
  } as unknown as Permissions;
  const tool = makeConsistentCodeTool(
    {
      name: "ok", description: "d", rationale: "r",
      inputSchema: { type: "object" }, outputShape: { type: "object" },
      permissions: malformedPermissions,
      dependencies: [], limits: { timeoutMs: DEFAULT_SANDBOX_TEST_TIMEOUT_MS, maxOldSpaceSizeMb: 256 },
      createdAt: "x", kind: TOOL_KIND.ATOMIC,
    },
    readFileSync(OK_TOOL_PATH, "utf8"),
  );
  const r = await sb.execute(tool, { x: 3 }, { toolPath: OK_TOOL_PATH });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { doubled: 6 });
});

test("NodePermissionSandbox: Link A mismatch => permission_denied", async () => {
  const tool = makeConsistentCodeTool(
    {
      name: "consistent-tool", description: "d", rationale: "r",
      inputSchema: {}, outputShape: {},
      permissions: { fsRead: [], fsWrite: [], net: PERMISSIONS_NET.NONE, netAllowlist: [], env: [] },
      dependencies: [], limits: { timeoutMs: DEFAULT_SANDBOX_TEST_TIMEOUT_MS, maxOldSpaceSizeMb: 256 },
      createdAt: "2026-01-01T00:00:00.000Z", kind: TOOL_KIND.ATOMIC,
    },
    "export async function run(){return 1;}",
  );
  const tampered: CodeTool = { ...tool, code: tool.code + " // x" };
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const r = await sb.execute(tampered, {});
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "permission_denied");
});

const WRITE_TOOL_PATH = join(FIXTURES, "write-tool.ts");

test("sandbox blocks fs-write when permission not granted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-"));
  try {
    const sb = new NodePermissionSandbox({ workspace: dir });
    const tool = mkFixtureTool("w", WRITE_TOOL_PATH, { fsRead: [FIXTURES] });
    const r = await sb.execute(tool, { path: join(dir, "out.txt"), content: "hi" }, { toolPath: WRITE_TOOL_PATH });
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
    const tool = mkFixtureTool("w", WRITE_TOOL_PATH, { fsRead: [FIXTURES, dir], fsWrite: [dir] });
    const r = await sb.execute(tool, { path: join(dir, "out.txt"), content: "hi" }, { toolPath: WRITE_TOOL_PATH });
    assert.equal(r.ok, true);
    const body = await readFile(join(dir, "out.txt"), "utf8");
    assert.equal(body, "hi");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const SLOW_TOOL_PATH = join(FIXTURES, "slow-tool.ts");

test("sandbox enforces timeout", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const tool = mkFixtureTool("slow", SLOW_TOOL_PATH, { fsRead: [FIXTURES] }, 300);
  const r = await sb.execute(tool, {}, { toolPath: SLOW_TOOL_PATH });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "timeout");
});

test("sandbox enforces depth cap on invokeTool recursion", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES, maxDepth: 2 });
  const tool = mkFixtureTool("ok", OK_TOOL_PATH, { fsRead: [FIXTURES] });
  const r = await sb.execute(tool, { x: 1 }, {
    toolPath: OK_TOOL_PATH,
    depth: 3,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.kind, "depth_exceeded");
});

const LLM_FIXTURE = join(FIXTURES, "llm-tool.ts");

test("sandbox routes llm frame to onLLM handler", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const tool = mkFixtureTool("llm", LLM_FIXTURE, { fsRead: [FIXTURES] });
  const r = await sb.execute(tool, { instructions: "go", input: 1 }, {
    toolPath: LLM_FIXTURE,
    onLLM: async (req) => ({ ok: true, value: `ok:${req.instructions}` }),
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, "ok:go");
});

test("sandbox denies llm capability when no onLLM handler is wired", async () => {
  const sb = new NodePermissionSandbox({ workspace: FIXTURES });
  const tool = mkFixtureTool("llm", LLM_FIXTURE, { fsRead: [FIXTURES] });
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
    const tool = mkTool(
      "net-ok",
      { net: PERMISSIONS_NET.ALLOWLIST, netAllowlist: [LOOPBACK_HOST] },
      DEFAULT_SANDBOX_TEST_TIMEOUT_MS,
      fetchToolCode(`http://${LOOPBACK_HOST}:${port}/`),
    );
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
    const tool = mkTool(
      "net-deny",
      { net: PERMISSIONS_NET.ALLOWLIST, netAllowlist: ["api.allowed.com"] },
      DEFAULT_SANDBOX_TEST_TIMEOUT_MS,
      fetchToolCode(`http://${LOOPBACK_HOST}:${port}/`),
    );
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
    const tool = mkTool(
      "net-redirect",
      { net: PERMISSIONS_NET.ALLOWLIST, netAllowlist: [LOOPBACK_HOST] },
      DEFAULT_SANDBOX_TEST_TIMEOUT_MS,
      fetchToolCode(`http://${LOOPBACK_HOST}:${port}/`),
    );
    const r = await sb.execute(tool, {});
    assert.equal(r.ok, true);
    if (r.ok) assert.equal((r.value as { status: number }).status, 302);
  } finally {
    server.close();
  }
});
