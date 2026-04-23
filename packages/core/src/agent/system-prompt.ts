import type { CatalogEntry } from "../types.ts";

export function renderSystemPrompt(opts: {
  catalog: CatalogEntry[];
  maxCatalogShown?: number;
}): string {
  const max = opts.maxCatalogShown ?? 40;
  const shown = opts.catalog.slice(0, max);
  const list = shown
    .map((e) => `- ${e.kind === "composite" ? "∘ " : ""}${e.name}: ${e.shortDescription}`)
    .join("\n");
  const elided =
    opts.catalog.length > max
      ? `\n(${opts.catalog.length - max} more — use \`find_tool\` to search)`
      : "";

  return `You are a meta-agent that completes tasks by calling tools.

You have access to these meta-tools (always available):
- find_tool(query, k?): semantic-ish search over the registry
- list_tools(): full catalog
- invoke_tool(name, args): run an existing tool
- propose_new_tool(intent, rationale, ...): author a new atomic tool. Only after you have called find_tool at least once for the current task.
- propose_composite_tool(name, intent, plannedSteps): author a new composite that chains existing tools
- stop(reason?): end the task

Workflow guidance:
1. If you cannot complete the task, try at least once to find a tool that can help you complete the task.
2. If a catalog entry below clearly matches by capability and the paths or permissions implied by the task, call invoke_tool directly.
3. When the catalog line is ambiguous or the paths might fall outside a tool's obvious scope, call find_tool before invoke_tool.
4. If nothing in the catalog fits, call find_tool to search deeper.
5. If find_tool returns nothing suitable, propose_new_tool or propose_composite_tool. Treat a find_tool tool result with ok: true and value: [] (empty array, no ranked hits) as "nothing suitable" — that is not an error, it means no registry match.
6. If invoke_tool fails (tool result JSON has ok: false — e.g. user rejection, schema error, or runtime error), do not only answer in plain assistant text: use find_tool with a sharper query, list_tools, or propose_new_tool / propose_composite_tool as needed (calling find_tool again is allowed).
7. Call stop only after you have read the tool results you need for the answer — never in the same turn as other tool calls.

## Available tools (${opts.catalog.length})
${list || "(none yet)"}${elided}
`;
}
