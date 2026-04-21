import type { ToolDef } from "../llm/interface.ts";

export const META_TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "find_tool",
      description: "Search the tool registry by natural-language query. Returns ranked candidates.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          k: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tools",
      description: "Return the full catalog of tools (name + short description).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "invoke_tool",
      description: "Invoke an existing tool by name with the given args.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          args: {},
        },
        required: ["name", "args"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_new_tool",
      description:
        "Request authoring of a new atomic tool. Requires at least one prior find_tool call this task.",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string" },
          rationale: { type: "string" },
          existingToolsConsidered: { type: "array", items: { type: "string" }, default: [] },
        },
        required: ["intent", "rationale"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_composite_tool",
      description:
        "Request authoring of a new composite tool that chains existing tools via invokeTool.",
      parameters: {
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
    },
  },
  {
    type: "function",
    function: {
      name: "stop",
      description: "Signal that the current task is complete.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
];

export const META_TOOL_NAMES = new Set(META_TOOL_DEFS.map((t) => t.function.name));
