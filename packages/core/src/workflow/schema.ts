/**
 * JSON Schema for the LEAN-tier Workflow IR. Used by `parser.ts` to
 * structurally validate untrusted JSON before we treat it as a
 * `Workflow`. Higher-level checks (scope, uniqueness, registry
 * presence) live in `validator.ts`.
 */

/** JSON Schema for a workflow step argument (`literal` or `symref`). */
export const ARGUMENT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "literal" },
        value: {},
      },
      required: ["kind", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "symref" },
        ref: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
      },
      required: ["kind", "ref"],
      additionalProperties: false,
    },
  ],
} as const;

/** JSON Schema for a `tool_call` workflow step. */
export const TOOL_CALL_STEP_SCHEMA = {
  type: "object",
  properties: {
    kind: { const: "tool_call" },
    label: { type: "string", minLength: 1 },
    tool: { type: "string", minLength: 1 },
    arguments: {
      type: "object",
      additionalProperties: ARGUMENT_SCHEMA,
    },
    resultBinding: {
      oneOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    },
  },
  required: ["kind", "label", "tool", "arguments", "resultBinding"],
  additionalProperties: false,
} as const;

/** JSON Schema for a workflow `return` value (symref source or null). */
export const WORKFLOW_RETURN_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        source: {
          type: "object",
          properties: {
            kind: { const: "symref" },
            ref: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
          },
          required: ["kind", "ref"],
          additionalProperties: false,
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
    { type: "null" },
  ],
} as const;

/** JSON Schema for one declared workflow input. */
export const WORKFLOW_INPUT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    schema: { type: "object" },
    required: { type: "boolean" },
    default: {},
    description: { type: "string" },
  },
  required: ["name", "schema", "required"],
  additionalProperties: false,
} as const;

/** Top-level JSON Schema for a LEAN-tier {@link Workflow} document. */
export const WORKFLOW_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { const: 1 },
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    goal: { type: "string" },
    inputs: { type: "array", items: WORKFLOW_INPUT_SCHEMA },
    steps: { type: "array", items: TOOL_CALL_STEP_SCHEMA, minItems: 1 },
    return: WORKFLOW_RETURN_SCHEMA,
  },
  required: ["schemaVersion", "name", "description", "goal", "inputs", "steps", "return"],
  additionalProperties: false,
} as const;
