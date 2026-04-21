import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type {
  ApprovalPrompter,
  ExecutionDecision,
  Gate1Decision,
  RiskTier,
  Tool,
  ToolDraft,
  ToolResult,
} from "@meta-agent/core";

export class CliApprovalPrompter implements ApprovalPrompter {
  async promptGate1(draft: ToolDraft, smokeTest: ToolResult): Promise<Gate1Decision> {
    const rl = readline.createInterface({ input, output });
    try {
      console.log("\n=== GATE 1: Review new tool ===");
      console.log(`Name:         ${draft.name}`);
      console.log(`Kind:         ${draft.kind}`);
      console.log(`Description:  ${draft.description}`);
      console.log(`Rationale:    ${draft.rationale}`);
      console.log("Input schema: " + JSON.stringify(draft.inputSchema));
      console.log("Output shape: " + JSON.stringify(draft.outputShape));
      console.log("Permissions:");
      console.log(`  fsRead:       [${draft.permissions.fsRead.join(", ")}]`);
      console.log(`  fsWrite:      [${draft.permissions.fsWrite.join(", ")}]`);
      console.log(`  net:          ${draft.permissions.net}`);
      console.log(`  netAllowlist: [${draft.permissions.netAllowlist.join(", ")}]`);
      console.log(`  env:          [${draft.permissions.env.join(", ")}]`);
      if (draft.dependencies.length) console.log(`Dependencies: ${draft.dependencies.join(", ")}`);
      console.log("\n--- CODE ---");
      console.log(draft.code);
      console.log("--- /CODE ---");
      console.log("\nSmoke test input:  " + JSON.stringify(draft.smokeTestInput));
      console.log("Smoke test result: " + JSON.stringify(smokeTest));

      const answer = (await rl.question("\n[a]pprove / [A]lways-approve / [r]eject? ")).trim();
      if (answer === "r" || answer === "R" || answer === "reject") {
        const reason = (await rl.question("Reason: ")).trim() || "rejected";
        return { decision: "reject", reason };
      }
      const always = answer === "A" || answer === "always-approve";
      return { decision: "approve", alwaysApprove: always };
    } finally {
      rl.close();
    }
  }

  async promptGate23(tool: Tool, args: unknown, tier: RiskTier): Promise<ExecutionDecision> {
    const rl = readline.createInterface({ input, output });
    try {
      console.log(`\n=== GATE 2/3: ${tool.manifest.name} (risk: ${tier}) ===`);
      console.log(`Args: ${JSON.stringify(args)}`);
      console.log(`Permissions: ${JSON.stringify(tool.manifest.permissions)}`);
      const answer = (await rl.question("[a]pprove-once / [s]ession-approve / [r]eject? ")).trim();
      if (answer === "r" || answer === "R") return { decision: "reject", reason: "user rejected" };
      const cache = answer === "s" || answer === "S";
      return { decision: "approve", token: Math.random().toString(36).slice(2), cacheForSession: cache };
    } finally {
      rl.close();
    }
  }
}
