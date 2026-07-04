import type { Interface as ReadlinePromisesInterface } from "node:readline/promises";
import {
  APPROVAL_DECISION,
  GATE1_KIND,
  type ApprovalPrompter,
  type CodeGate1Payload,
  type ExecutionDecision,
  type Gate1Decision,
  type Gate1ReviewPayload,
  type RiskTier,
  type Tool,
  type ToolDraft,
  type ToolResult,
  type WorkflowGate1Decision,
  type WorkflowGate1Payload,
} from "@meta-agent/core";
import {
  APPROVAL_CHOICE_KEY,
  formatGate1ChoicePrompt,
  formatGate1Header,
  formatGate1WorkflowChoicePrompt,
  formatGate1WorkflowHeader,
  formatGate23ChoicePrompt,
  formatGate23Header,
  formatLabelValue,
} from "./approval-format.ts";
import { formatArgsTable, formatPermissionsTable, formatWorkflowInputSchema } from "./approval-display.ts";
import { theme } from "./terminal-theme.ts";

/** Full-word Gate 1 reject answer (in addition to {@link APPROVAL_CHOICE_KEY.reject}). */
const GATE1_REJECT_ANSWER = "reject";

/** Full-word Gate 1 always-approve answer (in addition to {@link APPROVAL_CHOICE_KEY.alwaysApprove}). */
const GATE1_ALWAYS_APPROVE_ANSWER = "always-approve";

/** Full-word Gate 1 edit-meta answer (in addition to {@link APPROVAL_CHOICE_KEY.editMeta}). */
const GATE1_EDIT_META_ANSWER = "edit";

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

function isEditMetaAnswer(answer: string): boolean {
  const trimmed = answer.trim();
  return trimmed === APPROVAL_CHOICE_KEY.editMeta || trimmed === GATE1_EDIT_META_ANSWER;
}

function isSessionApproveAnswer(answer: string): boolean {
  const trimmed = answer.trim();
  const { sessionApprove } = APPROVAL_CHOICE_KEY;
  return trimmed === sessionApprove || trimmed === sessionApprove.toUpperCase();
}

function printGate1Review(draft: ToolDraft, smokeTest: ToolResult): void {
  console.log(formatGate1Header());
  console.log(formatLabelValue("Name", draft.name));
  console.log(formatLabelValue("Kind", draft.kind));
  console.log(formatLabelValue("Description", draft.description));
  console.log(formatLabelValue("Rationale", draft.rationale));
  console.log(formatLabelValue("Input schema", JSON.stringify(draft.inputSchema)));
  console.log(formatLabelValue("Output shape", JSON.stringify(draft.outputShape)));
  console.log(formatPermissionsTable(draft.permissions));
  if (draft.dependencies.length) {
    console.log(formatLabelValue("Dependencies", draft.dependencies.join(", ")));
  }
  console.log(theme.meta("\n--- CODE ---"));
  console.log(theme.progressBody(draft.code));
  console.log(theme.meta("--- /CODE ---"));
  console.log(formatLabelValue("\nSmoke test input", JSON.stringify(draft.smokeTestInput)));
  console.log(formatLabelValue("Smoke test result", JSON.stringify(smokeTest)));
}

function printWorkflowGate1Review(payload: WorkflowGate1Payload): void {
  console.log(formatGate1WorkflowHeader());
  console.log(formatLabelValue("Name", payload.manifest.name));
  console.log(formatLabelValue("Description", payload.manifest.description));
  console.log(formatWorkflowInputSchema(payload.manifest.inputSchema as Record<string, unknown>));
  console.log(formatPermissionsTable(payload.effectivePermissions));
  console.log(theme.meta("\n--- WORKFLOW STEPS ---"));
  console.log(theme.progressBody(payload.literateRendering));
  console.log(theme.meta("--- /WORKFLOW STEPS ---\n"));
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
   * Shows a tool creation review and collects Gate 1 approval for code or workflow tools.
   *
   * @param payload - Discriminated Gate 1 review payload.
   * @returns Approve (optionally always-approve) or reject with reason.
   */
  async promptGate1(payload: Gate1ReviewPayload): Promise<Gate1Decision> {
    if (payload.kind === GATE1_KIND.WORKFLOW) {
      return this.promptGate1Workflow(payload);
    } else {
      return this.promptGate1Code(payload);
    }
  }

  private async promptGate1Code(payload: CodeGate1Payload): Promise<Gate1Decision> {
    printGate1Review(payload.draft, payload.smoke);
    const answer = (await this.rl.question(formatGate1ChoicePrompt())).trim();
    if (isGate1RejectAnswer(answer)) {
      const reason = (await this.rl.question(theme.meta("Reason: "))).trim() || GATE1_DEFAULT_REJECT_REASON;
      return { kind: GATE1_KIND.CODE, decision: APPROVAL_DECISION.REJECT, reason };
    }
    return {
      kind: GATE1_KIND.CODE,
      decision: APPROVAL_DECISION.APPROVE,
      alwaysApprove: isAlwaysApproveAnswer(answer),
    };
  }

  /** Gate 1 workflow review: shows IR, permissions, and input schema; supports edit name/desc. */
  private async promptGate1Workflow(payload: WorkflowGate1Payload): Promise<WorkflowGate1Decision> {
    printWorkflowGate1Review(payload);

    const answer = (await this.rl.question(formatGate1WorkflowChoicePrompt())).trim();

    if (isGate1RejectAnswer(answer)) {
      const reason = (await this.rl.question(theme.meta("Reason: "))).trim() || GATE1_DEFAULT_REJECT_REASON;
      return { kind: GATE1_KIND.WORKFLOW, decision: APPROVAL_DECISION.REJECT, reason };
    }

    if (isEditMetaAnswer(answer)) {
      const rawName = (await this.rl.question(theme.meta(`Name [${payload.manifest.name}]: `))).trim();
      const rawDesc = (await this.rl.question(theme.meta(`Description [${payload.manifest.description}]: `))).trim();
      return {
        kind: GATE1_KIND.WORKFLOW,
        decision: APPROVAL_DECISION.APPROVE,
        alwaysApprove: false,
        ...(rawName ? { editedName: rawName } : {}),
        ...(rawDesc ? { editedDescription: rawDesc } : {}),
      };
    }

    return {
      kind: GATE1_KIND.WORKFLOW,
      decision: APPROVAL_DECISION.APPROVE,
      alwaysApprove: isAlwaysApproveAnswer(answer),
    };
  }

  /**
   * Shows tool execution details and collects Gate 2/3 approval.
   *
   * @param tool - Registered tool whose invocation is awaiting approval.
   * @param args - Serialized invocation arguments shown to the reviewer.
   * @param tier - Assessed risk tier for this execution.
   * @returns Approve (with session cache flag) or reject.
   */
  async promptGate23(tool: Tool, args: unknown, tier: RiskTier): Promise<ExecutionDecision> {
    console.log(formatGate23Header(tool.manifest.name, tier));
    console.log(formatArgsTable(args));
    console.log(formatPermissionsTable(tool.manifest.permissions));

    const answer = (await this.rl.question(formatGate23ChoicePrompt())).trim();
    if (isRejectKey(answer)) {
      return { decision: APPROVAL_DECISION.REJECT, reason: GATE23_REJECT_REASON };
    }
    return {
      decision: APPROVAL_DECISION.APPROVE,
      cacheForSession: isSessionApproveAnswer(answer),
    };
  }
}
