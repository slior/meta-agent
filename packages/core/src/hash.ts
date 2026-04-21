import { createHash } from "node:crypto";
import type { ToolManifest } from "./types.ts";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}

export function hashTool(
  code: string,
  manifestWithoutHash: Omit<ToolManifest, "hash"> | Record<string, unknown>,
): string {
  const h = createHash("sha256");
  h.update(code);
  h.update("\n---manifest---\n");
  h.update(canonicalJson(manifestWithoutHash));
  return "sha256:" + h.digest("hex");
}
