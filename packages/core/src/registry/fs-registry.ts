import { mkdir, readFile, writeFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  TOOL_KIND,
  type ApprovalRecord,
  type CodeKind,
  type ToolKind,
  type ToolManifest,
  type ToolSummary,
} from "../types.ts";
import { isCodeTool, isWorkflowTool, type CodeTool, type Tool, type WorkflowTool } from "../tool.ts";
import { serializeWorkflowBody } from "../hash.ts";
import { parseWorkflow, type ParseError } from "../workflow/parser.ts";
import type { Workflow } from "../workflow/types.ts";
import type { ToolRegistry } from "./tool-registry.ts";
import {
  type IntegrityIssue,
  type IntegrityResult,
  INTEGRITY_BODY_KIND,
  INTEGRITY_REASON,
  INTEGRITY_STATUS,
  RegistryIntegrityError,
  verifyToolIntegrity,
} from "./integrity.ts";
import { isENOENT, registryLogDebug, registryLogWarn } from "./registry-log.ts";

/** File names inside a single `<root>/<tool-name>/` registry entry directory. */
const ENTRY_FILE = {
  MANIFEST: "manifest.json",
  APPROVAL: "approval.json",
  CODE: "tool.ts",
  WORKFLOW: "workflow.json",
} as const;

/**
 * One cached registry entry.
 *
 * `workflowRaw` holds the exact `workflow.json` bytes that passed Link A, so the registry never
 * has to re-serialize IR to reason about the persisted body (legacy bodies may be minified).
 * It is private to the registry and never exposed on {@link WorkflowTool}.
 */
type CacheEntry = {
  tool: Tool;
  approval: ApprovalRecord | null;
  needsReview?: boolean;
  workflowRaw?: string;
};

/** Narrows a manifest read from disk to the workflow kind. */
function isWorkflowManifest(
  manifest: ToolManifest,
): manifest is ToolManifest & { kind: typeof TOOL_KIND.WORKFLOW } {
  return manifest.kind === TOOL_KIND.WORKFLOW;
}

/** Narrows a manifest read from disk to the code kinds (atomic or composite). */
function isCodeManifest(manifest: ToolManifest): manifest is ToolManifest & { kind: CodeKind } {
  return manifest.kind === TOOL_KIND.ATOMIC || manifest.kind === TOOL_KIND.COMPOSITE;
}

function formatParseErrors(errors: ParseError[]): string {
  return errors.map((e) => `${e.pointer}: ${e.message}`).join("; ");
}

/**
 * FsToolRegistry is a persistent implementation of the ToolRegistry interface,
 * storing atomic, composite, and workflow tools and their metadata as files on disk.
 *
 * Tools are organized into subdirectories under a root directory, with each tool having:
 *   - manifest.json: ToolManifest describing the tool (name, description, kind, etc)
 *   - approval.json: ApprovalRecord for audit and gating
 *   - tool.ts: TypeScript source, for atomic and composite tools
 *   - workflow.json: serialized workflow IR, for workflow tools
 *
 * At most one body file exists per entry; a kind-changing save deletes the alternate one.
 *
 * Reads and writes are kind-explicit (`getCode` / `getWorkflow` / `saveCode` / `saveWorkflow`),
 * and every cached value is deep-cloned on the way in and out so callers cannot mutate registry
 * state through a returned object.
 *
 * Integrity follows ADR 004: on load, Link A is checked against the raw body bytes as they exist
 * on disk (never parse-then-reserialize), so any previously hashed formatting still loads. Workflow
 * bodies additionally go through `parseWorkflow`; a structural failure is recorded as `invalid`
 * rather than `quarantined`, since the hash binding itself is intact.
 *
 * Example usage:
 *   const reg = await FsToolRegistry.open("/some/dir");
 *   await reg.saveCode(someCodeTool, approvalRecord);
 *   const tool = await reg.getCode("my-tool");
 */
