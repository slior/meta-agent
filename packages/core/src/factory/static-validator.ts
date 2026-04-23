import type { ToolDraft } from "../types.ts";

const ALLOWED_NODE_MODULES = new Set([
  "node:path", "node:url", "node:util", "node:buffer",
  "node:crypto", "node:stream", "node:timers", "node:timers/promises",
  "node:string_decoder", "node:querystring", "node:assert",
]);

const FS_MODULES = new Set(["node:fs", "node:fs/promises"]);
const NET_MODULES = new Set(["node:http", "node:https", "undici"]);
const FORBIDDEN_MODULES = new Set([
  "node:child_process", "node:worker_threads", "node:vm",
  "node:inspector", "node:perf_hooks", "node:cluster",
  "node:dgram", "node:dns", "node:net", "node:tls",
  "node:repl", "node:readline", "node:module",
  "child_process", "worker_threads", "vm", "inspector",
]);

const IMPORT_RE = /\bimport\s+(?:[\s\S]*?)from\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport\s+['"]([^'"]+)['"]/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const INVOKE_TOOL_RE = /\binvokeTool\s*\(\s*['"]([^'"]+)['"]/g;
const EVAL_RE = /\b(?:eval|Function)\s*\(/;

export type ValidationContext = {
  existingNames: Set<string>;
  tombstoned: Set<string>;
};

export type ValidationOk = { ok: true };
export type ValidationFail = { ok: false; errors: string[] };
export type ValidationResult = ValidationOk | ValidationFail;

export function extractImports(code: string): string[] {
  const out = new Set<string>();
  for (const re of [IMPORT_RE, SIDE_EFFECT_IMPORT_RE, REQUIRE_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) out.add(m[1]!);
  }
  return Array.from(out);
}

export function extractInvokeToolCalls(code: string): string[] {
  const out = new Set<string>();
  INVOKE_TOOL_RE.lastIndex = 0;
  for (const m of code.matchAll(INVOKE_TOOL_RE)) out.add(m[1]!);
  return Array.from(out);
}

function valueKind(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(length ${v.length})`;
  return typeof v;
}

/** Ensures required ToolDraft fields exist at runtime (LLM structured output can omit or mistype them). */
function validateDraftStructure(draft: ToolDraft, errs: string[]): void {
  const d = draft as unknown as Record<string, unknown>;

  if (typeof d.name !== "string") {
    errs.push(`name must be a non-empty string (got ${valueKind(d.name)}). The ToolDraft schema requires "name".`);
  }
  if (typeof d.description !== "string" || !d.description.trim()) {
    errs.push(
      `description must be a non-empty string (got ${valueKind(d.description)}). The model may have omitted or left it empty.`,
    );
  }
  if (typeof d.rationale !== "string" || !d.rationale.trim()) {
    errs.push(
      `rationale must be a non-empty string (got ${valueKind(d.rationale)}). The model often omits this; set a short rationale for why the tool exists.`,
    );
  }
  if (d.inputSchema === undefined || d.inputSchema === null || typeof d.inputSchema !== "object" || Array.isArray(d.inputSchema)) {
    errs.push(
      `inputSchema must be a JSON object (got ${valueKind(d.inputSchema)}). It must describe the tool's input parameters.`,
    );
  }
  if (d.outputShape === undefined || d.outputShape === null || typeof d.outputShape !== "object" || Array.isArray(d.outputShape)) {
    errs.push(
      `outputShape must be a JSON object (got ${valueKind(d.outputShape)}). It must describe the tool's return value; the model may have omitted it.`,
    );
  }
  if (typeof d.code !== "string") {
    errs.push(`code must be a string (got ${valueKind(d.code)}).`);
  } else if (!d.code.trim()) {
    errs.push("code must be a non-empty string.");
  }
  if (!Array.isArray(d.dependencies)) {
    errs.push(
      `dependencies must be an array of tool name strings (got ${valueKind(d.dependencies)}). For an atomic tool use []. If this field was missing, structured output did not match the ToolDraft schema — downstream UI expects an array.`,
    );
  } else {
    for (let i = 0; i < d.dependencies.length; i++) {
      const dep = d.dependencies[i];
      if (typeof dep !== "string") {
        errs.push(`dependencies[${i}] must be a string (got ${valueKind(dep)}).`);
      }
    }
  }
  if (d.kind !== "atomic" && d.kind !== "composite") {
    errs.push(`kind must be "atomic" or "composite" (got ${valueKind(d.kind)}).`);
  }
  if (d.smokeTestInput === undefined) {
    errs.push(
      "smokeTestInput is required (use {} if the smoke test needs no input). If missing, structured output omitted a required ToolDraft field.",
    );
  }
}

