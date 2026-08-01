import { createHash } from "node:crypto";
import type { ToolManifest } from "./types.ts";
import type { Workflow } from "./workflow/types.ts";

/** Separator between body bytes and canonical manifest JSON in {@link hashToolBody}. */
const MANIFEST_HASH_SEPARATOR = "\n---manifest---\n";

/**
 * Deterministic JSON encoding with recursively sorted object keys.
 * Used for stable manifest hashing across process restarts.
 *
 * @param value - Arbitrary JSON-compatible value.
 * @returns Canonical JSON string.
 */
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

/**
 * Package-internal raw-body digest. Not re-exported from `index.ts`.
 * Prefer {@link hashCodeTool} or {@link hashWorkflowTool} at call sites.
 *
 * @param body - Exact body bytes that will be persisted (source or serialized workflow).
 * @param manifestSansHash - Manifest fields excluding `hash`.
 * @returns Digest string prefixed with `sha256:`.
 */
export function hashToolBody(
  body: string,
  manifestSansHash: Omit<ToolManifest, "hash"> | Record<string, unknown>,
): string {
  const h = createHash("sha256");
  h.update(body);
  h.update(MANIFEST_HASH_SEPARATOR);
  h.update(canonicalJson(manifestSansHash));
  return "sha256:" + h.digest("hex");
}

/**
 * Hashes an atomic or composite tool's source code and manifest fields.
 *
 * @param code - TypeScript source that will be stored as `tool.ts`.
 * @param manifestSansHash - Manifest fields excluding `hash`.
 * @returns Digest string prefixed with `sha256:`.
 */
export function hashCodeTool(
  code: string,
  manifestSansHash: Omit<ToolManifest, "hash"> | Record<string, unknown>,
): string {
  return hashToolBody(code, manifestSansHash);
}

/**
 * Serializes workflow IR exactly as it is persisted in `workflow.json`.
 *
 * @param workflow - Workflow IR value.
 * @returns Pretty-printed JSON with 2-space indent.
 */
export function serializeWorkflowBody(workflow: Workflow): string {
  return JSON.stringify(workflow, null, 2);
}

/**
 * Hashes a workflow's serialized IR and manifest fields.
 *
 * @param workflow - Workflow IR that will be stored as `workflow.json`.
 * @param manifestSansHash - Manifest fields excluding `hash`.
 * @returns Digest string prefixed with `sha256:`.
 */
export function hashWorkflowTool(
  workflow: Workflow,
  manifestSansHash: Omit<ToolManifest, "hash"> | Record<string, unknown>,
): string {
  return hashToolBody(serializeWorkflowBody(workflow), manifestSansHash);
}
