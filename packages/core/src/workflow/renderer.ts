import { canonicalJson } from "../hash.ts";
import type { Workflow, Argument } from "./types.ts";
import { ARG_KIND } from "./types.ts";

/**
 * Renders a Workflow object into a human-readable, literate string representation.
 *
 * This function provides a compact textual format showing each step, its arguments, and
 * associated result bindings. For each step, the arguments are listed as name=value pairs,
 * where values are rendered as either JSON values (for literals) or as references to previously
 * bound results (optionally resolved with their actual values from the provided environment map).
 *
 * Optionally, the function can take an environment mapping result bindings to their resolved values,
 * which, if present, will be displayed alongside references and step results.
 *
 * Example output:
 *   Workflow: example
 *     @r_0 = {...} ← tool_one(arg1=..., arg2=...)
 *     @r_1 ← tool_two(input=@r_0)
 *   Return: @r_1
 *
 * @param workflow The Workflow object to render.
 * @param env (Optional) A read-only map from result binding names to resolved values,
 *   used to show actual values in the output alongside symbolic references.
 * @returns A multiline string in a literate "pseudo-code" format describing the workflow.
 */
export function renderLiterate( workflow: Workflow, env?: ReadonlyMap<string, unknown>, ): string {
  const lines: string[] = [`Workflow: ${workflow.name}`];
  for (const step of workflow.steps) {
    const args = Object.entries(step.arguments)
      .map(([k, v]) => `${k}=${renderArg(v, env)}`)
      .join(", ");
    const binding = step.resultBinding ?? "_";
    const value = env?.has(binding) ? ` = ${canonicalJson(env.get(binding))}` : "";
    lines.push(`  @${binding}${value} ← ${step.tool}(${args})`);
  }
  if (workflow.return !== null) {
    lines.push(`Return: @${workflow.return.source.ref}`);
  }
  return lines.join("\n");
}

function renderArg(arg: Argument, env?: ReadonlyMap<string, unknown>): string {
  if (arg.kind === ARG_KIND.literal) {
    return JSON.stringify(arg.value);
  }
  const value = env?.get(arg.ref);
  if (value !== undefined) {
    return `@${arg.ref}=${canonicalJson(value)}`;
  }
  return `@${arg.ref}`;
}