export class FsToolRegistry implements ToolRegistry {
  private readonly dir: string;
  /** In-memory cache mapping tool names to their tool object, approval record, and load state. */
  private cache = new Map<string, CacheEntry>();
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
    return this.integrityIssues.map((issue) => ({ ...issue }));
  }

  /** True for hidden or non-tool entries under the registry root (e.g. `.DS_Store`). */
  private shouldSkipFile(name: string): boolean {
    return name.startsWith(".");
  }

  /**
   * Loads a workflow tool from `workflow.json` into the in-memory cache.
   *
   * Link A runs against the raw file bytes; only afterwards is the body parsed structurally.
   * A parse failure is recorded as `invalid` and the entry is skipped.
   */
  private async loadWorkflowTool(
    entryName: string,
    workflowPath: string,
    manifest: ToolManifest & { kind: typeof TOOL_KIND.WORKFLOW },
    approval: ApprovalRecord | null,
  ): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(workflowPath, "utf8");
    } catch (err) {
      registryLogDebug(`entry '${entryName}': missing or unreadable workflow.json`, err);
      return;
    }
    const result = verifyToolIntegrity({ kind: INTEGRITY_BODY_KIND.WORKFLOW, raw }, manifest, approval);
    if (result.status === INTEGRITY_STATUS.QUARANTINED) {
      this.recordIntegrityIssue({ name: manifest.name, path: workflowPath, status: result.status, reason: result.reason });
      return;
    }

    const workflow = this.parseWorkflowBody(raw);
    if (workflow === null) {
      this.recordIntegrityIssue({
        name: manifest.name,
        path: workflowPath,
        status: INTEGRITY_STATUS.INVALID,
        reason: INTEGRITY_REASON.WORKFLOW_PARSE_FAILED,
      });
      return;
    }

    const needsReview = result.status === INTEGRITY_STATUS.NEEDS_REVIEW;
    if (needsReview) {
      this.recordIntegrityIssue({ name: manifest.name, path: workflowPath, status: result.status, reason: result.reason });
    }
    this.cache.set(manifest.name, {
      tool: { manifest, workflow },
      approval: needsReview ? null : approval,
      workflowRaw: raw,
      ...(needsReview ? { needsReview: true } : {}),
    });
  }

  /** Parses persisted workflow bytes into typed IR, or null when they are structurally unusable. */
  private parseWorkflowBody(raw: string): Workflow | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      registryLogDebug("workflow body is not valid JSON", err);
      return null;
    }
    const parsed = parseWorkflow(json);
    if (!parsed.ok) {
      registryLogDebug(`workflow body failed structural validation: ${formatParseErrors(parsed.errors)}`);
      return null;
    }
    return parsed.workflow;
  }

  /**
   * Loads an atomic or composite tool from `tool.ts` into the in-memory cache.
   * Logs and skips the entry when the file is missing or unreadable.
   */
  private async loadCodeTool(
    entryName: string,
    codePath: string,
    manifest: ToolManifest & { kind: CodeKind },
    approval: ApprovalRecord | null,
  ): Promise<void> {
    let code: string;
    try {
      code = await readFile(codePath, "utf8");
    } catch (err) {
      registryLogDebug(`entry '${entryName}': missing or unreadable tool.ts`, err);
      return;
    }
    const result = verifyToolIntegrity({ kind: INTEGRITY_BODY_KIND.CODE, code }, manifest, approval);
    if (result.status === INTEGRITY_STATUS.QUARANTINED || result.status === INTEGRITY_STATUS.INVALID) {
      this.recordIntegrityIssue({ name: manifest.name, path: codePath, status: result.status, reason: result.reason });
      return;
    }
    if (result.status === INTEGRITY_STATUS.NEEDS_REVIEW) {
      this.recordIntegrityIssue({ name: manifest.name, path: codePath, status: result.status, reason: result.reason });
      this.cache.set(manifest.name, { tool: { manifest, code }, approval: null, needsReview: true });
      return;
    }
    this.cache.set(manifest.name, { tool: { manifest, code }, approval });
  }

  /**
   * Reloads the registry contents from disk, clearing the in-memory cache.
   * Called during initialization and manual reloads.
   * Recovers gracefully from missing/corrupt entries.
   */
  private async rehydrate(): Promise<void> {
    this.cache.clear();
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
   * Loads one registry subdirectory (manifest, optional approval, tool body) into the cache.
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
    try {
      const mRaw = await readFile(join(sub, ENTRY_FILE.MANIFEST), "utf8");
      const manifest = JSON.parse(mRaw) as ToolManifest;
      const approval = await this.readApproval(name, join(sub, ENTRY_FILE.APPROVAL));

      if (isWorkflowManifest(manifest)) {
        await this.loadWorkflowTool(name, join(sub, ENTRY_FILE.WORKFLOW), manifest, approval);
      } else if (isCodeManifest(manifest)) {
        await this.loadCodeTool(name, join(sub, ENTRY_FILE.CODE), manifest, approval);
      } else {
        registryLogDebug(`entry '${name}': unknown manifest kind '${String(manifest.kind)}'`);
      }
    } catch (err) {
      registryLogDebug(`entry '${name}': corrupt or incomplete (manifest.json)`, err);
    }
  }

  /** Reads `approval.json` for an entry; absent or unreadable approvals load as null. */
  private async readApproval(entryName: string, approvalPath: string): Promise<ApprovalRecord | null> {
    try {
      return JSON.parse(await readFile(approvalPath, "utf8")) as ApprovalRecord;
    } catch (err) {
      if (!isENOENT(err)) {
        registryLogDebug(`entry '${entryName}': could not load approval.json`, err);
      }
      return null;
    }
  }

  private summaries(): ToolSummary[] {
    return Array.from(this.cache.values()).map(({ tool }) => ({
      name: tool.manifest.name,
      description: tool.manifest.description,
      hash: tool.manifest.hash,
      kind: tool.manifest.kind,
    }));
  }

  /**
   * Lists all registered tools, returning summaries (name, description, hash, kind).
   * @returns Array of ToolSummary objects
   */
  async list(): Promise<ToolSummary[]> {
    return this.summaries();
  }

  /**
   * Synchronous variant of list(), for code paths not awaiting on disk.
   * @returns Array of ToolSummary objects
   */
  listSync(): ToolSummary[] {
    return this.summaries();
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
   * Returns the stored kind for a tool name, or null when the name is unknown.
   * @param name Tool name
   */
  async getKind(name: string): Promise<ToolKind | null> {
    return this.cache.get(name)?.tool.manifest.kind ?? null;
  }

  /**
   * Returns a defensive copy of a tool's manifest, or null when the name is unknown.
   * Preferred over the body getters when only metadata is needed.
   * @param name Tool name
   */
  async getManifest(name: string): Promise<ToolManifest | null> {
    const manifest = this.cache.get(name)?.tool.manifest;
    return manifest ? structuredClone(manifest) : null;
  }

  /**
   * Returns a defensive copy of an atomic or composite tool.
   * Null when the name is unknown or the stored entry is a workflow.
   * @param name Tool name
   */
  async getCode(name: string): Promise<CodeTool | null> {
    const entry = this.cache.get(name);
    if (!entry || !isCodeTool(entry.tool)) return null;
    return structuredClone(entry.tool);
  }

  /**
   * Returns a defensive copy of a workflow tool, including its typed IR.
   * Null when the name is unknown or the stored entry is a code tool.
   * @param name Tool name
   */
  async getWorkflow(name: string): Promise<WorkflowTool | null> {
    const entry = this.cache.get(name);
    if (!entry || !isWorkflowTool(entry.tool)) return null;
    return structuredClone(entry.tool);
  }

  /**
   * Retrieves a defensive copy of the approval record for a tool, if any.
   * @param name Tool name
   */
  async getApproval(name: string): Promise<ApprovalRecord | null> {
    const approval = this.cache.get(name)?.approval;
    return approval ? structuredClone(approval) : null;
  }

  /**
   * Saves (or updates) an atomic or composite tool and its approval.
   * Writes `tool.ts` verbatim so the on-disk bytes are the ones Link A verified, and removes a
   * stale `workflow.json` when this save changes the entry's kind.
   * @param tool Code tool to persist
   * @param approval Corresponding approval record
   */
  async saveCode(tool: CodeTool, approval: ApprovalRecord): Promise<void> {
    this.assertSaveKind(tool.manifest, false);
    this.requireOkIntegrity(
      tool.manifest.name,
      verifyToolIntegrity({ kind: INTEGRITY_BODY_KIND.CODE, code: tool.code }, tool.manifest, approval),
    );
    const sub = await this.writeEntryMetadata(tool.manifest, approval);
    await writeFile(join(sub, ENTRY_FILE.CODE), tool.code, "utf8");
    await this.removeStaleBody(sub, ENTRY_FILE.WORKFLOW);
    this.cache.set(tool.manifest.name, {
      tool: structuredClone(tool),
      approval: structuredClone(approval),
    });
  }

  /**
   * Saves (or updates) a workflow tool and its approval.
   * The IR is serialized once and that exact string is both hashed and written, after passing
   * structural validation. Removes a stale `tool.ts` when this save changes the entry's kind.
   * @param tool Workflow tool to persist
   * @param approval Corresponding approval record
   * @throws When the IR fails `parseWorkflow`, before anything is written.
   */
  async saveWorkflow(tool: WorkflowTool, approval: ApprovalRecord): Promise<void> {
    this.assertSaveKind(tool.manifest, true);
    const raw = serializeWorkflowBody(tool.workflow);
    const parsed = parseWorkflow(JSON.parse(raw));
    if (!parsed.ok) {
      throw new Error(
        `cannot save workflow tool '${tool.manifest.name}': ${INTEGRITY_REASON.WORKFLOW_PARSE_FAILED} (${formatParseErrors(parsed.errors)})`,
      );
    }
    this.requireOkIntegrity(
      tool.manifest.name,
      verifyToolIntegrity({ kind: INTEGRITY_BODY_KIND.WORKFLOW, raw }, tool.manifest, approval),
    );
    const sub = await this.writeEntryMetadata(tool.manifest, approval);
    await writeFile(join(sub, ENTRY_FILE.WORKFLOW), raw, "utf8");
    await this.removeStaleBody(sub, ENTRY_FILE.CODE);
    this.cache.set(tool.manifest.name, {
      tool: structuredClone(tool),
      approval: structuredClone(approval),
      workflowRaw: raw,
    });
  }

  /** Rejects a save whose manifest kind does not match the kind-explicit method (programmer error). */
  private assertSaveKind(manifest: ToolManifest, expectWorkflow: boolean): void {
    const isWorkflow = manifest.kind === TOOL_KIND.WORKFLOW;
    if (isWorkflow === expectWorkflow) return;
    const method = expectWorkflow ? "saveWorkflow" : "saveCode";
    throw new Error(
      `registry ${method} called for '${manifest.name}' with manifest kind '${manifest.kind}'`,
    );
  }

  /** Records and throws unless the entry is fully consistent (Link A and Link B). */
  private requireOkIntegrity(name: string, result: IntegrityResult): void {
    if (result.status === INTEGRITY_STATUS.OK) return;
    this.recordIntegrityIssue({
      name,
      path: join(this.dir, name),
      status: result.status,
      reason: result.reason,
    });
    throw new RegistryIntegrityError(name, result);
  }

  /** Creates the entry directory and writes its manifest and approval files. Returns the directory. */
  private async writeEntryMetadata(manifest: ToolManifest, approval: ApprovalRecord): Promise<string> {
    const sub = join(this.dir, manifest.name);
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, ENTRY_FILE.MANIFEST), JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(join(sub, ENTRY_FILE.APPROVAL), JSON.stringify(approval, null, 2), "utf8");
    return sub;
  }

  /** Best-effort removal of the body file belonging to the kind this entry no longer has. */
  private async removeStaleBody(sub: string, file: string): Promise<void> {
    try {
      await unlink(join(sub, file));
    } catch (err) {
      if (!isENOENT(err)) {
        registryLogDebug(`could not remove stale body '${file}' in '${sub}'`, err);
      }
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
