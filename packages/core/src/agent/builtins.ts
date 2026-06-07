import { hashTool } from "../hash.ts";
import type { ApprovalRecord, Tool, ToolManifest } from "../types.ts";
import { PERMISSIONS_NET, SOURCE_LABEL, TOOL_CAPABILITY, TOOL_KIND } from "../types.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";

/** Registry name of the built-in LLM generation primitive. */
export const LLM_GENERATE_NAME = "llm_generate";

/** Fixed timestamp so the built-in hash is deterministic across processes. */
const BUILTIN_EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * Forwarder body. It performs no I/O itself — it round-trips a structured request
 * through the mediated `globalThis.llm` capability the sandbox parent services.
 */
const LLM_GENERATE_CODE = `export async function run(input) {
  const g = globalThis;
  if (typeof g.llm !== "function") throw new Error("llm capability not available");
  return await g.llm({ instructions: input.instructions, input: input.input, schema: input.outputSchema });
}
`;

/**
 * Builds and returns the built-in `llm_generate` tool as a manifest+code pair, ensuring a deterministic hash.
 *
 * This tool enables a workflow step to perform language model-backed value generation.
 * It takes instructions for the language model, an input (any JSON value), and optionally an output schema.
 * The tool returns the model's output, which is a string unless an `outputSchema` is provided, in which case
 * structured output is returned.
 *
 * The hash is computed deterministically using fixed code and metadata, ensuring the tool is
 * identical across agent processes and reproducible for security and caching.
 *
 * @returns {Tool} The `llm_generate` tool object containing its manifest (with hash) and source code.
 */
export function buildLlmGenerateTool(): Tool {
  const manifestNoHash: Omit<ToolManifest, "hash"> = {
    name: LLM_GENERATE_NAME,
    description:
      "Generate a value with the language model from an instruction and raw input data. " +
      "Pass prior tool outputs as input unchanged; do not pre-summarize or excerpt. " +
      "Returns the model's output (a string unless outputSchema is given).",
    rationale: "Built-in primitive that lets a workflow step produce a value via the LLM, captured as a SymRef-able result.",
    inputSchema: {
      type: "object",
      properties: {
        instructions: {
          type: "string",
          description: "What the model should do with input (e.g. summarize, classify). Put the task here, not in input.",
        },
        input: {
          description:
            "Raw data to transform (any JSON value). When chaining tools, pass the prior tool's return value unchanged—do not pre-summarize.",
        },
        outputSchema: { type: "object", description: "Optional JSON Schema; when present, structured output is requested." },
      },
      required: ["instructions"],
      additionalProperties: false,
    },
    outputShape: {},
    permissions: { fsRead: [], fsWrite: [], net: PERMISSIONS_NET.none, netAllowlist: [], env: [] },
    dependencies: [],
    limits: { timeoutMs: 60_000, maxOldSpaceSizeMb: 256 },
    createdAt: BUILTIN_EPOCH,
    kind: TOOL_KIND.atomic,
    capabilities: [TOOL_CAPABILITY.llm],
    sourceLabels: [SOURCE_LABEL.llmGenerated],
  };
  const hash = hashTool(LLM_GENERATE_CODE, manifestNoHash);
  return { manifest: { ...manifestNoHash, hash }, code: LLM_GENERATE_CODE };
}

/**
 * Seeds trusted built-in tools into the provided tool registry if they are not already present.
 * 
 * @param registry - The tool registry into which built-in tools should be seeded
 */
export async function seedBuiltins(registry: ToolRegistry): Promise<void> {
  if (await registry.has(LLM_GENERATE_NAME)) return;
  const tool = buildLlmGenerateTool();
  const approval: ApprovalRecord = {
    hash: tool.manifest.hash,
    approvedAt: BUILTIN_EPOCH,
    approvedBy: "builtin",
    alwaysApprove: true,
    notes: "Trusted built-in seeded by the host.",
  };
  await registry.save(tool, approval);
}
