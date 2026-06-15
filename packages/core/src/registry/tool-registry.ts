import type { ApprovalRecord, Tool, ToolSummary } from "../types.ts";
import type { Workflow } from "../workflow/types.ts";

/**
 * ToolRegistry defines the interface for managing tools within a registry.
 * Implementations provide persistent or in-memory CRUD operations for tools and their associated metadata,
 * including support for workflow-based tools, approval records, and dependency analysis.
 *
 * All methods operate asynchronously unless otherwise noted.
 */
export interface ToolRegistry {
  /**
   * Lists all tools registered in the registry, returning an array of summary objects containing basic metadata
   * (such as name, description, kind, hash).
   * @returns Promise resolving to an array of ToolSummary objects.
   */
  list(): Promise<ToolSummary[]>;

  /**
   * Returns a synchronous snapshot of all registered tool summaries.
   * Required for situations (such as template/prompt rendering) where async operations are not possible.
   * @returns Array of ToolSummary objects.
   */
  listSync(): ToolSummary[];

  /**
   * Retrieves the complete Tool object (including its manifest and code) for a given tool name.
   * @param name - The unique registered tool name.
   * @returns Promise resolving to the Tool if found, or null if not found.
   */
  get(name: string): Promise<Tool | null>;

  /**
   * Retrieves the approval record associated with a particular tool, if one exists.
   * @param name - The tool name.
   * @returns Promise resolving to the ApprovalRecord if present, otherwise null.
   */
  getApproval(name: string): Promise<ApprovalRecord | null>;

  /**
   * Saves or updates a tool along with its approval record in the registry.
   * Overwrites any existing entry with the same name.
   * @param tool - The Tool object to save.
   * @param approval - The ApprovalRecord associated with the tool.
   * @returns Promise which resolves when the operation completes.
   */
  save(tool: Tool, approval: ApprovalRecord): Promise<void>;

  /**
   * Removes a tool from the registry by name.
   * If cascade is set, dependent tools may also be deleted.
   * @param name - The tool name.
   * @param opts - Optional parameter: { cascade?: boolean } (default: false)
   * @returns Promise which resolves when deletion is complete.
   */
  delete(name: string, opts?: { cascade?: boolean }): Promise<void>;

  /**
   * Retrieves an array of tool names which directly depend on the specified tool.
   * Useful for dependency analysis and safe removals.
   * @param name - The tool name to check for dependents.
   * @returns Promise resolving to an array of dependent tool names.
   */
  getDependents(name: string): Promise<string[]>;

  /**
   * Checks if a tool with the given name exists in the registry.
   * @param name - The tool name.
   * @returns Promise resolving to true if the tool exists, false otherwise.
   */
  has(name: string): Promise<boolean>;

  /**
   * Returns the root directory path of the registry, if applicable.
   * For in-memory implementations, may be a placeholder or empty string.
   * @returns The root directory path as a string.
   */
  rootDir(): string;

  /**
   * Loads the workflow intermediate representation (IR) for a tool of kind 'workflow'.
   * Returns null if the tool is not found or is not a workflow tool.
   * @param name - The workflow tool name.
   * @returns Promise resolving to the Workflow object, or null.
   */
  getWorkflow(name: string): Promise<Workflow | null>;
}
