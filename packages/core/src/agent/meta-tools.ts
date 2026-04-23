import type { ToolDef } from "../llm/interface.ts";

/** LLM-visible names for meta-tool functions; must stay aligned with {@link META_TOOL_DEFS}. */
export const META_FN = {
  findTool: "find_tool",
  listTools: "list_tools",
  invokeTool: "invoke_tool",
  proposeNewTool: "propose_new_tool",
  proposeCompositeTool: "propose_composite_tool",
  stop: "stop",
} as const;

/** Union of {@link META_FN} string values. */
export type MetaFnName = (typeof META_FN)[keyof typeof META_FN];

/**
 * Bounds and default for {@link META_FN.findTool}'s `k` in the JSON schema.
 * Runtime default when the model omits `k` must match {@link FIND_TOOL_TOP_K.default}.
 */
export const FIND_TOOL_TOP_K = {
  min: 1,
  max: 20,
  default: 5,
} as const;

function metaToolDef(name: MetaFnName, description: string, parameters: Record<string, unknown>): ToolDef {
  return {
    type: "function",
    function: { name, description, parameters },
  };
}

export const META_TOOL_DEFS: ToolDef[] = [
  metaToolDef(META_FN.findTool, "Search the tool registry by natural-language query. Returns ranked candidates.", {
    type: "object",
    properties: {
      query: { type: "string" },
      k: {
        type: "integer",
        minimum: FIND_TOOL_TOP_K.min,
        maximum: FIND_TOOL_TOP_K.max,
        default: FIND_TOOL_TOP_K.default,
      },
    },
    required: ["query"],
    additionalProperties: false,
  }),
  metaToolDef(META_FN.listTools, "Return the full catalog of tools (name + short description).", {
    type: "object",
    properties: {},
    additionalProperties: false,
  }),
  metaToolDef(META_FN.invokeTool, "Invoke an existing tool by name with the given args.", {
    type: "object",
    properties: {
      name: { type: "string" },
      args: {},
    },
    required: ["name", "args"],
    additionalProperties: false,
  }),
  metaToolDef(
    META_FN.proposeNewTool,
    `Request authoring of a new atomic tool. Requires at least one prior ${META_FN.findTool} call this task.`,
    {
      type: "object",
      properties: {
        intent: { type: "string" },
        rationale: { type: "string" },
        existingToolsConsidered: { type: "array", items: { type: "string" }, default: [] },
      },
      required: ["intent", "rationale"],
      additionalProperties: false,
    },
  ),
  metaToolDef(
    META_FN.proposeCompositeTool,
    `Request authoring of a new composite tool that chains existing tools via ${META_FN.invokeTool}.`,
    {
      type: "object",
      properties: {
        name: { type: "string" },
        intent: { type: "string" },
        plannedSteps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tool: { type: "string" },
              argsTemplate: { type: "string" },
            },
            required: ["tool", "argsTemplate"],
            additionalProperties: false,
          },
        },
      },
      required: ["name", "intent", "plannedSteps"],
      additionalProperties: false,
    },
  ),
  metaToolDef(META_FN.stop, "Signal that the current task is complete.", {
    type: "object",
    properties: { reason: { type: "string" } },
    additionalProperties: false,
  }),
];

export const META_TOOL_NAMES = new Set(META_TOOL_DEFS.map((t) => t.function.name));
