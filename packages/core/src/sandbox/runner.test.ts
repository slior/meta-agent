import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NET_FETCH_INPUT_AS, NET_FETCH_REDIRECT } from "./fixtures/net-fetch-tool.ts";
import { NET_WEB_API } from "./fixtures/net-web-api-tool.ts";
import { RUNNER_TOOL_ERROR_KIND } from "./runner-tool-error.ts";
import {
  META_AGENT_NET_ALLOWLIST_ENV,
  SANDBOX_STDIO_OP,
} from "./stdio-protocol.ts";

/** Loopback bind host used by runner-level allowlist fetch tests. */
const LOOPBACK_HOST = "127.0.0.1";

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, LOOPBACK_HOST, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(__dirname, "runner.ts");

/** Node flags shared by every runner child spawn in this file. */
const RUNNER_NODE_FLAGS: string[] = ["--experimental-transform-types", "--no-warnings"];

function runChild(
  toolPath: string,
  args: unknown,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...RUNNER_NODE_FLAGS, RUNNER, toolPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.write(JSON.stringify({ op: SANDBOX_STDIO_OP.args, args }) + "\n");
    child.stdin.end();
  });
}

const OK = join(__dirname, "fixtures/ok-tool.ts");
const THROWS = join(__dirname, "fixtures/throws-tool.ts");

test("runner returns successful result", async () => {
  const { stdout, code } = await runChild(OK, { x: 21 });
  assert.equal(code, 0);
  const last = stdout.trim().split("\n").pop()!;
  const frame = JSON.parse(last);
  assert.equal(frame.op, SANDBOX_STDIO_OP.result);
  assert.equal(frame.result.ok, true);
  assert.deepEqual(frame.result.value, { doubled: 42 });
});

test("runner surfaces thrown errors as runtime_error", async () => {
  const { stdout, code } = await runChild(THROWS, {});
  assert.equal(code, 0);
  const last = stdout.trim().split("\n").pop()!;
  const frame = JSON.parse(last);
  assert.equal(frame.result.ok, false);
  assert.equal(frame.result.error.kind, RUNNER_TOOL_ERROR_KIND.RUNTIME_ERROR);
  assert.match(frame.result.error.message, /kaboom/);
});

const LLM = join(__dirname, "fixtures/llm-tool.ts");

function runChildWithLlm(
  toolPath: string,
  args: unknown,
  reply: (req: unknown) => unknown,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...RUNNER_NODE_FLAGS, RUNNER, toolPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let buf = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
      buf += c.toString();
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame.op === SANDBOX_STDIO_OP.llm) {
          const result = { ok: true, value: reply(frame.req) };
          child.stdin.write(
            JSON.stringify({
              op: SANDBOX_STDIO_OP.llmResult,
              requestId: frame.requestId,
              result,
            }) + "\n",
          );
        }
      }
    });
    child.on("close", (code) => resolve({ stdout, code }));
    child.stdin.write(JSON.stringify({ op: SANDBOX_STDIO_OP.args, args }) + "\n");
  });
}

test("runner services globalThis.llm via llm/llmResult round-trip", async () => {
  const { stdout, code } = await runChildWithLlm(
    LLM,
    { instructions: "say hi", input: "x" },
    (req) => `echo:${(req as { instructions: string }).instructions}`,
  );
  assert.equal(code, 0);
  const last = stdout.trim().split("\n").pop()!;
  const frame = JSON.parse(last);
  assert.equal(frame.op, SANDBOX_STDIO_OP.result);
  assert.equal(frame.result.ok, true);
  assert.equal(frame.result.value, "echo:say hi");
});

const NET_FETCH = join(__dirname, "fixtures/net-fetch-tool.ts");
const NET_WEB_API_TOOL = join(__dirname, "fixtures/net-web-api-tool.ts");
const EVENTSOURCE_POLYFILL_PRELOAD = join(__dirname, "fixtures/eventsource-polyfill-preload.ts");

function runChildWithEnv(
  toolPath: string,
  args: unknown,
  extraEnv: Record<string, string> = {},
  omitEnv: string[] = [],
  importPreload?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  for (const key of omitEnv) delete env[key];
  const nodeArgs = [...RUNNER_NODE_FLAGS];
  if (importPreload) nodeArgs.push("--import", importPreload);
  nodeArgs.push(RUNNER, toolPath);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArgs, { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.write(JSON.stringify({ op: SANDBOX_STDIO_OP.args, args }) + "\n");
    child.stdin.end();
  });
}

function lastResult(stdout: string): {
  ok: boolean;
  value?: { status: number; location: string | null };
  error?: { kind: string; message: string };
} {
  const last = stdout.trim().split("\n").pop()!;
  return JSON.parse(last).result;
}

