/**
 * Failure {@link ToolResult} helper used only by the sandbox child (`runner.ts`).
 *
 * **Do not replace this with `import { toolError } from "../errors.ts"`:** the child process is
 * spawned with Node's `--permission` and a tight `--allow-fs-read` list (workspace, this
 * directory, the tool file's directory, and manifest paths). Any runtime import of a module
 * outside those directories fails during load, so the stdio protocol never completes and
 * parent tests see `ok: false` / wrong error kinds instead of real tool results.
 *
 * This mirrors the small slice of `toolError(...)` from `errors.ts` that the runner needs
 * (`kind: "runtime_error"` only), without crossing the sandbox read boundary. No `../` imports
 * here: even `import type` from `../types.ts` is avoided so this module stays fully under the
 * runner’s allowed read path.
 *
 * @module sandbox/runner-tool-error
 */

/** Failure branch shape compatible with `ToolResult` (see `types.ts`) for `childStdoutResultFrame`. */
export type RunnerToolFailure = {
  ok: false;
  error: { kind: "runtime_error"; message: string; details?: unknown };
};

/**
 * Builds `{ ok: false, error: { kind, message, details? } }` for stdout `result` frames.
 * Kept colocated under `sandbox/` so the permission child can load it with `runner.ts`.
 */
export function runnerToolError(
  kind: "runtime_error",
  message: string,
  details?: unknown,
): RunnerToolFailure {
  return details === undefined
    ? { ok: false, error: { kind, message } }
    : { ok: false, error: { kind, message, details } };
}
