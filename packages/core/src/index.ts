export const version = "0.1.0";
export * from "./types.ts";
export * from "./schemas.ts";
export * from "./hash.ts";
export * from "./errors.ts";
export {
  Tracer,
  TRACE_KIND_EXECUTION_DENIED,
  TRACE_KIND_LLM_SYNTHESIS,
  TRACE_KIND_LLM_TURN,
  TRACE_KIND_TOOL_CALL,
  TRACE_KIND_TOOL_INVOKED,
} from "./tracer.ts";
export type { TraceEvent, TracerObserver, TracerOptions } from "./tracer.ts";
export type { ToolRegistry } from "./registry/interface.ts";
export { FsToolRegistry } from "./registry/fs-registry.ts";
export type { ToolIndex } from "./index-store/interface.ts";
export { HybridToolIndex } from "./index-store/hybrid-index.ts";
export { APPROVAL_DECISION, RISK_TIER } from "./approval/interface.ts";
export type { ApprovalPolicy, ApprovalPrompter, Gate1Decision, ExecutionDecision, RiskTier } from "./approval/interface.ts";
export { TieredApprovalPolicy, riskTier } from "./approval/tiered-policy.ts";
export type { LLMProvider, ChatRequest, ChatResponse, ChatMessage, ChatRole, ToolDef, ToolCall, StructuredRequest } from "./llm/interface.ts";
export { CHAT_ROLE } from "./llm/interface.ts";
export { OpenAIProvider } from "./llm/openai-provider.ts";
export { MockLLMProvider } from "./llm/mock-provider.ts";
export type { Sandbox, InvokeToolHandler, ExecuteOpts } from "./sandbox/interface.ts";
export { NodePermissionSandbox } from "./sandbox/node-permission-sandbox.ts";
export { staticValidateDraft, extractImports, extractInvokeToolCalls } from "./factory/static-validator.ts";
export { ToolFactory } from "./factory/factory.ts";
export { FIND_TOOL_TOP_K, META_FN, META_TOOL_DEFS, META_TOOL_NAMES } from "./agent/meta-tools.ts";
export type { MetaFnName } from "./agent/meta-tools.ts";
export { renderSystemPrompt } from "./agent/system-prompt.ts";
export { AgentLoop } from "./agent/agent-loop.ts";
