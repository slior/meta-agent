import type { Interface as ReadlinePromisesInterface } from "node:readline/promises";
import {
  APPROVAL_DECISION,
  type ApprovalPrompter,
  type ExecutionDecision,
  type Gate1Decision,
  type RiskTier,
  type Tool,
  type ToolDraft,
  type ToolResult,
} from "@meta-agent/core";
import {
  APPROVAL_CHOICE_KEY,
  formatGate1ChoicePrompt,
  formatGate1Header,
  formatGate23ChoicePrompt,
  formatGate23Header,
  formatLabelValue,
} from "./approval-format.ts";
import { theme } from "./terminal-theme.ts";

/** Full-word Gate 1 reject answer (in addition to {@link APPROVAL_CHOICE_KEY.reject}). */
const GATE1_REJECT_ANSWER = "reject";

/** Full-word Gate 1 always-approve answer (in addition to {@link APPROVAL_CHOICE_KEY.alwaysApprove}). */
const GATE1_ALWAYS_APPROVE_ANSWER = "always-approve";

const GATE1_DEFAULT_REJECT_REASON = "rejected";
const GATE23_REJECT_REASON = "user rejected";

function isRejectKey(answer: string): boolean {
  const trimmed = answer.trim();
  const { reject } = APPROVAL_CHOICE_KEY;
  return trimmed === reject || trimmed === reject.toUpperCase();
}

function isGate1RejectAnswer(answer: string): boolean {
  return isRejectKey(answer) || answer.trim() === GATE1_REJECT_ANSWER;
}

function isAlwaysApproveAnswer(answer: string): boolean {
  const trimmed = answer.trim();
  return trimmed === APPROVAL_CHOICE_KEY.alwaysApprove || trimmed === GATE1_ALWAYS_APPROVE_ANSWER;
}

function isSessionApproveAnswer(answer: string): boolean {
  const trimmed = answer.trim();
  const { sessionApprove } = APPROVAL_CHOICE_KEY;
  return trimmed === sessionApprove || trimmed === sessionApprove.toUpperCase();
}

function randomApprovalToken(): string {
  return Math.random().toString(36).slice(2);
}

function printGate1Review(draft: ToolDraft, smokeTest: ToolResult): void {
  console.log(formatGate1Header());
  console.log(formatLabelValue("Name", draft.name));
  console.log(formatLabelValue("Kind", draft.kind));
  console.log(formatLabelValue("Description", draft.description));
  console.log(formatLabelValue("Rationale", draft.rationale));
  console.log(formatLabelValue("Input schema", JSON.stringify(draft.inputSchema)));
  console.log(formatLabelValue("Output shape", JSON.stringify(draft.outputShape)));
  console.log(theme.meta("Permissions:"));
  console.log(formatLabelValue("  fsRead", `[${draft.permissions.fsRead.join(", ")}]`));
  console.log(formatLabelValue("  fsWrite", `[${draft.permissions.fsWrite.join(", ")}]`));
  console.log(formatLabelValue("  net", draft.permissions.net));
  console.log(formatLabelValue("  netAllowlist", `[${draft.permissions.netAllowlist.join(", ")}]`));
  console.log(formatLabelValue("  env", `[${draft.permissions.env.join(", ")}]`));
  if (draft.dependencies.length) {
    console.log(formatLabelValue("Dependencies", draft.dependencies.join(", ")));
  }
  console.log(theme.meta("\n--- CODE ---"));
  console.log(theme.progressBody(draft.code));
  console.log(theme.meta("--- /CODE ---"));
  console.log(formatLabelValue("\nSmoke test input", JSON.stringify(draft.smokeTestInput)));
  console.log(formatLabelValue("Smoke test result", JSON.stringify(smokeTest)));
}

/**
 * Re-export of Node's readline promises interface for typing CLI wiring (`repl`, `compose`).
 */
export type { ReadlinePromisesInterface };

/**
 * Terminal {@link ApprovalPrompter} that renders Gate 1 and Gate 2/3 prompts via readline.
 */
export class CliApprovalPrompter implements ApprovalPrompter {
  /**
   * @param rl - Readline interface used for colored prompts and user input.
   */
  constructor(private readonly rl: ReadlinePromisesInterface) {}

  /**
   * Shows a new-tool draft review and collects Gate 1 approval.
   *
   * @param draft - Proposed tool manifest and source from the factory.
   * @param smokeTest - Result of the factory smoke test shown in the review.
   * @returns Approve (optionally always-approve) or reject with reason.
   */
  async promptGate1(draft: ToolDraft, smokeTest: ToolResult): Promise<Gate1Decision> {
    printGate1Review(draft, smokeTest);

    const answer = (await this.rl.question(formatGate1ChoicePrompt())).trim();
    if (isGate1RejectAnswer(answer)) {
      const reason = (await this.rl.question(theme.meta("Reason: "))).trim() || GATE1_DEFAULT_REJECT_REASON;
      return { decision: APPROVAL_DECISION.reject, reason };
    }
    return {
      decision: APPROVAL_DECISION.approve,
      alwaysApprove: isAlwaysApproveAnswer(answer),
    };
  }

  /**
   * Shows tool execution details and collects Gate 2/3 approval.
   *
   * @param tool - Registered tool whose invocation is awaiting approval.
   * @param args - Serialized invocation arguments shown to the reviewer.
   * @param tier - Assessed risk tier for this execution.
   * @returns Approve (with session cache flag and token) or reject.
   */
  async promptGate23(tool: Tool, args: unknown, tier: RiskTier): Promise<ExecutionDecision> {
    console.log(formatGate23Header(tool.manifest.name, tier));
    console.log(formatLabelValue("Args", JSON.stringify(args)));
    console.log(formatLabelValue("Permissions", JSON.stringify(tool.manifest.permissions)));

    const answer = (await this.rl.question(formatGate23ChoicePrompt())).trim();
    if (isRejectKey(answer)) {
      return { decision: APPROVAL_DECISION.reject, reason: GATE23_REJECT_REASON };
    }
    return {
      decision: APPROVAL_DECISION.approve,
      token: randomApprovalToken(),
      cacheForSession: isSessionApproveAnswer(answer),
    };
  }
}
