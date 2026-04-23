import type { Permissions } from "./types.ts";

/** Coerce manifest/draft permission fields to well-typed arrays (runtime-safe for LLM or disk data). */
export function normalizePermissions(input: unknown): Permissions {
  if (!input || typeof input !== "object") {
    return { fsRead: [], fsWrite: [], net: "none", netAllowlist: [], env: [] };
  }
  const p = input as Record<string, unknown>;
  return {
    fsRead: Array.isArray(p.fsRead) ? (p.fsRead as string[]) : [],
    fsWrite: Array.isArray(p.fsWrite) ? (p.fsWrite as string[]) : [],
    net: p.net === "allowlist" ? "allowlist" : "none",
    netAllowlist: Array.isArray(p.netAllowlist) ? (p.netAllowlist as string[]) : [],
    env: Array.isArray(p.env) ? (p.env as string[]) : [],
  };
}
