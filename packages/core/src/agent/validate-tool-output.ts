import Ajv, { type ValidateFunction, type ErrorObject } from "ajv";
import { TOOL_ERROR_KIND, type ToolResult } from "../types.ts";

/** Module-level Ajv instance shared across all calls (strict:false matches the agent-loop instance). */
const ajv = new Ajv({ strict: false });

/**
 * Cache of compiled validators keyed by JSON.stringify(schema).
 * Each unique object-form schema is compiled exactly once.
 */
const validatorCache = new Map<string, ValidateFunction>();

function getValidator(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = validatorCache.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    validatorCache.set(key, validate);
  }
  return validate;
}

/**
 * Validates `value` against the tool's declared `outputShape`.
 *
 * Returns `{ ok: true, value }` unchanged on success.
 * Returns `{ ok: false, error: { kind: "output_schema_violation", ... } }` on failure.
 * A malformed `outputShape` (invalid object-form JSON Schema) is also reported as a violation.
 *
 * `outputShape` must be object-form JSON Schema (`Record<string, unknown>`); boolean schemas
 * are outside the repo's contract and are not supported.
 *
 * @param schema - The tool's declared `outputShape` (object-form JSON Schema only).
 * @param value - The value returned by the tool execution.
 * @returns `ToolResult` — ok with original value, or a schema-violation failure.
 */
export function validateToolOutput(
  schema: Record<string, unknown>,
  value: unknown,
): ToolResult {
  let validate: ValidateFunction;
  try {
    validate = getValidator(schema);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        kind: TOOL_ERROR_KIND.OUTPUT_SCHEMA_VIOLATION,
        message: `outputShape is not a valid JSON Schema: ${message}`,
      },
    };
  }

  const valid = validate(value);
  if (!valid) {
    const errors: ErrorObject[] = validate.errors ?? [];
    return {
      ok: false,
      error: {
        kind: TOOL_ERROR_KIND.OUTPUT_SCHEMA_VIOLATION,
        // Ajv reuses and mutates errors[] across calls — shallow-copy before storing.
        message: ajv.errorsText(errors, { dataVar: "output" }),
        details: { errors: [...errors] },
      },
    };
  }

  return { ok: true, value };
}
