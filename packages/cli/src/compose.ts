import type { ToolFactory, Promotion } from "@meta-agent/core";
import type { ReadlinePromisesInterface } from "./approval-tui.ts";

/**
 * Represents a single invocation of a tool during a session.
 * @property name - The name of the tool invoked.
 * @property args - The arguments passed to the tool.
 * @property ok - Whether the invocation was successful.
 * @property value - (Optional) The resulting value from the tool invocation if successful.
 * @property binding - (Optional) A variable binding associated with the result, if any.
 */
export type InvocationRecord = {
  name: string;
  args: unknown;
  ok: boolean;
  value?: unknown;
  binding?: string;
};

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

  const liftSlice = slice.map((s) => ({ name: s.name, args: s.args, ok: s.ok, value: s.value ?? null, ...(s.binding !== undefined ? { binding: s.binding } : {}) }));

  const preview = await factory.previewWorkflow({ slice: liftSlice, name, intent, description });
  if (!preview.ok) { console.log(`rejected: ${preview.reason}`); return; }

  const promotions: Promotion[] = [];
  if (preview.literalFallbacks.length === 0) {
    console.log("(no literal arguments to parameterize)");
  } else {
    console.log("\nParameterize literal arguments (blank name = keep literal):");
    for (const fb of preview.literalFallbacks) {
      const preview1 = fb.canonicalValue.length > 80 ? fb.canonicalValue.slice(0, 80) + "..." : fb.canonicalValue;
      console.log(`  ${fb.stepLabel}.${fb.argName} = ${preview1}`);
      const paramName = (await rl.question("    Parameter name: ")).trim();
      if (!paramName) continue;
      const reqAns = (await rl.question("    Required? [y/N]: ")).trim().toLowerCase();
      const required = reqAns === "y" || reqAns === "yes";
      const desc = (await rl.question("    Description (optional): ")).trim();
      promotions.push({
        stepLabel: fb.stepLabel,
        argName: fb.argName,
        paramName,
        required,
        ...(desc ? { description: desc } : {}),
      });
    }
  }

  const out = await factory.createWorkflow({ slice: liftSlice, name, intent, description, promotions });
  console.log(out.ok ? `created workflow '${out.tool.manifest.name}'` : `rejected: ${out.reason}`);
}
