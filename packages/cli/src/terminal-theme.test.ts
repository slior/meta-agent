import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { formatShortTime } from "./terminal-theme.ts";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

function runThemeScript(script: string, overrides: Record<string, string | undefined> = {}) {
  const env = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
  }
  return spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", script],
    { cwd: SRC_DIR, env },
  );
}

test("formatShortTime: UTC ISO", () => {
  assert.equal(formatShortTime("2026-06-11T12:04:05.123Z"), "12:04:05");
});

test("formatShortTime: offset ISO", () => {
  assert.equal(formatShortTime("2026-06-11T12:04:05.123+03:00"), "12:04:05");
});

test("formatShortTime: malformed returns raw string", () => {
  assert.equal(formatShortTime("not-a-timestamp"), "not-a-timestamp");
});

test("theme disables ANSI when NO_COLOR=1 at import", () => {
  const r = runThemeScript(
    `import { theme } from "./terminal-theme.ts"; process.stdout.write(theme.meta("plain"));`,
    { NO_COLOR: "1" },
  );
  assert.equal(r.status, 0);
  assert.equal(r.stdout.toString(), "plain");
  assert.ok(!/\x1b\[/u.test(r.stdout.toString()));
});

test("theme emits ANSI when FORCE_COLOR=1 at import", () => {
  const r = runThemeScript(
    `import { theme } from "./terminal-theme.ts"; process.stdout.write(theme.ok("plain"));`,
    { NO_COLOR: undefined, FORCE_COLOR: "1" },
  );
  assert.equal(r.status, 0);
  assert.ok(/\x1b\[/u.test(r.stdout.toString()));
});

test("all theme functions return input under NO_COLOR", () => {
  const script = `
    import { theme } from "./terminal-theme.ts";
    const parts = [
      theme.meta("meta"),
      theme.progressLabel("progressLabel"),
      theme.progressBody("progressBody"),
      theme.ok("ok"),
      theme.fail("fail"),
      theme.debugBadge(),
      theme.debugKind("debugKind"),
      theme.debugPayload("debugPayload"),
      theme.debugTruncation("debugTruncation"),
      theme.indent("indent"),
    ];
    process.stdout.write(parts.join("|"));
  `;
  const r = runThemeScript(script, { NO_COLOR: "1" });
  assert.equal(r.status, 0);
  const out = r.stdout.toString();
  assert.ok(!/\x1b\[/u.test(out));
  assert.match(out, /meta/);
  assert.match(out, /progressLabel/);
  assert.match(out, /progressBody/);
  assert.match(out, /ok/);
  assert.match(out, /fail/);
  assert.match(out, /DEBUG/);
  assert.match(out, /debugKind/);
  assert.match(out, /debugPayload/);
  assert.match(out, /debugTruncation/);
  assert.match(out, /indent/);
});
