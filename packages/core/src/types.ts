export type Permissions = {
  fsRead: string[];
  fsWrite: string[];
  net: "none" | "allowlist";
  netAllowlist: string[];
  env: string[];
};

export type Limits = {
  timeoutMs: number;
  maxOldSpaceSizeMb: number;
};

export type ToolKind = "atomic" | "composite";

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
