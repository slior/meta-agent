/** Allowed values for {@link NetPermissionMode}; keep aligned with static validation and JSON schemas. */
export const PERMISSIONS_NET = {
  NONE: "none",
  ALLOWLIST: "allowlist",
} as const;

/** Network permission mode on a tool manifest's {@link Permissions}. */
export type NetPermissionMode = (typeof PERMISSIONS_NET)[keyof typeof PERMISSIONS_NET];

/** Sandbox filesystem, network, and environment access declared by a tool. */
export type Permissions = {
  fsRead: string[];
  fsWrite: string[];
  net: NetPermissionMode;
  netAllowlist: string[];
  env: string[];
};

/** Resource limits enforced when running a tool in the sandbox. */
export type Limits = {
  timeoutMs: number;
  maxOldSpaceSizeMb: number;
};

/** Allowed values for {@link ToolKind}; keep aligned with static validation and JSON schemas. */
export const TOOL_KIND = {
  ATOMIC: "atomic",
  COMPOSITE: "composite",
  WORKFLOW: "workflow",
} as const;

/** Kind discriminator on {@link ToolManifest} and {@link ToolDraft}. */
export type ToolKind = (typeof TOOL_KIND)[keyof typeof TOOL_KIND];

/** Atomic or composite only — never workflow. Used by ToolDraft and CodeTool. */
export type CodeKind = typeof TOOL_KIND.ATOMIC | typeof TOOL_KIND.COMPOSITE;

/** Mediated, host-serviced capabilities a tool may declare in its manifest. */
export const TOOL_CAPABILITY = {
  LLM: "llm",
} as const;

/** Capability string accepted in {@link ToolManifest.capabilities}. */
export type ToolCapability = (typeof TOOL_CAPABILITY)[keyof typeof TOOL_CAPABILITY];

/** The set of capability strings the host understands and is willing to service. */
export const KNOWN_TOOL_CAPABILITIES: ReadonlySet<string> = new Set(Object.values(TOOL_CAPABILITY));

/** Taint source labels a tool may declare in manifest `sourceLabels` (VERIFY). */
export const SOURCE_LABEL = {
  LLM_GENERATED: "llm_generated",
} as const;

/** Taint source label string for VERIFY metadata. */
export type SourceLabel = (typeof SOURCE_LABEL)[keyof typeof SOURCE_LABEL];

/** Persisted tool metadata hashed and stored in the registry. */
export type ToolManifest = {
  name: string;
  description: string;
  rationale: string;
  inputSchema: Record<string, unknown>;
  outputShape: Record<string, unknown>;
  permissions: Permissions;
  dependencies: string[];
  limits: Limits;
  hash: string;
  createdAt: string;
  kind: ToolKind;
  /** Mediated host capabilities this tool may use (e.g. "llm"). Part of the hash. */
  capabilities?: string[];
  // Reserved for VERIFY spec (all optional, ignored in v1):
  sourceLabels?: string[];        // taint labels this tool produces
  sinkParams?: string[];          // parameter names that are taint sinks
  preconditions?: string[];       // Z3-translatable expressions
  postconditions?: string[];
  frameConditions?: string[];
};

/** Pre-validation tool proposal from the factory or meta-tools. */
export type ToolDraft = {
  name: string;
  description: string;
  rationale: string;
  inputSchema: Record<string, unknown>;
  outputShape: Record<string, unknown>;
  permissions: Permissions;
  code: string;
  dependencies: string[];
  smokeTestInput: unknown;
  kind: CodeKind;
  limits?: Partial<Limits>;
};

/** Registry record of a past Gate 1 approval for a tool hash. */
export type ApprovalRecord = {
  hash: string;
  approvedAt: string;
  approvedBy: string;
  alwaysApprove: boolean;
  notes?: string;
};

/** Discriminator values for {@link ToolErrorKind} in {@link ToolResult} failures. */
export const TOOL_ERROR_KIND = {
  TIMEOUT: "timeout",
  PERMISSION_DENIED: "permission_denied",
  RUNTIME_ERROR: "runtime_error",
  REJECTED_BY_USER: "rejected_by_user",
  SCHEMA_VIOLATION: "schema_violation",
  OUTPUT_TRUNCATED: "output_truncated",
  DEPTH_EXCEEDED: "depth_exceeded",
  UNKNOWN_TOOL: "unknown_tool",
  OUTPUT_SCHEMA_VIOLATION: "output_schema_violation",
} as const;

/** Discriminator for failures returned as {@link ToolResult}. */
export type ToolErrorKind = (typeof TOOL_ERROR_KIND)[keyof typeof TOOL_ERROR_KIND];

/** Structured error payload when {@link ToolResult.ok} is false. */
export type ToolError = {
  kind: ToolErrorKind;
  message: string;
  details?: unknown;
};

/** Success or failure outcome of tool invocation or meta-tool calls. */
export type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; error: ToolError };

/** Short entry in the tool catalog exposed to the agent. */
export type CatalogEntry = {
  name: string;
  shortDescription: string;
  kind: ToolKind;
};

/** Ranked search hit from the tool index. */
export type FindResult = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  score: number;
  matchSpans: string[];
};

/** Compact tool row for registry listing. */
export type ToolSummary = {
  name: string;
  description: string;
  hash: string;
  kind: ToolKind;
};
