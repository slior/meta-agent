import type { ApprovalToken, Tool, ToolResult } from "../types.ts";

export type InvokeToolHandler = (name: string, args: unknown) => Promise<ToolResult>;

export type ExecuteOpts = {
  toolPath?: string;
  onInvokeTool?: InvokeToolHandler;
  depth?: number;
};

export interface Sandbox {
  execute(tool: Tool, args: unknown, approvalToken: ApprovalToken, opts?: ExecuteOpts): Promise<ToolResult>;
}
