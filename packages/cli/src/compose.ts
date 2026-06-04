import type { ToolFactory } from "@meta-agent/core";
import type { ReadlinePromisesInterface } from "./approval-tui.ts";

export type InvocationRecord = { name: string; args: unknown; ok: boolean; value?: unknown };

export async function runComposeInteraction(
  factory: ToolFactory,
  invocations: InvocationRecord[],
  rl: ReadlinePromisesInterface,
): Promise<void> {
  if (invocations.length === 0) {
    console.log("(no tool invocations in this session)");
    return;
  }
  console.log("\nTool calls in this session:");
  invocations.forEach((inv, i) => {
    const valueStr = inv.ok && inv.value !== undefined ? `→ ${JSON.stringify(inv.value).slice(0, 60)}` : "";
    console.log(`  [${i + 1}] ${inv.name}(${JSON.stringify(inv.args)}) ${inv.ok ? "ok" : "err"} ${valueStr}`);
  });
  const range = (await rl.question("Select a contiguous slice as 'a-b' (or blank to cancel): ")).trim();
  if (!range) return;
  const m = /^(\d+)-(\d+)$/.exec(range);
  if (!m) { console.log("invalid range"); return; }
  const a = parseInt(m[1]!, 10), b = parseInt(m[2]!, 10);
  if (a < 1 || b > invocations.length || a > b) { console.log("out of bounds"); return; }
  const slice = invocations.slice(a - 1, b);
  const name = (await rl.question("Name for the new workflow: ")).trim();
  if (!name) { console.log("cancelled"); return; }
  const intent = (await rl.question("Intent (1-2 sentences): ")).trim();
  const description = (await rl.question("Description: ")).trim();
  
  // Use the new workflow creation path (deterministic lift, no LLM)
  const out = await factory.createWorkflow({ 
    slice: slice.map(s => ({ name: s.name, args: s.args, ok: s.ok, value: s.value ?? null })), 
    name, 
    intent, 
    description 
  });
  console.log(out.ok ? `created workflow '${out.tool.manifest.name}'` : `rejected: ${out.reason}`);
}
