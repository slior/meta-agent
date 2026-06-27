import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePermissions, unionPermissions } from "./permissions-normalize.ts";

test("normalizePermissions defaults missing or invalid fields", () => {
  assert.deepEqual(normalizePermissions(undefined), {
    fsRead: [],
    fsWrite: [],
    net: "none",
    netAllowlist: [],
    env: [],
  });
  assert.deepEqual(
    normalizePermissions({
      fsRead: ["/a"],
      fsWrite: {},
      net: "bogus",
      netAllowlist: null,
      env: 1,
    } as unknown),
    {
      fsRead: ["/a"],
      fsWrite: [],
      net: "none",
      netAllowlist: [],
      env: [],
    },
  );
});

test("normalizePermissions preserves allowlist net", () => {
  const out = normalizePermissions({
    fsRead: [],
    fsWrite: [],
    net: "allowlist",
    netAllowlist: ["x"],
    env: [],
  });
  assert.equal(out.net, "allowlist");
  assert.deepEqual(out.netAllowlist, ["x"]);
});

test("unionPermissions: empty array returns deny-all defaults", () => {
  assert.deepEqual(unionPermissions([]), {
    fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [],
  });
});

test("unionPermissions: allowlist net wins over none", () => {
  const result = unionPermissions([
    { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    { fsRead: [], fsWrite: [], net: "allowlist", netAllowlist: ["api.example.com"], env: [] },
  ]);
  assert.equal(result.net, "allowlist");
  assert.deepEqual(result.netAllowlist, ["api.example.com"]);
});

test("unionPermissions: deduplicates fsRead paths", () => {
  const result = unionPermissions([
    { fsRead: ["/a", "/b"], fsWrite: [], net: "none", netAllowlist: [], env: [] },
    { fsRead: ["/b", "/c"], fsWrite: [], net: "none", netAllowlist: [], env: [] },
  ]);
  assert.deepEqual([...result.fsRead].sort(), ["/a", "/b", "/c"]);
});

test("unionPermissions: deduplicates fsWrite paths", () => {
  const result = unionPermissions([
    { fsRead: [], fsWrite: ["/tmp"], net: "none", netAllowlist: [], env: [] },
    { fsRead: [], fsWrite: ["/tmp"], net: "none", netAllowlist: [], env: [] },
  ]);
  assert.deepEqual(result.fsWrite, ["/tmp"]);
});

test("unionPermissions: deduplicates env vars across inputs", () => {
  const result = unionPermissions([
    { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: ["VAR_A", "VAR_B"] },
    { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: ["VAR_B", "VAR_C"] },
  ]);
  assert.deepEqual([...result.env].sort(), ["VAR_A", "VAR_B", "VAR_C"]);
});

test("unionPermissions: two allowlist inputs dedup netAllowlist hosts", () => {
  const result = unionPermissions([
    { fsRead: [], fsWrite: [], net: "allowlist", netAllowlist: ["a.com", "b.com"], env: [] },
    { fsRead: [], fsWrite: [], net: "allowlist", netAllowlist: ["b.com", "c.com"], env: [] },
  ]);
  assert.deepEqual([...result.netAllowlist].sort(), ["a.com", "b.com", "c.com"]);
});
