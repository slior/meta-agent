import type { ApprovalRecord, Tool, ToolSummary } from "../types.ts";

export interface ToolRegistry {
  list(): Promise<ToolSummary[]>;
  get(name: string): Promise<Tool | null>;
  getApproval(name: string): Promise<ApprovalRecord | null>;
  save(tool: Tool, approval: ApprovalRecord): Promise<void>;
  delete(name: string, opts?: { cascade?: boolean }): Promise<void>;
  getDependents(name: string): Promise<string[]>;
  has(name: string): Promise<boolean>;
  rootDir(): string;
}
