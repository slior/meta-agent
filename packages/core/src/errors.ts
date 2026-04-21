import type { ToolError, ToolErrorKind } from "./types.ts";

export function toolError(
  kind: ToolErrorKind,
  message: string,
  details?: unknown,
): { ok: false; error: ToolError } {
  return { ok: false, error: details === undefined
    ? { kind, message }
    : { kind, message, details }
  };
}
