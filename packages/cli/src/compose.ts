import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ToolFactory } from "@meta-agent/core";

export type InvocationRecord = { name: string; args: unknown; ok: boolean };

export async function runComposeInteraction(
  factory: ToolFactory,
  invocations: InvocationRecord[],
): Promise<void> {
  if (invocations.length === 0) {
    console.log("(no tool invocations in this session)");
    return;
  }
  console.log("\nTool calls in this session:");
  invocations.forEach((inv, i) => {
    console.log(`  [${i + 1}] ${inv.name}(${JSON.stringify(inv.args)}) → ${inv.ok ? "ok" : "err"}`);
  });
  const rl = readline.createInterface({ input, output });
  try {
    const range = (await rl.question("Select a contiguous slice as 'a-b' (or blank to cancel): ")).trim();
    if (!range) return;
    const m = /^(\d+)-(\d+)$/.exec(range);
    if (!m) { console.log("invalid range"); return; }
    const a = parseInt(m[1]!, 10), b = parseInt(m[2]!, 10);
    if (a < 1 || b > invocations.length || a > b) { console.log("out of bounds"); return; }
    const slice = invocations.slice(a - 1, b);
    const name = (await rl.question("Name for the new composite: ")).trim();
    if (!name) { console.log("cancelled"); return; }
    const intent = (await rl.question("Intent (1-2 sentences): ")).trim();
    const sliceDescription = slice.map((s, i) => `${i + 1}. ${s.name}(${JSON.stringify(s.args)})`).join("\n");
    const out = await factory.createReactive({ name, intent, sliceDescription });
    console.log(out.ok ? `created composite '${out.tool.manifest.name}'` : `rejected: ${out.reason}`);
  } finally {
    rl.close();
  }
}
