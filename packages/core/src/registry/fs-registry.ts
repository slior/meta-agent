import { mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_KIND, type ApprovalRecord, type Tool, type ToolManifest, type ToolSummary } from "../types.ts";
import type { Workflow } from "../workflow/types.ts";
import type { ToolRegistry } from "./tool-registry.ts";
import { type IntegrityIssue, INTEGRITY_STATUS, RegistryIntegrityError, verifyToolIntegrity } from "./integrity.ts";
import { isENOENT, registryLogDebug, registryLogWarn } from "./registry-log.ts";

/**
 * FsToolRegistry is a persistent implementation of the ToolRegistry interface,
 * storing atomic, composite, and workflow tools and their metadata as files on disk.
 *
 * Tools are organized into subdirectories under a root directory, with each tool having:
 *   - manifest.json: ToolManifest describing the tool (name, description, kind, etc)
 *   - tool.ts: The tool's TypeScript code (atomic and composite tools only)
 *   - approval.json: ApprovalRecord for audit and gating
 *   - workflow.json: For workflow tools, their serialized workflow definition
 *
 * FsToolRegistry supports workflow tools as first-class entries, grouping
 * workflow IRs and their manifests, and caching their parsed data for fast lookups.
 *
 * The registry ensures data integrity via "rehydrate", and provides basic CRUD operations,
 * including cascading deletes and dependency checks (tools may depend on others via their manifests).
 *
 * Example usage:
 *   const reg = await FsToolRegistry.open("/some/dir");
 *   await reg.save(someTool, approvalRecord);
 *   const tool = await reg.get("my-tool");
 */
export class FsToolRegistry implements ToolRegistry {
  private readonly dir: string;
  /**
   * In-memory cache mapping tool names to their tool object and approval record.
   */
  private cache = new Map<string, { tool: Tool; approval: ApprovalRecord | null; needsReview?: boolean }>();
  /**
   * In-memory cache for workflow definitions, by tool name.
   */
  private workflows = new Map<string, Workflow>();
  /** Integrity problems found during the most recent rehydrate (and on failed saves). */
  private integrityIssues: IntegrityIssue[] = [];

  /**
   * Private constructor. Use static open() to instantiate and load registry from disk.
   * @param dir Root filesystem directory where tools are stored
   */
  private constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Opens (or creates) a tool registry at the given directory,
   * and loads all tool metadata into memory.
   * @param dir Path to registry root directory
   * @returns Resolved FsToolRegistry instance
   */
  static async open(dir: string): Promise<FsToolRegistry> {
    await mkdir(dir, { recursive: true });
    const reg = new FsToolRegistry(dir);
    await reg.rehydrate();
    return reg;
  }

  /**
   * Returns the registry root directory path.
   */
  rootDir(): string {
    return this.dir;
  }

  /** Records an integrity issue and logs a warning. Both recorded (queryable) and logged (stderr). */
  private recordIntegrityIssue(issue: IntegrityIssue): void {
    this.integrityIssues.push(issue);
    registryLogWarn(`tool '${issue.name}' ${issue.status}: ${issue.reason} (${issue.path})`);
  }

  /** Integrity problems found at load (and on failed saves) since the last rehydrate. */
  integrityReport(): IntegrityIssue[] {
    return [...this.integrityIssues];
  }

  /** True for hidden or non-tool entries under the registry root (e.g. `.DS_Store`). */
  private shouldSkipFile(name: string): boolean {
    return name.startsWith(".");
  }

  /**
   * Loads a workflow tool from `workflow.json` into the in-memory caches.
   * Logs and skips the entry when the file is missing or invalid.
   */
  private async loadWorkflowTool(
    entryName: string,
    workflowPath: string,
    manifest: ToolManifest,
    approval: ApprovalRecord | null,
  ): Promise<void> {
    let wRaw: string;
    try {
      wRaw = await readFile(workflowPath, "utf8");
    } catch (err) {
      registryLogDebug(`entry '${entryName}': missing or corrupt workflow.json`, err);
      return;
    }
    let workflow: Workflow;
    try {
      workflow = JSON.parse(wRaw) as Workflow;
    } catch (err) {
      registryLogDebug(`entry '${entryName}': missing or corrupt workflow.json`, err);
      return;
    }
    const result = verifyToolIntegrity(wRaw, manifest, approval);
    if (result.status === INTEGRITY_STATUS.quarantined) {
      this.recordIntegrityIssue({ name: manifest.name, path: workflowPath, status: result.status, reason: result.reason });
      return;
    }
    const needsReview = result.status === INTEGRITY_STATUS.needsReview;
    if (needsReview) {
      this.recordIntegrityIssue({ name: manifest.name, path: workflowPath, status: result.status, reason: result.reason });
    }
    this.workflows.set(manifest.name, workflow);
    this.cache.set(manifest.name, {
      tool: { manifest, code: "" },
      approval: needsReview ? null : approval,
      ...(needsReview ? { needsReview: true } : {}),
    });
  }

