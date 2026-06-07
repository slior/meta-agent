import type { ToolResult } from "../types.ts";

/** Structured, host-controlled request for the mediated `llm` capability. */
export type LLMCapabilityRequest = { instructions: string; input: unknown; schema?: Record<string, unknown> };

/** JSON-line `op` values on the sandbox runner stdio wire format (parent ↔ child). */
export const SANDBOX_STDIO_OP = {
  args: "args",
  invokeTool: "invokeTool",
  invokeToolResult: "invokeToolResult",
  llm: "llm",
  llmResult: "llmResult",
  result: "result",
} as const;

/** Env var: comma-separated hostname allowlist for the runner net shim. */
export const META_AGENT_NET_ALLOWLIST_ENV = "META_AGENT_NET_ALLOWLIST" as const;

/** Child → parent on the child stdout pipe (`invokeTool` proxy request). */
export type SandboxChildStdoutInvokeToolFrame = {
  op: typeof SANDBOX_STDIO_OP.invokeTool;
  requestId: string;
  name: string;
  args: unknown;
};

/** Child → parent on the child stdout pipe (`llm` capability request). */
export type SandboxChildStdoutLLMFrame = {
  op: typeof SANDBOX_STDIO_OP.llm;
  requestId: string;
  req: LLMCapabilityRequest;
};

/** Child → parent on the child stdout pipe (terminal tool outcome). */
export type SandboxChildStdoutResultFrame = {
  op: typeof SANDBOX_STDIO_OP.result;
  result: ToolResult;
};

/** Union of JSON lines the runner may write to stdout for the parent to consume. */
export type SandboxChildStdoutFrame =
  | SandboxChildStdoutInvokeToolFrame
  | SandboxChildStdoutLLMFrame
  | SandboxChildStdoutResultFrame;

/** Parent → child on the child stdin pipe (initial args for `run`). */
export type SandboxChildStdinArgsFrame = {
  op: typeof SANDBOX_STDIO_OP.args;
  args: unknown;
};

/** Parent → child on the child stdin pipe (composite invoke reply). */
export type SandboxChildStdinInvokeToolResultFrame = {
  op: typeof SANDBOX_STDIO_OP.invokeToolResult;
  requestId: string;
  result: ToolResult;
};

/** Parent → child on the child stdin pipe (`llm` capability reply). */
export type SandboxChildStdinLLMResultFrame = {
  op: typeof SANDBOX_STDIO_OP.llmResult;
  requestId: string;
  result: ToolResult;
};

/** Union of JSON lines the parent may write to the runner stdin. */
export type SandboxChildStdinFrame =
  | SandboxChildStdinArgsFrame
  | SandboxChildStdinInvokeToolResultFrame
  | SandboxChildStdinLLMResultFrame;
