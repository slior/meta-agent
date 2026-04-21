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
