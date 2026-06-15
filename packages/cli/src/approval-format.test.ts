import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatGate1ChoicePrompt,
  formatGate1Header,
  formatGate23ChoicePrompt,
  formatGate23Header,
  formatLabelValue,
} from "./approval-format.ts";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("formatGate23Header includes tool name and tier", () => {
  const plain = stripAnsi(formatGate23Header("fetch_url", "medium"));
  assert.match(plain, /GATE 2\/3/);
  assert.match(plain, /fetch_url/);
  assert.match(plain, /medium/);
});

test("formatLabelValue separates label and value", () => {
  const plain = stripAnsi(formatLabelValue("Args", '{"url":"x"}'));
  assert.match(plain, /Args:/);
  assert.match(plain, /"url"/);
});

test("formatGate23ChoicePrompt includes all choices", () => {
  const plain = stripAnsi(formatGate23ChoicePrompt());
  assert.match(plain, /\[a\]pprove-once/);
  assert.match(plain, /\[s\]ession-approve/);
  assert.match(plain, /\[r\]eject/);
  assert.ok(plain.endsWith("? "));
});

test("formatGate1ChoicePrompt includes all choices", () => {
  const plain = stripAnsi(formatGate1ChoicePrompt());
  assert.match(plain, /\[a\]pprove/);
  assert.match(plain, /\[A\]lways-approve/);
  assert.match(plain, /\[r\]eject/);
});

test("formatGate1Header", () => {
  const plain = stripAnsi(formatGate1Header());
  assert.match(plain, /GATE 1/);
});
