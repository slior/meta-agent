import {
  hashCodeTool,
  type CodeKind,
  type CodeTool,
  type ToolManifest,
} from "@meta-agent/core";

/**
 * Builds a {@link CodeTool} with a consistent Link-A hash for CLI tests.
 * Kept local so `@meta-agent/core` does not export test helpers from its public barrel.
 *
 * @param manifestSansHash - Manifest fields excluding `hash`; kind must be atomic or composite.
 * @param code - TypeScript source body.
 * @returns Code tool whose `manifest.hash` matches {@link hashCodeTool}.
 */
export function makeConsistentCodeTool(
  manifestSansHash: Omit<ToolManifest, "hash"> & { kind: CodeKind },
  code: string,
): CodeTool {
  const hash = hashCodeTool(code, manifestSansHash);
  return { manifest: { ...manifestSansHash, hash }, code };
}