export function staticValidateDraft(draft: ToolDraft, ctx: ValidationContext): ValidationResult {
  const errs: string[] = [];

  validateDraftStructure(draft, errs);

  if (typeof draft.name === "string") {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(draft.name)) errs.push(`invalid name '${draft.name}'`);
    if (ctx.existingNames.has(draft.name)) errs.push(`name '${draft.name}' already exists`);
    if (ctx.tombstoned.has(draft.name)) errs.push(`name '${draft.name}' is tombstoned`);
  }

  if (typeof draft.code === "string" && EVAL_RE.test(draft.code)) errs.push("eval/Function() not permitted");

  const pe = draft.permissions;
  if (!pe || typeof pe !== "object") {
    errs.push("permissions must be an object");
  } else {
    if (!Array.isArray(pe.fsRead)) errs.push("permissions.fsRead must be an array");
    if (!Array.isArray(pe.fsWrite)) errs.push("permissions.fsWrite must be an array");
    if (!Array.isArray(pe.netAllowlist)) errs.push("permissions.netAllowlist must be an array");
    if (!Array.isArray(pe.env)) errs.push("permissions.env must be an array");
    if (pe.net !== "none" && pe.net !== "allowlist") {
      errs.push('permissions.net must be "none" or "allowlist"');
    }
  }

  const imports = typeof draft.code === "string" ? extractImports(draft.code) : [];
  for (const mod of imports) {
    if (FORBIDDEN_MODULES.has(mod)) { errs.push(`forbidden import '${mod}'`); continue; }
    if (FS_MODULES.has(mod)) {
      const fsReadLen = Array.isArray(pe?.fsRead) ? pe.fsRead.length : 0;
      const fsWriteLen = Array.isArray(pe?.fsWrite) ? pe.fsWrite.length : 0;
      if (fsReadLen === 0 && fsWriteLen === 0) {
        errs.push(`import of '${mod}' requires fsRead/fsWrite permissions`);
      }
      continue;
    }
    if (NET_MODULES.has(mod) || mod === "node:fetch") {
      if (pe?.net === "none") errs.push(`import of '${mod}' requires net permission`);
      continue;
    }
    if (ALLOWED_NODE_MODULES.has(mod)) continue;
    if (!mod.startsWith("node:")) errs.push(`non-node import '${mod}' not allowed (v1 allows only node:* modules)`);
    else errs.push(`node module '${mod}' not in allowlist`);
  }

  const calls = typeof draft.code === "string" ? extractInvokeToolCalls(draft.code) : [];
  if (draft.kind === "atomic" && calls.length > 0) {
    errs.push(`atomic tool must not call invokeTool (found: ${calls.join(",")})`);
  }
  if (draft.kind === "composite" && Array.isArray(draft.dependencies)) {
    const declared = new Set(draft.dependencies);
    const actual = new Set(calls);
    for (const dep of declared) if (!actual.has(dep)) errs.push(`declared dep '${dep}' has no invokeTool call site`);
    for (const a of actual) if (!declared.has(a)) errs.push(`invokeTool('${a}') has no declared dependency`);
    for (const dep of declared) if (!ctx.existingNames.has(dep)) errs.push(`dependency '${dep}' does not exist in registry`);
  }

  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true };
}
