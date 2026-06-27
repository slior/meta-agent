import { PERMISSIONS_NET, type Permissions } from "./types.ts";

/** Coerce manifest/draft permission fields to well-typed arrays (runtime-safe for LLM or disk data). */
export function normalizePermissions(input: unknown): Permissions {
  if (!input || typeof input !== "object") {
    return { fsRead: [], fsWrite: [], net: PERMISSIONS_NET.NONE, netAllowlist: [], env: [] };
  }
  const p = input as Record<string, unknown>;
  return {
    fsRead: Array.isArray(p.fsRead) ? (p.fsRead as string[]) : [],
    fsWrite: Array.isArray(p.fsWrite) ? (p.fsWrite as string[]) : [],
    net: p.net === PERMISSIONS_NET.ALLOWLIST ? PERMISSIONS_NET.ALLOWLIST : PERMISSIONS_NET.NONE,
    netAllowlist: Array.isArray(p.netAllowlist) ? (p.netAllowlist as string[]) : [],
    env: Array.isArray(p.env) ? (p.env as string[]) : [],
  };
}

/**
 * Returns the union of multiple permission sets.
 * - `net`: allowlist wins over none (any network permission propagates).
 * - All path/host/env string arrays are deduplicated across all inputs.
 * - An empty input array returns deny-all defaults.
 *
 * @param perms - Permission sets to merge.
 * @returns Combined permissions with deduplicated path/host/env lists.
 */
export function unionPermissions(perms: Permissions[]): Permissions {
  if (perms.length === 0) {
    return { fsRead: [], fsWrite: [], net: PERMISSIONS_NET.NONE, netAllowlist: [], env: [] };
  }
  const net = perms.some((p) => p.net === PERMISSIONS_NET.ALLOWLIST)
    ? PERMISSIONS_NET.ALLOWLIST
    : PERMISSIONS_NET.NONE;
  const dedup = (...arrs: string[][]): string[] => [...new Set(arrs.flat())];
  return {
    net,
    fsRead: dedup(...perms.map((p) => p.fsRead)),
    fsWrite: dedup(...perms.map((p) => p.fsWrite)),
    netAllowlist: dedup(...perms.map((p) => p.netAllowlist)),
    env: dedup(...perms.map((p) => p.env)),
  };
}
