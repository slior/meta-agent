import type { ApprovalRecord, ApprovalToken, Tool, ToolDraft, ToolResult } from "../types.ts";

export type Gate1Decision =
  | { decision: "approve"; alwaysApprove: boolean; notes?: string; editedDraft?: ToolDraft }
  | { decision: "reject"; reason: string };

export type ExecutionDecision =
  | { decision: "approve"; token: ApprovalToken; cacheForSession: boolean }
  | { decision: "reject"; reason: string };

export type RiskTier = "low" | "medium" | "elevated";

export interface ApprovalPrompter {
  promptGate1(draft: ToolDraft, smokeTest: ToolResult): Promise<Gate1Decision>;
  promptGate23(tool: Tool, args: unknown, tier: RiskTier): Promise<ExecutionDecision>;
}

export interface ApprovalPolicy {
  reviewDraft(draft: ToolDraft, smokeTest: ToolResult): Promise<Gate1Decision>;
  checkExecution(tool: Tool, args: unknown, approval: ApprovalRecord | null): Promise<ExecutionDecision>;
  readonly yolo: boolean;
}
