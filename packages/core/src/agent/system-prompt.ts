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
1. If a catalog entry below clearly matches, call invoke_tool directly.
2. If nothing in the catalog fits, call find_tool to search deeper.
3. If find_tool returns nothing suitable, propose_new_tool or propose_composite_tool.

## Available tools (${opts.catalog.length})
${list || "(none yet)"}${elided}
`;
}
