import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePermissions } from "./permissions-normalize.ts";

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
