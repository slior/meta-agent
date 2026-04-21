import type { ToolSummary } from "../types.ts";
import { TOOL_DRAFT_SCHEMA } from "../schemas.ts";

export const DRAFT_SCHEMA = TOOL_DRAFT_SCHEMA;

export function atomicPrompt(req: { intent: string; rationale: string; existingToolsConsidered: string[]; catalog: ToolSummary[] }): string {
  const cat = req.catalog.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  return `You are authoring a single TypeScript tool for a meta-agent system.
Constraints:
- The tool file exports exactly one async function named \`run\` that takes a typed input and returns a JSON-serializable value.
- The tool runs in a sandboxed Node subprocess with a strict permission manifest you must declare accurately.
- Only \`node:*\` builtins are importable (no npm packages).
- Do not use eval or the Function constructor.
- Do not call invokeTool — this is an atomic tool, not a composite.
- Declare only the minimum fsRead/fsWrite/net/env permissions the tool actually needs.
- Provide a valid JSON Schema for input and output.
- Provide a smokeTestInput matching your inputSchema that the system can use to verify the tool works.
- Pick a kebab-case name that is unique (not in the existing tools listed below) and descriptive of the capability.

Existing tools (do not duplicate):
${cat || "(none)"}

Agent intent: ${req.intent}
Rationale: ${req.rationale}
Already considered: ${req.existingToolsConsidered.join(", ") || "(none)"}

Return a ToolDraft matching the provided JSON schema. kind must be "atomic".`;
}

export function compositePrompt(req: { name: string; intent: string; plannedSteps: Array<{ tool: string; argsTemplate: string }>; catalog: ToolSummary[] }): string {
  const cat = req.catalog.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const steps = req.plannedSteps.map((s, i) => `${i + 1}. ${s.tool}(${s.argsTemplate})`).join("\n");
  return `You are authoring a composite TypeScript tool that orchestrates existing tools via invokeTool.
Constraints:
- Export \`async function run(input)\`.
- Call existing tools via the global \`invokeTool(name, args)\`. Do NOT reimplement their logic.
- Keep the code to thin orchestration: validate input, call tools, pass outputs along.
- Only \`node:*\` builtins are importable; no other imports are needed for pure composition.
- The \`dependencies\` array must exactly match the set of tool names passed to invokeTool.
- Declare only permissions the composite itself needs outside of invokeTool calls (usually none).
- Return a ToolDraft with kind="composite".

Tools available:
${cat}

Name: ${req.name}
Intent: ${req.intent}
Planned steps:
${steps}
`;
}

export function reactivePrompt(req: { sliceDescription: string; intent: string; name: string; catalog: ToolSummary[] }): string {
  return `You are authoring a composite TypeScript tool that reproduces the following successful session slice as a single reusable tool.

${compositePrompt({ name: req.name, intent: req.intent, plannedSteps: [], catalog: req.catalog })}

Original session slice (for reference):
${req.sliceDescription}

Identify the variable parts of the slice's inputs and make them parameters of the new tool's inputSchema. Stable parts can be baked in as defaults.`;
}

export function repairPrompt(previousDraft: unknown, errors: string[]): string {
  return `Your previous ToolDraft failed validation with the following errors:
${errors.map((e) => `- ${e}`).join("\n")}

Previous draft:
${JSON.stringify(previousDraft, null, 2)}

Produce a corrected ToolDraft matching the schema.`;
}
