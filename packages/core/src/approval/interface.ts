import type { ApprovalRecord, ApprovalToken, Tool, ToolDraft, ToolResult } from "../types.ts";

/** Discriminator values for {@link Gate1Decision} and {@link ExecutionDecision}. */
export const APPROVAL_DECISION = {
  approve: "approve",
  reject: "reject",
} as const;

/**
 * Represents the possible decisions returned from the first approval gate (Gate 1) during tool onboarding or review.
 *
 * - If `decision` is `"approve"`:
 *    - `alwaysApprove`: Indicates if future instances should be auto-approved without manual review.
 *    - `notes` (optional): Reviewer comments or justifications.
 *    - `editedDraft` (optional): A possibly edited version of the tool draft suggested by the reviewer.
 *
 * - If `decision` is `"reject"`:
 *    - `reason`: Explanation for why the draft/tool was rejected.
 */
export type Gate1Decision =
  | { decision: typeof APPROVAL_DECISION.approve; alwaysApprove: boolean; notes?: string; editedDraft?: ToolDraft }
  | { decision: typeof APPROVAL_DECISION.reject; reason: string };

/**
 * Represents the possible outcomes of an execution approval decision (Gate 2/3).
 *
 * - If `decision` is `"approve"`:
 *    - `token`: An {@link ApprovalToken} that authorizes the tool execution and can be used for auditing or further gating.
 *    - `cacheForSession`: If true, indicates that the approval decision may be cached for the remainder of the session to streamline repeated approvals.
 *
 * - If `decision` is `"reject"`:
 *    - `reason`: Explanation for rejection of the execution request (e.g., risk, policy, user denial).
 */
export type ExecutionDecision =
  | { decision: typeof APPROVAL_DECISION.approve; token: ApprovalToken; cacheForSession: boolean }
  | { decision: typeof APPROVAL_DECISION.reject; reason: string };

/** Risk levels for execution prompts (promptGate23). */
export const RISK_TIER = {
  low: "low",
  medium: "medium",
  elevated: "elevated",
} as const;

export type RiskTier = (typeof RISK_TIER)[keyof typeof RISK_TIER];

/**
 * Interface for orchestrating approval prompts at different gates of the tool execution lifecycle.
 *
 * This allows a human or automated agent (UI, CLI, or even an LLM) to approve, reject, or review tool onboarding (Gate 1)
 * as well as tool execution (Gates 2/3), typically by interacting with a user and returning a decision object.
 */
export interface ApprovalPrompter {
  /**
   * Prompt the user for review and approval of a ToolDraft during onboarding or initial review (Gate 1).
   *
   * @param draft - The ToolDraft object representing the candidate tool configuration.
   * @param smokeTest - The ToolResult object with results of basic code analysis or dry-run checks on the draft.
   * @returns A Promise resolving to a Gate1Decision, indicating approval, alwaysApprove preference, optional edits, or rejection rationale.
   */
  promptGate1(draft: ToolDraft, smokeTest: ToolResult): Promise<Gate1Decision>;

  /**
   * Prompt the user (or approval agent) for approval before executing a tool (Gate 2/3). Usually used to implement runtime risk gating or user confirmation.
   *
   * @param tool - The Tool instance about to be executed.
   * @param args - The arguments that will be provided to the tool upon execution.
   * @param tier - The assessed risk tier for the execution (low, medium, or elevated).
   * @returns A Promise resolving to an ExecutionDecision object, indicating approval (possibly with a token) or rejection and its rationale.
   */
  promptGate23(tool: Tool, args: unknown, tier: RiskTier): Promise<ExecutionDecision>;
}

/**
 * Interface defining the policy logic for tool approval and execution gating.
 *
 * Implementations of ApprovalPolicy encapsulate the rules used to:
 *   - review and approve tool drafts during onboarding (Gate 1)
 *   - verify or bypass execution of tools at runtime (Gate 2/3)
 *
 * Methods:
 * - reviewDraft: Reviews a ToolDraft and its smoke test results, returning a Gate1Decision
 *   (e.g., approve, request edits, or reject).
 * - checkExecution: Decides whether an execution of a given tool with specific arguments
 *   should be allowed, based on the tool, arguments, and (optional) prior approval.
 * - yolo: If true, indicates that the policy bypasses gating for all approvals (auto-approve mode).
 */
export interface ApprovalPolicy {
  /**
   * Review a tool draft and its smoke test output to determine if it should be approved for onboarding (Gate 1).
   * @param draft - The ToolDraft object representing the candidate tool.
   * @param smokeTest - The ToolResult summarizing checks on the draft.
   * @returns A Promise resolving to a Gate1Decision (approval, request edits, or rejection).
   */
  reviewDraft(draft: ToolDraft, smokeTest: ToolResult): Promise<Gate1Decision>;

  /**
   * Check if a tool execution should be permitted, generally used at runtime (Gate 2/3).
   * @param tool - The Tool instance to be executed.
   * @param args - The arguments provided to the tool.
   * @param approval - An optional ApprovalRecord with prior approval information, or null if none.
   * @returns A Promise resolving to an ExecutionDecision (approve or reject).
   */
  checkExecution(tool: Tool, args: unknown, approval: ApprovalRecord | null): Promise<ExecutionDecision>;

  /**
   * Indicates if the policy is in 'yolo' (auto-approve/everything allowed) mode.
   * If true, all checks are bypassed and approvals are always granted.
   */
  readonly yolo: boolean;
}
