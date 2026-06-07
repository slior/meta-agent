import type { CatalogEntry } from "../types.ts";
import { META_FN } from "./meta-tools.ts";

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
      ? `\n(${opts.catalog.length - max} more — use \`${META_FN.findTool}\` to search)`
      : "";

  return `You are a meta-agent that completes tasks by calling tools.

You have access to these meta-tools (always available):
- ${META_FN.findTool}(query, k?): semantic-ish search over the registry
- ${META_FN.listTools}(): full catalog
- ${META_FN.invokeTool}(name, args): run an existing tool
- ${META_FN.proposeNewTool}(intent, rationale, ...): author a new atomic tool. Only after you have called ${META_FN.findTool} at least once for the current task.
- ${META_FN.proposeCompositeTool}(name, intent, plannedSteps): author a new composite that chains existing tools
- ${META_FN.stop}(reason?): end the task

Workflow guidance:
1. If you cannot complete the task, try at least once to find a tool that can help you complete the task.
2. If a catalog entry below clearly matches by capability and the paths or permissions implied by the task, call ${META_FN.invokeTool} directly.
3. When the catalog line is ambiguous or the paths might fall outside a tool's obvious scope, call ${META_FN.findTool} before ${META_FN.invokeTool}.
4. If nothing in the catalog fits, call ${META_FN.findTool} to search deeper.
5. If ${META_FN.findTool} returns nothing suitable, ${META_FN.proposeNewTool} or ${META_FN.proposeCompositeTool}. Treat a ${META_FN.findTool} tool result with ok: true and value: [] (empty array, no ranked hits) as "nothing suitable" — that is not an error, it means no registry match.
6. If ${META_FN.invokeTool} fails (tool result JSON has ok: false — e.g. user rejection, schema error, or runtime error), do not only answer in plain assistant text: use ${META_FN.findTool} with a sharper query, ${META_FN.listTools}, or ${META_FN.proposeNewTool} / ${META_FN.proposeCompositeTool} as needed (calling ${META_FN.findTool} again is allowed).
7. Call ${META_FN.stop} only after you have read the tool results you need for the answer — never in the same turn as other tool calls.
8. When a step's value must be produced by the model itself (summaries, rewrites, classification, extraction), call the \`llm_generate\` tool via ${META_FN.invokeTool} instead of writing that content inline. Put the task in \`instructions\` and the raw data to transform in \`input\`. When \`llm_generate\` follows another tool, pass that tool's return value as \`input\` unchanged (typically the full prior JSON)—do not pre-summarize, excerpt, or rewrite \`input\` in chat; that is \`llm_generate\`'s job. This keeps generated values as real tool results so they can be composed and reused.

## Available tools (${opts.catalog.length})
${list || "(none yet)"}${elided}
`;
}
