import { PERMISSIONS_NET, type ApprovalRecord, type ApprovalToken, type Permissions, type Tool } from "../types.ts";
import {
  APPROVAL_DECISION,
  GATE1_KIND,
  type ApprovalPolicy,
  type ApprovalPrompter,
  type ExecutionDecision,
  type Gate1Decision,
  type Gate1ReviewPayload,
  RISK_TIER,
  type RiskTier,
} from "./interface.ts";

const SECRET_PATTERN = /TOKEN|KEY|SECRET|PASS/i;

/** Notes recorded on Gate 1 decisions when {@link TieredApprovalPolicy} runs in yolo mode. */
const YOLO_GATE1_NOTE = "yolo";

function pathOutsideWorkspace(path: string, workspace: string): boolean {
  const norm = path.replace(/\/+$/, "");
  const ws = workspace.replace(/\/+$/, "");
  return !(norm === ws || norm.startsWith(ws + "/"));
}

/**
 * Maps effective tool permissions and workspace scope to an execution risk tier for Gate 2/3 prompts.
 *
 * @param perms - Sandbox permissions declared on the tool manifest.
 * @param workspace - Absolute workspace root used to classify path grants.
 * @returns Assessed risk tier (`low`, `medium`, or `elevated`).
 */
export function riskTier(perms: Permissions, workspace: string): RiskTier {
  if (perms.net !== PERMISSIONS_NET.NONE) return RISK_TIER.ELEVATED;
  if (perms.fsWrite.some((p) => pathOutsideWorkspace(p, workspace))) return RISK_TIER.ELEVATED;
  if (perms.fsRead.some((p) => pathOutsideWorkspace(p, workspace))) return RISK_TIER.ELEVATED;
  if (perms.env.some((v) => SECRET_PATTERN.test(v))) return RISK_TIER.ELEVATED;
  if (perms.fsWrite.length > 0) return RISK_TIER.MEDIUM;
  if (perms.env.length > 0) return RISK_TIER.MEDIUM;
  return RISK_TIER.LOW;
}

/** Options for {@link TieredApprovalPolicy}. */
export type TieredOpts = {
  /** Absolute workspace root for path-scoped risk assessment. */
  workspace: string;
  /** When true, auto-approves Gate 1 and Gate 2/3 without prompting. */
  yolo?: boolean;
};

/**
 * Default {@link ApprovalPolicy}: tiered execution prompts with optional session caching,
 * hash-mismatch re-prompting, and yolo bypass mode.
 */
export class TieredApprovalPolicy implements ApprovalPolicy {
  readonly yolo: boolean;
  private readonly workspace: string;
  private readonly prompter: ApprovalPrompter;
  private readonly sessionCache = new Map<string, boolean>();

  /**
   * @param prompter - UI or test double that collects human Gate 1 / Gate 2/3 decisions.
   * @param opts - Workspace path and optional yolo flag.
   */
  constructor(prompter: ApprovalPrompter, opts: TieredOpts) {
    this.prompter = prompter;
    this.workspace = opts.workspace;
    this.yolo = !!opts.yolo;
  }

  /**
   * Gate 1 review for code or workflow creation payloads.
   *
   * @param payload - Discriminated Gate 1 review payload.
   * @returns Approve/reject decision whose `kind` matches `payload.kind`.
   */
  async reviewDraft(payload: Gate1ReviewPayload): Promise<Gate1Decision> {
    if (this.yolo) {
      return this.yoloGate1Decision(payload);
    }
    return this.prompter.promptGate1(payload);
  }

  /**
   * Gate 2/3 execution check: auto-approves low tier, honors `alwaysApprove` and session cache,
   * and prompts on elevated risk or missing/stale approval records.
   *
   * @param tool - Registered tool about to execute.
   * @param args - Invocation arguments shown to the reviewer when prompting.
   * @param approval - Prior Gate 1 approval record, or null when the tool has no saved approval.
   * @returns Approve (with token and optional session cache) or reject.
   */
  async checkExecution(tool: Tool, args: unknown, approval: ApprovalRecord | null): Promise<ExecutionDecision> {
    if (this.yolo) {
      return this.approveExecution(false);
    }

    if (approval === null || approval.hash !== tool.manifest.hash) {
      return this.promptExecution(tool, args);
    }

    const tier = riskTier(tool.manifest.permissions, this.workspace);
    const cacheKey = tool.manifest.hash;

    if (tier === RISK_TIER.LOW) {
      return this.approveExecution(false);
    }

    if (approval.alwaysApprove) {
      return this.approveExecution(false);
    }

    if (this.sessionCache.get(cacheKey)) {
      return this.approveExecution(false);
    }

    const decision = await this.promptExecution(tool, args, tier);
    if (decision.decision === APPROVAL_DECISION.APPROVE && decision.cacheForSession) {
      this.sessionCache.set(cacheKey, true);
    }
    return decision;
  }

  private yoloGate1Decision(payload: Gate1ReviewPayload): Gate1Decision {
    if (payload.kind === GATE1_KIND.CODE) {
      return {
        kind: GATE1_KIND.CODE,
        decision: APPROVAL_DECISION.APPROVE,
        alwaysApprove: true,
        notes: YOLO_GATE1_NOTE,
      };
    }
    else return {
      kind: GATE1_KIND.WORKFLOW,
      decision: APPROVAL_DECISION.APPROVE,
      alwaysApprove: false,
      notes: YOLO_GATE1_NOTE,
    };
  }

  /**
   * Grants approval for execution by generating an approval token.
   *
   * @param cacheForSession - Whether this approval should be cached for the session (bypassing further prompts for the same tool).
   * @returns An {@link ExecutionDecision} object with "approve" status, a new {@link ApprovalToken}, and the specified session cache flag.
   */
  private approveExecution(cacheForSession: boolean): ExecutionDecision {
    return { decision: APPROVAL_DECISION.APPROVE, token: newToken(), cacheForSession };
  }

  private promptExecution(tool: Tool, args: unknown, tier?: RiskTier): Promise<ExecutionDecision> {
    const resolvedTier = tier ?? riskTier(tool.manifest.permissions, this.workspace);
    return this.prompter.promptGate23(tool, args, resolvedTier);
  }
}

/**
 * Generates an opaque per-execution approval token passed to the sandbox on approve.
 *
 * Not cryptographically secure — fine here because the sandbox does not treat this as a secret
 * (it is an audit/hook identifier for an approved run in a local CLI session).
 */
function newToken(): ApprovalToken {
  /*
   * Concatenates a random base-36 fragment (`Math.random().toString(36).slice(2)`, dropping the
   * `"0."` prefix) with the current time in base-36. Together they make consecutive tokens in the
   * same process practically unique without crypto or extra dependencies.
   */
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
