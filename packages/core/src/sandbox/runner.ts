import { pathToFileURL } from "node:url";

type RunFn = (input: unknown) => Promise<unknown> | unknown;

type StdinFrame =
  | { op: "args"; args: unknown }
  | {
      op: "invokeToolResult";
      requestId: string;
      result: { ok: true; value: unknown } | { ok: false; error: unknown };
    };

type StdoutFrame =
  | { op: "invokeTool"; requestId: string; name: string; args: unknown }
  | {
      op: "result";
      result: { ok: true; value: unknown } | { ok: false; error: unknown };
    };

const pendingInvokes = new Map<
  string,
  (r: { ok: true; value: unknown } | { ok: false; error: unknown }) => void
>();

(globalThis as unknown as { invokeTool: (name: string, args: unknown) => Promise<unknown> }).invokeTool =
  async function invokeTool(name: string, args: unknown) {
    const requestId = Math.random().toString(36).slice(2);
    const frame: StdoutFrame = { op: "invokeTool", requestId, name, args };
    process.stdout.write(JSON.stringify(frame) + "\n");
    return new Promise((resolve) => pendingInvokes.set(requestId, resolve));
  };

function installNetShim(netAllowlist: string[]): void {
  if (netAllowlist.length === 0) return;
  const allow = new Set(netAllowlist.map((h) => h.toLowerCase()));
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: unknown, init?: unknown) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    const host = new URL(url).hostname.toLowerCase();
    if (!allow.has(host)) {
      throw new Error(`net-shim: host '${host}' not in allowlist`);
    }
    return origFetch(
      input as Parameters<typeof origFetch>[0],
      init as Parameters<typeof origFetch>[1],
    );
  };
}

async function main() {
  const toolPath = process.argv[2];
  const netAllowlistRaw = process.env.META_AGENT_NET_ALLOWLIST ?? "";
  const netAllowlist = netAllowlistRaw ? netAllowlistRaw.split(",").filter(Boolean) : [];
  if (!toolPath) {
    process.stdout.write(
      JSON.stringify({
        op: "result",
        result: {
          ok: false,
          error: { kind: "runtime_error", message: "runner: missing tool path" },
        },
      }) + "\n",
    );
    process.exit(0);
  }

  installNetShim(netAllowlist);

  let mod: { run: RunFn };
  try {
    mod = (await import(pathToFileURL(toolPath).href)) as { run: RunFn };
    if (typeof mod.run !== "function") throw new Error("tool does not export a `run` function");
  } catch (e) {
    const err = e as Error;
    const frame: StdoutFrame = {
      op: "result",
      result: {
        ok: false,
        error: { kind: "runtime_error", message: `import failed: ${err.message}` },
      },
    };
    process.stdout.write(JSON.stringify(frame) + "\n");
    process.exit(0);
  }

  let buffer = "";
  let argsResolver: ((a: unknown) => void) | null = null;
  const argsPromise = new Promise<unknown>((resolve) => {
    argsResolver = resolve;
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) {
        try {
          const frame = JSON.parse(line) as StdinFrame;
          if (frame.op === "args") argsResolver?.(frame.args);
          else if (frame.op === "invokeToolResult") {
            const cb = pendingInvokes.get(frame.requestId);
            pendingInvokes.delete(frame.requestId);
            cb?.(frame.result);
          }
        } catch {
          /* ignore malformed line */
        }
      }
      idx = buffer.indexOf("\n");
    }
  });

  const args = await argsPromise;

  try {
    const value = await mod.run(args);
    const frame: StdoutFrame = { op: "result", result: { ok: true, value } };
    process.stdout.write(JSON.stringify(frame) + "\n");
  } catch (e) {
    const err = e as Error;
    const frame: StdoutFrame = {
      op: "result",
      result: {
        ok: false,
        error: {
          kind: "runtime_error",
          message: err.message,
          details: { stack: err.stack },
        },
      },
    };
    process.stdout.write(JSON.stringify(frame) + "\n");
  }
  process.exit(0);
}

main();
