import type { RiskTier } from "@meta-agent/core";
import { theme } from "./terminal-theme.ts";

/** Readline keys shown in approval choice prompts (bracket prefix before suffix text). */
export const APPROVAL_CHOICE_KEY = {
  approve: "a",
  alwaysApprove: "A",
  sessionApprove: "s",
  reject: "r",
} as const;

const CHOICE_SEPARATOR = " / ";
const CHOICE_PROMPT_SUFFIX = "? ";

const GATE1_HEADER = "GATE 1: Review new tool";
const GATE23_HEADER_PREFIX = "GATE 2/3:";

function choiceApprove(key: string, suffix: string, bold = false): string {
  const bracket = `[${key}]`;
  return (bold ? theme.okBold(bracket) : theme.ok(bracket)) + suffix;
}

function choiceSession(suffix: string): string {
  return theme.progressLabel(`[${APPROVAL_CHOICE_KEY.sessionApprove}]`) + suffix;
}

function choiceReject(suffix: string): string {
  return theme.fail(`[${APPROVAL_CHOICE_KEY.reject}]`) + suffix;
}

/**
 * Formats a labeled field for approval prompts.
 *
 * @param label - Field name (rendered dim).
 * @param value - Field content (plain body text).
 * @returns ANSI-colored `label: value` line.
 */
export function formatLabelValue(label: string, value: string): string {
  return `${theme.meta(`${label}: `)}${theme.progressBody(value)}`;
}

/**
 * Header line for Gate 2/3 execution approval.
 *
 * @param toolName - Manifest name of the tool awaiting execution.
 * @param tier - Assessed risk tier for this invocation.
 * @returns ANSI-colored section header for stderr/console output.
 */
export function formatGate23Header(toolName: string, tier: RiskTier): string {
  return theme.progressLabel(`\n=== ${GATE23_HEADER_PREFIX} ${toolName} (risk: ${tier}) ===`);
}

/**
 * Choice prompt for Gate 2/3.
 *
 * @returns Colored prompt listing approve-once, session-approve, and reject keys.
 */
export function formatGate23ChoicePrompt(): string {
  return [
    choiceApprove(APPROVAL_CHOICE_KEY.approve, "pprove-once"),
    CHOICE_SEPARATOR,
    choiceSession("ession-approve"),
    CHOICE_SEPARATOR,
    choiceReject("eject"),
    CHOICE_PROMPT_SUFFIX,
  ].join("");
}

/**
 * Header line for Gate 1 new-tool review.
 *
 * @returns ANSI-colored section header for stderr/console output.
 */
export function formatGate1Header(): string {
  return theme.progressLabel(`\n=== ${GATE1_HEADER} ===`);
}

/**
 * Choice prompt for Gate 1.
 *
 * @returns Colored prompt listing approve, always-approve, and reject keys.
 */
export function formatGate1ChoicePrompt(): string {
  return `\n${[
    choiceApprove(APPROVAL_CHOICE_KEY.approve, "pprove"),
    CHOICE_SEPARATOR,
    choiceApprove(APPROVAL_CHOICE_KEY.alwaysApprove, "lways-approve", true),
    CHOICE_SEPARATOR,
    choiceReject("eject"),
    CHOICE_PROMPT_SUFFIX,
  ].join("")}`;
}
