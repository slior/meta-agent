import type { ApprovalRecord, ApprovalToken, Permissions, Tool, ToolDraft, ToolResult } from "../types.ts";
import type { ApprovalPolicy, ApprovalPrompter, ExecutionDecision, Gate1Decision, RiskTier } from "./interface.ts";

const SECRET_PATTERN = /TOKEN|KEY|SECRET|PASS/i;

function pathOutsideWorkspace(path: string, workspace: string): boolean {
  const norm = path.replace(/\/+$/, "");
  const ws = workspace.replace(/\/+$/, "");
  return !(norm === ws || norm.startsWith(ws + "/"));
}

export function riskTier(perms: Permissions, workspace: string): RiskTier {
  if (perms.net !== "none") return "elevated";
  if (perms.fsWrite.some((p) => pathOutsideWorkspace(p, workspace))) return "elevated";
  if (perms.fsRead.some((p) => pathOutsideWorkspace(p, workspace))) return "elevated";
  if (perms.env.some((v) => SECRET_PATTERN.test(v))) return "elevated";
  if (perms.fsWrite.length > 0) return "medium";
  if (perms.env.length > 0) return "medium";
  return "low";
}

export type TieredOpts = {
  workspace: string;
  yolo?: boolean;
};

export class TieredApprovalPolicy implements ApprovalPolicy {
  readonly yolo: boolean;
  private readonly workspace: string;
  private readonly prompter: ApprovalPrompter;
  private readonly sessionCache = new Map<string, boolean>();

  constructor(prompter: ApprovalPrompter, opts: TieredOpts) {
    this.prompter = prompter;
    this.workspace = opts.workspace;
    this.yolo = !!opts.yolo;
  }

  async reviewDraft(draft: ToolDraft, smokeTest: ToolResult): Promise<Gate1Decision> {
    if (this.yolo) {
      return { decision: "approve", alwaysApprove: true, notes: "yolo" };
    }
    return this.prompter.promptGate1(draft, smokeTest);
  }

  async checkExecution(tool: Tool, args: unknown, approval: ApprovalRecord | null): Promise<ExecutionDecision> {
    if (this.yolo) return { decision: "approve", token: newToken(), cacheForSession: false };

    if (approval && approval.hash !== tool.manifest.hash) {
      const r = await this.prompter.promptGate23(tool, args, riskTier(tool.manifest.permissions, this.workspace));
      return r;
    }

    const tier = riskTier(tool.manifest.permissions, this.workspace);
    const cacheKey = tool.manifest.hash;

    if (tier === "low") return { decision: "approve", token: newToken(), cacheForSession: false };

    if (approval?.alwaysApprove) return { decision: "approve", token: newToken(), cacheForSession: false };

    if (this.sessionCache.get(cacheKey)) return { decision: "approve", token: newToken(), cacheForSession: false };

    const r = await this.prompter.promptGate23(tool, args, tier);
    if (r.decision === "approve" && r.cacheForSession) this.sessionCache.set(cacheKey, true);
    return r;
  }
}

function newToken(): ApprovalToken {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