  /**
   * Loads an atomic or composite tool from `tool.ts` into the in-memory cache.
   * Logs and skips the entry when the file is missing or unreadable.
   */
  private async loadCodeTool(
    entryName: string,
    codePath: string,
    manifest: ToolManifest,
    approval: ApprovalRecord | null,
  ): Promise<void> {
    let code: string;
    try {
      code = await readFile(codePath, "utf8");
    } catch (err) {
      registryLogDebug(`entry '${entryName}': missing or unreadable tool.ts`, err);
      return;
    }
    const result = verifyToolIntegrity(code, manifest, approval);
    if (result.status === INTEGRITY_STATUS.quarantined) {
      this.recordIntegrityIssue({ name: manifest.name, path: codePath, status: result.status, reason: result.reason });
      return;
    }
    if (result.status === INTEGRITY_STATUS.needsReview) {
      this.recordIntegrityIssue({ name: manifest.name, path: codePath, status: result.status, reason: result.reason });
      this.cache.set(manifest.name, { tool: { manifest, code }, approval: null, needsReview: true });
      return;
    }
    this.cache.set(manifest.name, { tool: { manifest, code }, approval });
  }

  /**
   * Reloads the registry contents from disk, clearing in-memory caches.
   * Called during initialization and manual reloads.
   * Recovers gracefully from missing/corrupt entries.
   */
  private async rehydrate(): Promise<void> {
    this.cache.clear();
    this.workflows.clear();
    this.integrityIssues = [];
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      registryLogWarn(`failed to read tools directory '${this.dir}'`, err);
      return;
    }
    for (const name of entries) {
      await this.rehydrateOneEntry(name);
    }
  }

  /**
   * Loads one registry subdirectory (manifest, optional approval, tool body) into the caches.
   * No-op for hidden names, non-directories, or corrupt entries.
   */
  private async rehydrateOneEntry(name: string): Promise<void> {
    if (this.shouldSkipFile(name)) return;
    const sub = join(this.dir, name);
    const st = await stat(sub).catch((err) => {
      registryLogDebug(`skipped entry '${name}': cannot stat`, err);
      return null;
    });
    if (!st?.isDirectory()) return;
    const manifestPath = join(sub, "manifest.json");
    const codePath = join(sub, "tool.ts");
    const workflowPath = join(sub, "workflow.json");
    const approvalPath = join(sub, "approval.json");
    try {
      const mRaw = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(mRaw) as ToolManifest;
      let approval: ApprovalRecord | null = null;
      try {
        approval = JSON.parse(await readFile(approvalPath, "utf8")) as ApprovalRecord;
      } catch (err) {
        if (!isENOENT(err)) {
          registryLogDebug(`entry '${name}': could not load approval.json`, err);
        }
      }

      if (manifest.kind === TOOL_KIND.workflow) {
        await this.loadWorkflowTool(name, workflowPath, manifest, approval);
      } else {
        await this.loadCodeTool(name, codePath, manifest, approval);
      }
    } catch (err) {
      registryLogDebug(`entry '${name}': corrupt or incomplete (manifest.json)`, err);
    }
  }

  /**
   * Lists all registered tools, returning summaries (name, description, hash, kind).
   * @returns Array of ToolSummary objects
   */
  async list(): Promise<ToolSummary[]> {
    return Array.from(this.cache.values()).map(({ tool }) => ({
      name: tool.manifest.name,
      description: tool.manifest.description,
      hash: tool.manifest.hash,
      kind: tool.manifest.kind,
    }));
  }

  /**
   * Synchronous variant of list(), for code paths not awaiting on disk.
   * @returns Array of ToolSummary objects
   */
  listSync(): ToolSummary[] {
    return Array.from(this.cache.values()).map(({ tool }) => ({
      name: tool.manifest.name,
      description: tool.manifest.description,
      hash: tool.manifest.hash,
      kind: tool.manifest.kind,
    }));
  }

  /**
   * Checks if a tool with the given name exists in the registry.
   * @param name Tool name
   * @returns True if present, false otherwise
   */
  async has(name: string): Promise<boolean> {
    return this.cache.has(name);
  }

  /**
   * Retrieves the full Tool object for a given tool name, or null if absent.
   * @param name Tool name
   */
  async get(name: string): Promise<Tool | null> {
    return this.cache.get(name)?.tool ?? null;
  }

  /**
   * Retrieves the approval record for a tool, if any.
   * @param name Tool name
   */
  async getApproval(name: string): Promise<ApprovalRecord | null> {
    return this.cache.get(name)?.approval ?? null;
  }

  /**
   * Looks up a workflow definition for a workflow tool by name.
   * Returns null for non-workflow kinds or if not found.
   * @param name Tool name
   */
  async getWorkflow(name: string): Promise<Workflow | null> {
    return this.workflows.get(name) ?? null;
  }

  /**
   * Saves (or updates) a tool and its approval, writing manifests and code to disk, and updating memory cache.
   * For workflow tools, expects a serialized workflow in the code field.
   * @param tool Tool definition to save
   * @param approval Corresponding approval record
   */
  async save(tool: Tool, approval: ApprovalRecord): Promise<void> {
    const verdict = verifyToolIntegrity(tool.code, tool.manifest, approval);
    if (verdict.status !== INTEGRITY_STATUS.ok) {
      this.recordIntegrityIssue({
        name: tool.manifest.name,
        path: join(this.dir, tool.manifest.name),
        status: verdict.status,
        reason: verdict.reason,
      });
      throw new RegistryIntegrityError(tool.manifest.name, verdict);
    }
    const sub = join(this.dir, tool.manifest.name);
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "manifest.json"), JSON.stringify(tool.manifest, null, 2), "utf8");
    await writeFile(join(sub, "approval.json"), JSON.stringify(approval, null, 2), "utf8");
    
    if (tool.manifest.kind === TOOL_KIND.workflow) {
      // Write tool.code verbatim so on-disk bytes match what verifyToolIntegrity hashed.
      const workflow = JSON.parse(tool.code) as Workflow;
      await writeFile(join(sub, "workflow.json"), tool.code, "utf8");
      this.workflows.set(tool.manifest.name, workflow);
      this.cache.set(tool.manifest.name, { tool: { manifest: tool.manifest, code: "" }, approval });
    } else {
      await writeFile(join(sub, "tool.ts"), tool.code, "utf8");
      this.cache.set(tool.manifest.name, { tool, approval });
    }
  }

  /**
   * Deletes a tool from the registry. If the tool has dependents (other tools depending on it),
   * throws unless `opts.cascade` is set, in which case dependent tools are deleted recursively.
   * Removes all files from disk and clears in-memory cache.
   * @param name Tool name to delete
   * @param opts Options object, with optional `cascade` (default: false)
   */
  async delete(name: string, opts: { cascade?: boolean } = {}): Promise<void> {
    const dependents = await this.getDependents(name);
    if (dependents.length > 0 && !opts.cascade) {
      throw new Error(`Cannot delete '${name}': dependents exist: ${dependents.join(", ")}`);
    }
    if (opts.cascade) {
      for (const d of dependents) await this.delete(d, { cascade: true });
    }
    await rm(join(this.dir, name), { recursive: true, force: true });
    this.cache.delete(name);
    this.workflows.delete(name);
  }

  /**
   * Returns a sorted array of all tool names that declare a dependency on the given tool.
   * Used for dependency analysis and deletion checks.
   * @param name Name of the tool whose dependents are being queried
   */
  async getDependents(name: string): Promise<string[]> {
    const out: string[] = [];
    for (const { tool } of this.cache.values()) {
      if (tool.manifest.dependencies.includes(name)) out.push(tool.manifest.name);
    }
    return out.sort();
  }
}
