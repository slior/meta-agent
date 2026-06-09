export const version = "0.1.0";
export * from "./types.ts";
export * from "./schemas.ts";
export * from "./hash.ts";
export * from "./errors.ts";
export {
  Tracer, TRACE_KIND_EXECUTION_DENIED, TRACE_KIND_FACTORY_REPAIR_LLM,
  TRACE_KIND_LLM_CALL, TRACE_KIND_LLM_SYNTHESIS, TRACE_KIND_LLM_SYNTHESIS_START, TRACE_KIND_LLM_TURN,
  TRACE_KIND_LLM_TURN_START, TRACE_KIND_TOOL_CALL, TRACE_KIND_TOOL_DISPATCH_START,
  TRACE_KIND_TOOL_INVOKED, TRACE_KIND_WORKFLOW_START, TRACE_KIND_WORKFLOW_STEP_START,
  TRACE_KIND_WORKFLOW_STEP_END, TRACE_KIND_WORKFLOW_END, LLM_TRACE_PHASE,
} from "./tracer.ts";
export type { TraceEvent, TracerObserver, TracerOptions, LlmTracePhase } from "./tracer.ts";
export type { ToolRegistry } from "./registry/tool-registry.ts";
export { FsToolRegistry } from "./registry/fs-registry.ts";
export type { ToolIndex } from "./index-store/interface.ts";
export { HybridToolIndex } from "./index-store/hybrid-index.ts";
export { APPROVAL_DECISION, RISK_TIER } from "./approval/interface.ts";
export type { ApprovalPolicy, ApprovalPrompter, Gate1Decision, ExecutionDecision, RiskTier } from "./approval/interface.ts";
export { TieredApprovalPolicy, riskTier } from "./approval/tiered-policy.ts";
export type { LLMProvider, ChatRequest, ChatResponse, ChatMessage, ChatRole, ToolDef, ToolCall, StructuredRequest } from "./llm/LLMProvider.ts";
export { CHAT_ROLE, CHAT_TOOL_CHOICE, CHAT_TOOL_TYPE } from "./llm/LLMProvider.ts";
export { OpenAIProvider } from "./llm/openai-provider.ts";
export { TracingLLMProvider } from "./llm/tracing-provider.ts";
export { MockLLMProvider } from "./llm/mock-provider.ts";
export type { Sandbox, InvokeToolHandler, ExecuteOpts } from "./sandbox/sandbox.ts";
export { NodePermissionSandbox } from "./sandbox/node-permission-sandbox.ts";
export { SANDBOX_DEBUG_ENV, sandboxDebugEnabled } from "./sandbox/sandbox-debug.ts";
export { staticValidateDraft, extractImports, extractInvokeToolCalls } from "./factory/static-validator.ts";
export { ToolFactory } from "./factory/factory.ts";
export type { PreviewWorkflowOutcome } from "./factory/factory.ts";
export { parameterize, jsonSchemaTypeOf, type Promotion } from "./workflow/parameterize.ts";
export { FIND_TOOL_TOP_K, META_FN, META_TOOL_DEFS, META_TOOL_NAMES } from "./agent/meta-tools.ts";
export type { MetaFnName } from "./agent/meta-tools.ts";
export { renderSystemPrompt } from "./agent/system-prompt.ts";
export { AgentLoop } from "./agent/agent-loop.ts";
export {
  buildLLMGenerateTool as buildLlmGenerateTool, seedBuiltins, LLM_GENERATE_NAME,
  BUILTIN_APPROVED_BY, isBuiltinApproval,
} from "./agent/builtins.ts";
export {
  DEBUG_KIND_OPENAI_CHAT_COMPLETION,
  DEBUG_KIND_OPENAI_STRUCTURED_COMPLETION,
} from "./util/debug.ts";
export type { DebugEvent, DebugSink } from "./util/debug.ts";

// Workflow IR (LEAN tier)
export * from "./workflow/index.ts";
