/**
 * Coerce LLM double-encoded JSON tool arguments before Ajv validation.
 * v1: only root `inputSchema.type` of exactly `"object"` or `"array"` (no allOf / oneOf / multi-type).
 */

export function rootJsonSchemaKind(schema: Record<string, unknown>): "object" | "array" | null {
  const t = schema.type;
  if (t === "object" || t === "array") return t;
  return null;
}

export function coerceStringifiedJsonInput(args: unknown, kind: "object" | "array" | null): unknown {
  if (kind === null || typeof args !== "string") return args;

  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args;
  }

  if (kind === "object") {
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return args;
  }

  // kind === "array"
  if (Array.isArray(parsed)) return parsed;
  return args;
}
