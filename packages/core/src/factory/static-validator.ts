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

export function staticValidateDraft(draft: ToolDraft, ctx: ValidationContext): ValidationResult {
  const errs: string[] = [];

  if (!/^[a-z][a-z0-9-]{0,63}$/.test(draft.name)) errs.push(`invalid name '${draft.name}'`);
  if (ctx.existingNames.has(draft.name)) errs.push(`name '${draft.name}' already exists`);
  if (ctx.tombstoned.has(draft.name)) errs.push(`name '${draft.name}' is tombstoned`);

  if (EVAL_RE.test(draft.code)) errs.push("eval/Function() not permitted");

  const imports = extractImports(draft.code);
  for (const mod of imports) {
    if (FORBIDDEN_MODULES.has(mod)) { errs.push(`forbidden import '${mod}'`); continue; }
    if (FS_MODULES.has(mod)) {
      if (draft.permissions.fsRead.length === 0 && draft.permissions.fsWrite.length === 0) {
        errs.push(`import of '${mod}' requires fsRead/fsWrite permissions`);
      }
      continue;
    }
    if (NET_MODULES.has(mod) || mod === "node:fetch") {
      if (draft.permissions.net === "none") errs.push(`import of '${mod}' requires net permission`);
      continue;
    }
    if (ALLOWED_NODE_MODULES.has(mod)) continue;
    if (!mod.startsWith("node:")) errs.push(`non-node import '${mod}' not allowed (v1 allows only node:* modules)`);
    else errs.push(`node module '${mod}' not in allowlist`);
  }

  const calls = extractInvokeToolCalls(draft.code);
  if (draft.kind === "atomic" && calls.length > 0) {
    errs.push(`atomic tool must not call invokeTool (found: ${calls.join(",")})`);
  }
  if (draft.kind === "composite") {
    const declared = new Set(draft.dependencies);
    const actual = new Set(calls);
    for (const d of declared) if (!actual.has(d)) errs.push(`declared dep '${d}' has no invokeTool call site`);
    for (const a of actual) if (!declared.has(a)) errs.push(`invokeTool('${a}') has no declared dependency`);
    for (const d of declared) if (!ctx.existingNames.has(d)) errs.push(`dependency '${d}' does not exist in registry`);
  }

  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true };
}
