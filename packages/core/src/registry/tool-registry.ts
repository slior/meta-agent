import type { ApprovalRecord, ToolKind, ToolManifest, ToolSummary } from "../types.ts";
import type { CodeTool, WorkflowTool } from "../tool.ts";
import type { IntegrityIssue } from "./integrity.ts";

/**
 * Persistence and lookup API for approved tools (code and workflow).
 * Implementations enforce integrity on load/save and expose an integrity report.
 */
export interface ToolRegistry {
  /**
   * Lists compact summaries of all rehydrated tools.
   *
   * @returns Summaries of every loadable tool in the registry.
   */
  list(): Promise<ToolSummary[]>;
  /**
   * Synchronous variant of {@link list} for call sites that already hold the registry warm.
   *
   * @returns Summaries of every loadable tool in the registry.
   */
  listSync(): ToolSummary[];
  /**
   * Checks whether a tool with the given name is present and loadable.
   *
   * @param name - Tool name.
   * @returns Whether a tool with that name is present and loadable.
   */
  has(name: string): Promise<boolean>;
  /**
   * Returns the manifest kind for a tool name.
   *
   * @param name - Tool name.
   * @returns Manifest kind, or null when the tool is absent / quarantined.
   */
  getKind(name: string): Promise<ToolKind | null>;
  /**
   * Returns the parsed manifest for a tool name.
   *
   * @param name - Tool name.
   * @returns Parsed manifest, or null when absent / quarantined.
   */
  getManifest(name: string): Promise<ToolManifest | null>;
  /**
   * Returns a code tool (atomic or composite) by name.
   *
   * @param name - Tool name.
   * @returns Code tool when present and loadable; null otherwise.
   */
  getCode(name: string): Promise<CodeTool | null>;
  /**
   * Returns a workflow tool by name.
   *
   * @param name - Tool name.
   * @returns Workflow tool when present and loadable; null otherwise.
   */
  getWorkflow(name: string): Promise<WorkflowTool | null>;
  /**
   * Returns the bound approval record for a tool name.
   *
   * @param name - Tool name.
   * @returns Bound approval record, or null when missing.
   */
  getApproval(name: string): Promise<ApprovalRecord | null>;
  /**
   * Persists a code tool and its approval after integrity checks.
   *
   * @param tool - Code tool to write.
   * @param approval - Approval bound to `tool.manifest.hash`.
   */
  saveCode(tool: CodeTool, approval: ApprovalRecord): Promise<void>;
  /**
   * Persists a workflow tool and its approval after integrity checks.
   *
   * @param tool - Workflow tool to write.
   * @param approval - Approval bound to `tool.manifest.hash`.
   */
  saveWorkflow(tool: WorkflowTool, approval: ApprovalRecord): Promise<void>;
  /**
   * Removes a tool directory from the registry.
   *
   * @param name - Tool name.
   * @param opts - Optional cascade of dependents.
   */
  delete(name: string, opts?: { cascade?: boolean }): Promise<void>;
  /**
   * Returns tool names that list the given name in their dependencies.
   *
   * @param name - Tool name.
   * @returns Names of tools that list `name` in their dependencies.
   */
  getDependents(name: string): Promise<string[]>;
  /** Absolute path of the registry root directory. */
  rootDir(): string;
  /**
   * Load/save diagnostics: quarantined / needs-review / invalid since last rehydrate
   * (and failed saves).
   *
   * @returns Accumulated integrity issues.
   */
  integrityReport(): IntegrityIssue[];
}
