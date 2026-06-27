import type { ApprovalRecord, ApprovalToken, Permissions, Tool, ToolDraft, ToolManifest, ToolResult } from "../types.ts";
import type { Workflow } from "../workflow/types.ts";

/** Discriminator values for {@link Gate1Decision} and {@link ExecutionDecision}. */
export const APPROVAL_DECISION = {
  APPROVE: "approve",
  REJECT: "reject",
} as const;

/** Discriminator values for {@link Gate1ReviewPayload} and {@link Gate1Decision} unions. */
export const GATE1_KIND = {
  CODE: "code",
  WORKFLOW: "workflow",
} as const;

export type Gate1Kind = (typeof GATE1_KIND)[keyof typeof GATE1_KIND];

/**
 * Gate 1 review payload for a code-generated tool (atomic or composite).
 * Carries the full ToolDraft and the sandboxed smoke-test result shown to the reviewer.
 */
export type CodeGate1Payload = {
  kind: typeof GATE1_KIND.CODE;
  draft: ToolDraft;
  smoke: ToolResult;
};

/**
 * Gate 1 review payload for a deterministically lifted workflow tool.
 * Carries the workflow IR, its manifest, the unioned effective permissions of all steps,
 * and a human-readable literate rendering of the workflow.
 */
export type WorkflowGate1Payload = {
  kind: typeof GATE1_KIND.WORKFLOW;
  workflow: Workflow;
  /** Manifest produced by the lifter (name, description, inputSchema, hash, permissions). */
  manifest: ToolManifest;
  /** Union of all step-dependency permissions (bubbled-up set shown to reviewer). */
  effectivePermissions: Permissions;
  /** Output of `renderLiterate(workflow)` — step-by-step human-readable description. */
  literateRendering: string;
};

/** Discriminated union of Gate 1 review payloads. Passed to {@link ApprovalPolicy.reviewDraft}. */
export type Gate1ReviewPayload = CodeGate1Payload | WorkflowGate1Payload;

/**
 * Gate 1 decision returned for a code tool.
 * - approve: optionally always-approve future executions; optionally carry an edited draft.
 * - reject: reason shown to the agent.
 */
export type CodeGate1Decision =
  | { kind: typeof GATE1_KIND.CODE; decision: typeof APPROVAL_DECISION.APPROVE; alwaysApprove: boolean; notes?: string; editedDraft?: ToolDraft }
  | { kind: typeof GATE1_KIND.CODE; decision: typeof APPROVAL_DECISION.REJECT; reason: string };

/**
 * Gate 1 decision returned for a workflow tool.
 * - approve: optionally always-approve; optionally carry edited name/description.
 * - reject: reason shown to the agent.
 */
export type WorkflowGate1Decision =
  | { kind: typeof GATE1_KIND.WORKFLOW; decision: typeof APPROVAL_DECISION.APPROVE; alwaysApprove: boolean; notes?: string; editedName?: string; editedDescription?: string }
  | { kind: typeof GATE1_KIND.WORKFLOW; decision: typeof APPROVAL_DECISION.REJECT; reason: string };

/** Discriminated union of Gate 1 decisions. Returned from {@link ApprovalPolicy.reviewDraft}. */
export type Gate1Decision = CodeGate1Decision | WorkflowGate1Decision;

/**
 * Represents the possible outcomes of an execution approval decision (Gate 2/3).
 *
 * - If `decision` is `"approve"`:
 *    - `token`: An {@link ApprovalToken} that authorizes the tool execution.
 *    - `cacheForSession`: If true, the approval decision may be cached for the session.
 *
 * - If `decision` is `"reject"`:
 *    - `reason`: Explanation for rejection.
 */
export type ExecutionDecision =
  | { decision: typeof APPROVAL_DECISION.APPROVE; token: ApprovalToken; cacheForSession: boolean }
  | { decision: typeof APPROVAL_DECISION.REJECT; reason: string };

/** Risk levels for execution prompts (promptGate23). */
export const RISK_TIER = {
  LOW: "low",
  MEDIUM: "medium",
  ELEVATED: "elevated",
} as const;

export type RiskTier = (typeof RISK_TIER)[keyof typeof RISK_TIER];

/**
 * Interface for orchestrating approval prompts at different gates of the tool execution lifecycle.
 */
export interface ApprovalPrompter {
  /**
   * Prompt the user for review and approval at Gate 1 (tool creation).
   *
   * @param payload - Discriminated union: code draft + smoke result, or workflow IR + permissions.
   * @returns A Promise resolving to a {@link Gate1Decision} whose `kind` matches `payload.kind`.
   */
  promptGate1(payload: Gate1ReviewPayload): Promise<Gate1Decision>;

  /**
   * Prompt the user (or approval agent) for approval before executing a tool (Gate 2/3).
   */
  promptGate23(tool: Tool, args: unknown, tier: RiskTier): Promise<ExecutionDecision>;
}

/**
 * Interface defining the policy logic for tool approval and execution gating.
 */
export interface ApprovalPolicy {
  /**
   * Review a tool creation payload at Gate 1.
   *
   * @param payload - Discriminated union describing the tool being reviewed.
   * @returns A Promise resolving to a {@link Gate1Decision} whose `kind` matches `payload.kind`.
   */
  reviewDraft(payload: Gate1ReviewPayload): Promise<Gate1Decision>;

  /**
   * Check if a tool execution should be permitted at runtime (Gate 2/3).
   */
  checkExecution(tool: Tool, args: unknown, approval: ApprovalRecord | null): Promise<ExecutionDecision>;

  /**
   * If true, the policy auto-approves everything (yolo mode).
   */
  readonly yolo: boolean;
}
