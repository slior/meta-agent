import { APPROVAL_DECISION } from "../approval/interface.ts";
import type { ApprovalPolicy } from "../approval/interface.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";
import { TOOL_ERROR_KIND, type ToolResult } from "../types.ts";
import type { CodeTool } from "../tool.ts";
import { toolError } from "../errors.ts";
import type { ExecuteOpts, Sandbox } from "./sandbox.ts";

/**
 * Wraps a raw {@link Sandbox} with an {@link ApprovalPolicy} enforcement layer.
 *
 * Every call to {@link execute} first runs `ApprovalPolicy.checkExecution`; if the
 * policy rejects the invocation the inner sandbox is never reached. This makes it
 * impossible for callers who hold a `PolicyEnforcedSandbox` to accidentally bypass
 * the approval gate — the check is structurally in the execution path, not a caller
 * convention.
 *
 * `ToolFactory` receives the raw inner {@link Sandbox} directly for smoke-test
 * executions (which occur before Gate 1 approval and are explicitly exempt from
 * execution policy).
 */
export class PolicyEnforcedSandbox implements Sandbox {
  /**
   * @param inner - Raw sandbox that spawns tool subprocesses.
   * @param approval - Policy consulted before every execution.
   * @param registry - Registry used to load the tool's approval record.
   */
  constructor(
    private readonly inner: Sandbox,
    private readonly approval: ApprovalPolicy,
    private readonly registry: ToolRegistry,
  ) {
    if (inner == null) {
      throw new Error("PolicyEnforcedSandbox: inner sandbox is required");
    }
    if (approval == null) {
      throw new Error("PolicyEnforcedSandbox: approval policy is required");
    }
    if (registry == null) {
      throw new Error("PolicyEnforcedSandbox: tool registry is required");
    }
  }

  /**
   * Runs Gate 2/3 approval, then delegates to the inner sandbox on approve.
   *
   * @param tool - Tool to execute.
   * @param args - Validated invocation arguments.
   * @param opts - Optional sandbox execution options forwarded to the inner sandbox.
   * @returns Tool result from the inner sandbox, or a `rejected_by_user` error if policy denies.
   */
  async execute(tool: CodeTool, args: unknown, opts?: ExecuteOpts): Promise<ToolResult> {
    const approvalRecord = await this.registry.getApproval(tool.manifest.name);
    const decision = await this.approval.checkExecution(tool, args, approvalRecord);
    if (decision.decision === APPROVAL_DECISION.REJECT) {
      return toolError(TOOL_ERROR_KIND.REJECTED_BY_USER, decision.reason);
    }
    return this.inner.execute(tool, args, opts);
  }
}
