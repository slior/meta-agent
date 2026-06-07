import type { ApprovalToken, Tool, ToolResult } from "../types.ts";
import type { LLMCapabilityRequest } from "./stdio-protocol.ts";

export type { LLMCapabilityRequest as LlmCapabilityRequest } from "./stdio-protocol.ts";

/**
 * A handler invoked when a sandboxed tool requests another tool to be executed (composite tool pattern).
 * 
 * @param name - The name of the tool being invoked as delegated by the running tool.
 * @param args - The arguments to pass to the delegated tool.
 * @returns A promise resolving to the result of the invoked tool.
 */
export type InvokeToolHandler = (name: string, args: unknown) => Promise<ToolResult>;

/**
 * Handler invoked when a capability-bearing tool calls the mediated `llm` capability.
 * The host performs the model call; the tool never sees network or secrets.
 */
export type LlmHandler = (req: LLMCapabilityRequest) => Promise<ToolResult>;

/**
 * Optional settings for sandboxed tool execution.
 *
 * @property toolPath - The absolute path to the tool source file to execute. If omitted, tool code may be emitted to a temp file.
 * @property onInvokeTool - Handler for delegated tool invocations (composite/tool-calling patterns).
 * @property depth - (Advanced) Recursion or call depth for composite tool invocation, used to limit nested execution.
 */
export type ExecuteOpts = {
  /** Absolute path to the tool's source file. If omitted, a temporary file may be written. */
  toolPath?: string;
  /** Handler invoked when the running tool delegates (calls) another tool. Used for composite tools. */
  onInvokeTool?: InvokeToolHandler;
  /** Handler for the mediated `llm` capability. Wire only for tools that declare `capabilities: ["llm"]`. */
  onLLM?: LlmHandler;
  /** Current recursion/call depth for composite tool execution. Used to prevent excessive nesting. */
  depth?: number;
};

/**
 * Interface representing a sandbox environment for running tools in a controlled, restricted process.
 *
 * The Sandbox is responsible for securely executing a tool's code with defined permissions,
 * controlling access to resources (e.g., filesystem/network), mediation of composite/delegated tool calls,
 * and enforcing constraints such as resource limits, timeouts, and call depth.
 */
export interface Sandbox {
  /**
   * Execute a sandboxed tool with the given arguments and permission token.
   *
   * @param tool - The compiled or source representation of the tool to run.
   * @param args - The arguments to pass to the tool on invocation.
   * @param approvalToken - A token representing approved permissions for this tool execution (authorization).
   * @param opts - (Optional) Execution options including toolPath override, composite tool handler, call depth, etc.
   * @returns A Promise that resolves to the ToolResult, including output, errors, or invocation metadata.
   */
  execute(
    tool: Tool,
    args: unknown,
    approvalToken: ApprovalToken,
    opts?: ExecuteOpts
  ): Promise<ToolResult>;
}
