/** Values for {@link Permissions.net}; keep aligned with static validation and JSON schemas. */
export const PERMISSIONS_NET = {
  none: "none",
  allowlist: "allowlist",
} as const;

export type NetPermissionMode = (typeof PERMISSIONS_NET)[keyof typeof PERMISSIONS_NET];

export type Permissions = {
  fsRead: string[];
  fsWrite: string[];
  net: NetPermissionMode;
  netAllowlist: string[];
  env: string[];
};

export type Limits = {
  timeoutMs: number;
  maxOldSpaceSizeMb: number;
};

/** Values for {@link ToolManifest.kind} / {@link ToolDraft.kind}. */
export const TOOL_KIND = {
  atomic: "atomic",
  composite: "composite",
  workflow: "workflow",
} as const;

export type ToolKind = (typeof TOOL_KIND)[keyof typeof TOOL_KIND];

/** Mediated, host-serviced capabilities a tool may declare in its manifest. */
export const TOOL_CAPABILITY = {
  llm: "llm",
} as const;

export type ToolCapability = (typeof TOOL_CAPABILITY)[keyof typeof TOOL_CAPABILITY];

/** The set of capability strings the host understands and is willing to service. */
export const KNOWN_TOOL_CAPABILITIES: ReadonlySet<string> = new Set(Object.values(TOOL_CAPABILITY));

/** Taint source labels a tool may declare in manifest `sourceLabels` (VERIFY). */
export const SOURCE_LABEL = {
  llmGenerated: "llm_generated",
} as const;

export type SourceLabel = (typeof SOURCE_LABEL)[keyof typeof SOURCE_LABEL];

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

export type Tool = {
  manifest: ToolManifest;
  code: string;
};

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
  kind: ToolKind;
  limits?: Partial<Limits>;
};

export type ApprovalRecord = {
  hash: string;
  approvedAt: string;
  approvedBy: string;
  alwaysApprove: boolean;
  notes?: string;
};

export type ApprovalToken = string;

export type ToolErrorKind =
  | "timeout"
  | "permission_denied"
  | "runtime_error"
  | "rejected_by_user"
  | "schema_violation"
  | "output_truncated"
  | "depth_exceeded"
  | "unknown_tool";

export type ToolError = {
  kind: ToolErrorKind;
  message: string;
  details?: unknown;
};

export type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; error: ToolError };

export type CatalogEntry = {
  name: string;
  shortDescription: string;
  kind: ToolKind;
};

export type FindResult = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  score: number;
  matchSpans: string[];
};

export type ToolSummary = {
  name: string;
  description: string;
  hash: string;
  kind: ToolKind;
};
