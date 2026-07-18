/**
 * Failure {@link ToolResult} helper used only by the sandbox child (`runner.ts`).
 *
 * **Do not replace this with `import { toolError } from "../errors.ts"`:** the child process is
 * spawned with Node's `--permission` and a tight `--allow-fs-read` list (workspace, this
 * directory, the tool file's directory, and manifest paths). Any runtime import of a module
 * outside those directories fails during load, so the stdio protocol never completes and
 * parent tests see `ok: false` / wrong error kinds instead of real tool results.
 *
 * This mirrors the small slice of `toolError(...)` from `errors.ts` that the runner needs,
 * without crossing the sandbox read boundary. No `../` imports here: even `import type` from
 * `../types.ts` is avoided so this module stays fully under the runner’s allowed read path.
 *
 * @module sandbox/runner-tool-error
 */

/**
 * Discriminator values for sandbox-child failure kinds on stdout `result` frames.
 * Values match the parent `TOOL_ERROR_KIND` wire strings for the kinds the child may emit.
 */
export const RUNNER_TOOL_ERROR_KIND = {
  RUNTIME_ERROR: "runtime_error",
  PERMISSION_DENIED: "permission_denied",
} as const;

/**
 * Error kinds the sandbox child may emit on stdout `result` frames.
 */
export type RunnerToolErrorKind = (typeof RUNNER_TOOL_ERROR_KIND)[keyof typeof RUNNER_TOOL_ERROR_KIND];

/**
 * Failure branch shape compatible with `ToolResult` (see `types.ts`) for `childStdoutResultFrame`.
 */
export type RunnerToolFailure = {
  ok: false;
  error: { kind: RunnerToolErrorKind; message: string; details?: unknown };
};

/**
 * Builds `{ ok: false, error: { kind, message, details? } }` for stdout `result` frames.
 * Kept colocated under `sandbox/` so the permission child can load it with `runner.ts`.
 *
 * @param kind - Child-emitted error discriminator.
 * @param message - Human-readable failure description.
 * @param details - Optional structured extras (e.g. stack) for the parent/agent.
 * @returns A failed tool result payload for a stdout `result` frame.
 */
export function runnerToolError(
  kind: RunnerToolErrorKind,
  message: string,
  details?: unknown,
): RunnerToolFailure {
  return details === undefined
    ? { ok: false, error: { kind, message } }
    : { ok: false, error: { kind, message, details } };
}