test("net shim allows fetch to an allowlisted host", async () => {
  const { server, port } = await startServer((_req, res) => {
    res.statusCode = 200;
    res.end("ok");
  });
  try {
    const { stdout, code } = await runChildWithEnv(
      NET_FETCH,
      { url: `http://${LOOPBACK_HOST}:${port}/` },
      { [META_AGENT_NET_ALLOWLIST_ENV]: LOOPBACK_HOST },
    );
    assert.equal(code, 0);
    const result = lastResult(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.value?.status, 200);
  } finally {
    server.close();
  }
});

test("net shim forces redirect manual even when caller passes follow", async () => {
  const { server, port } = await startServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader("location", "http://evil.invalid/");
    res.end();
  });
  try {
    const { stdout, code } = await runChildWithEnv(
      NET_FETCH,
      {
        url: `http://${LOOPBACK_HOST}:${port}/`,
        redirect: NET_FETCH_REDIRECT.FOLLOW,
      },
      { [META_AGENT_NET_ALLOWLIST_ENV]: LOOPBACK_HOST },
    );
    assert.equal(code, 0);
    const result = lastResult(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.value?.status, 302);
    assert.equal(result.value?.location, "http://evil.invalid/");
  } finally {
    server.close();
  }
});

test("net shim leaves fetch unshimmed when allowlist env is unset", async () => {
  const { server, port } = await startServer((_req, res) => {
    res.statusCode = 200;
    res.end("native");
  });
  try {
    const { stdout, code } = await runChildWithEnv(
      NET_FETCH,
      { url: `http://${LOOPBACK_HOST}:${port}/` },
      {},
      [META_AGENT_NET_ALLOWLIST_ENV],
    );
    assert.equal(code, 0);
    const result = lastResult(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.value?.status, 200);
  } finally {
    server.close();
  }
});

test("net shim blocks a host not in the allowlist (permission_denied)", async () => {
  const { stdout, code } = await runChildWithEnv(
    NET_FETCH,
    { url: "https://blocked.example.com/" },
    { [META_AGENT_NET_ALLOWLIST_ENV]: "api.allowed.com" },
  );
  assert.equal(code, 0);
  const result = lastResult(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.error!.kind, RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED);
  assert.match(result.error!.message, /not in allowlist/);
});

test("net shim checks URL-object inputs (no bypass)", async () => {
  const { stdout } = await runChildWithEnv(
    NET_FETCH,
    { url: "https://blocked.example.com/", as: NET_FETCH_INPUT_AS.URL },
    { [META_AGENT_NET_ALLOWLIST_ENV]: "api.allowed.com" },
  );
  const result = lastResult(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.error!.kind, RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED);
});

test("net shim checks Request-object inputs (no bypass)", async () => {
  const { stdout } = await runChildWithEnv(
    NET_FETCH,
    { url: "https://blocked.example.com/", as: NET_FETCH_INPUT_AS.REQUEST },
    { [META_AGENT_NET_ALLOWLIST_ENV]: "api.allowed.com" },
  );
  const result = lastResult(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.error!.kind, RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED);
});

test("net shim fails closed when allowlist is active but empty", async () => {
  const { stdout } = await runChildWithEnv(
    NET_FETCH,
    { url: "https://anything.example.com/" },
    { [META_AGENT_NET_ALLOWLIST_ENV]: "" },
  );
  const result = lastResult(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.error!.kind, RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED);
});

test("net shim blocks WebSocket access (permission_denied)", async () => {
  const { stdout } = await runChildWithEnv(
    NET_WEB_API_TOOL,
    { api: NET_WEB_API.WEBSOCKET, url: "ws://evil.example.com/" },
    { [META_AGENT_NET_ALLOWLIST_ENV]: "api.allowed.com" },
  );
  const result = lastResult(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.error!.kind, RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED);
  assert.match(result.error!.message, /only fetch\(\) is allowed/i);
});

test("net shim blocks EventSource access (permission_denied)", async () => {
  const { stdout } = await runChildWithEnv(
    NET_WEB_API_TOOL,
    { api: NET_WEB_API.EVENTSOURCE, url: "https://evil.example.com/events" },
    { [META_AGENT_NET_ALLOWLIST_ENV]: "api.allowed.com" },
    [],
    EVENTSOURCE_POLYFILL_PRELOAD,
  );
  const result = lastResult(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.error!.kind, RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED);
  assert.match(result.error!.message, /only fetch\(\) is allowed/i);
});

test("net shim leaves WebSocket native when allowlist env is unset", async () => {
  const { stdout } = await runChildWithEnv(
    NET_WEB_API_TOOL,
    { api: NET_WEB_API.WEBSOCKET, url: "ws://127.0.0.1:1/" },
    {},
    [META_AGENT_NET_ALLOWLIST_ENV],
  );
  const result = lastResult(stdout);
  assert.notEqual(result.error?.kind, RUNNER_TOOL_ERROR_KIND.PERMISSION_DENIED);
});
