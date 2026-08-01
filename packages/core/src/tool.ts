import { TOOL_KIND, type CodeKind, type ToolManifest } from "./types.ts";
import type { Workflow } from "./workflow/types.ts";

/**
 * Registry tool whose body is TypeScript source (`atomic` or `composite` kind).
 * Discriminated from {@link WorkflowTool} by `manifest.kind`.
 */
export type CodeTool = {
  manifest: ToolManifest & { kind: CodeKind };
  code: string;
};

/**
 * Registry tool whose body is workflow IR (`workflow` kind).
 * Discriminated from {@link CodeTool} by `manifest.kind === "workflow"`.
 */
export type WorkflowTool = {
  manifest: ToolManifest & { kind: typeof TOOL_KIND.WORKFLOW };
  workflow: Workflow;
};

/** Persisted registry tool: either a code tool or a workflow tool. */
export type Tool = CodeTool | WorkflowTool;

/**
 * Type guard: true when `tool` is a {@link CodeTool} (atomic or composite).
 *
 * @param tool - Tool to narrow.
 * @returns Whether the tool has a TypeScript source body.
 */
export function isCodeTool(tool: Tool): tool is CodeTool {
  return tool.manifest.kind !== TOOL_KIND.WORKFLOW;
}

/**
 * Type guard: true when `tool` is a {@link WorkflowTool}.
 *
 * @param tool - Tool to narrow.
 * @returns Whether the tool has a workflow IR body.
 */
export function isWorkflowTool(tool: Tool): tool is WorkflowTool {
  return tool.manifest.kind === TOOL_KIND.WORKFLOW;
}
