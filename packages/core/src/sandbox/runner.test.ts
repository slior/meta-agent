import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(__dirname, "runner.ts");

function runChild(
  toolPath: string,
  args: unknown,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", RUNNER, toolPath],
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
    child.stdin.write(JSON.stringify({ op: "args", args }) + "\n");
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
  assert.equal(frame.op, "result");
  assert.equal(frame.result.ok, true);
  assert.deepEqual(frame.result.value, { doubled: 42 });
});

test("runner surfaces thrown errors as runtime_error", async () => {
  const { stdout, code } = await runChild(THROWS, {});
  assert.equal(code, 0);
  const last = stdout.trim().split("\n").pop()!;
  const frame = JSON.parse(last);
  assert.equal(frame.result.ok, false);
  assert.equal(frame.result.error.kind, "runtime_error");
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
      ["--experimental-transform-types", "--no-warnings", RUNNER, toolPath],
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
        if (frame.op === "llm") {
          const result = { ok: true, value: reply(frame.req) };
          child.stdin.write(JSON.stringify({ op: "llmResult", requestId: frame.requestId, result }) + "\n");
        }
      }
    });
    child.on("close", (code) => resolve({ stdout, code }));
    child.stdin.write(JSON.stringify({ op: "args", args }) + "\n");
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
  assert.equal(frame.op, "result");
  assert.equal(frame.result.ok, true);
  assert.equal(frame.result.value, "echo:say hi");
});
