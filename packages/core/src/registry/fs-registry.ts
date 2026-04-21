import { mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalRecord, Tool, ToolManifest, ToolSummary } from "../types.ts";
import type { ToolRegistry } from "./interface.ts";

export class FsToolRegistry implements ToolRegistry {
  private readonly dir: string;
  private cache = new Map<string, { tool: Tool; approval: ApprovalRecord | null }>();

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async open(dir: string): Promise<FsToolRegistry> {
    await mkdir(dir, { recursive: true });
    const reg = new FsToolRegistry(dir);
    await reg.rehydrate();
    return reg;
  }

  rootDir(): string {
    return this.dir;
  }

  private async rehydrate(): Promise<void> {
    this.cache.clear();
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const sub = join(this.dir, name);
      const st = await stat(sub).catch(() => null);
      if (!st?.isDirectory()) continue;
      const manifestPath = join(sub, "manifest.json");
      const codePath = join(sub, "tool.ts");
      const approvalPath = join(sub, "approval.json");
      try {
        const [mRaw, code] = await Promise.all([
          readFile(manifestPath, "utf8"),
          readFile(codePath, "utf8"),
        ]);
        const manifest = JSON.parse(mRaw) as ToolManifest;
        let approval: ApprovalRecord | null = null;
        try {
          approval = JSON.parse(await readFile(approvalPath, "utf8")) as ApprovalRecord;
        } catch { /* missing approval.json is OK */ }
        this.cache.set(manifest.name, { tool: { manifest, code }, approval });
      } catch {
        // Corrupt/partial entry — skip. Future work: surface as warning via Tracer.
      }
    }
  }

  async list(): Promise<ToolSummary[]> {
    return Array.from(this.cache.values()).map(({ tool }) => ({
      name: tool.manifest.name,
      description: tool.manifest.description,
      hash: tool.manifest.hash,
      kind: tool.manifest.kind,
    }));
  }

  listSync(): ToolSummary[] {
    return Array.from(this.cache.values()).map(({ tool }) => ({
      name: tool.manifest.name,
      description: tool.manifest.description,
      hash: tool.manifest.hash,
      kind: tool.manifest.kind,
    }));
  }

  async has(name: string): Promise<boolean> {
    return this.cache.has(name);
  }

  async get(name: string): Promise<Tool | null> {
    return this.cache.get(name)?.tool ?? null;
  }

  async getApproval(name: string): Promise<ApprovalRecord | null> {
    return this.cache.get(name)?.approval ?? null;
  }

  async save(tool: Tool, approval: ApprovalRecord): Promise<void> {
    const sub = join(this.dir, tool.manifest.name);
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "tool.ts"), tool.code, "utf8");
    await writeFile(join(sub, "manifest.json"), JSON.stringify(tool.manifest, null, 2), "utf8");
    await writeFile(join(sub, "approval.json"), JSON.stringify(approval, null, 2), "utf8");
    this.cache.set(tool.manifest.name, { tool, approval });
  }

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

  async getDependents(name: string): Promise<string[]> {
    const out: string[] = [];
    for (const { tool } of this.cache.values()) {
      if (tool.manifest.dependencies.includes(name)) out.push(tool.manifest.name);
    }
    return out.sort();
  }
}
