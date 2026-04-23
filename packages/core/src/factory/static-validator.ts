import type { Permissions, ToolDraft } from "../types.ts";
import { PERMISSIONS_NET, TOOL_KIND } from "../types.ts";

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

/** Tool manifest `name`: leading lowercase letter, then lowercase letters, digits, or hyphen (max length enforced by pattern). */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** Node's built-in `fetch` (v18+); permission rules match other HTTP client modules. */
const NODE_FETCH_MODULE = "node:fetch" as const;

/** Name used in generated composite tool code; must match {@link INVOKE_TOOL_RE}. */
const INVOKE_TOOL_CALLEE = "invokeTool";
const INVOKE_TOOL_RE = new RegExp(String.raw`\b${INVOKE_TOOL_CALLEE}\s*\(\s*['"]([^'"]+)['"]`, "g");

const EVAL_RE = /\b(?:eval|Function)\s*\(/;

export type ValidationContext = {
  existingNames: Set<string>;
  tombstoned: Set<string>;
};

export type ValidationOk = { ok: true };
export type ValidationFail = { ok: false; errors: string[] };
export type ValidationResult = ValidationOk | ValidationFail;

/**
 * Extracts all static and dynamic import module names from the provided code string.
 *
 * This function scans the input JavaScript/TypeScript code for the following module inclusion patterns:
 *   - ES6 import statements (e.g., `import foo from "bar"` and `import "bar"`)
 *   - CommonJS `require()` calls (e.g., `const foo = require("bar")`)
 *   - Dynamic `import()` expressions (e.g., `const mod = await import("bar")`)
 *
 * It uses a set of regular expressions to match all such patterns and collects the module specifiers (strings).
 * Duplicates are removed in the returned array.
 *
 * @param code - Source code string to scan for import/module references.
 * @returns Array of module names referenced by import/require/dynamic import statements.
 */
export function extractImports(code: string): string[] {
  const out = new Set<string>();
  for (const re of [IMPORT_RE, SIDE_EFFECT_IMPORT_RE, REQUIRE_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) out.add(m[1]!);
  }
  return Array.from(out);
}

/**
 * Extracts all tool names invoked via invokeTool() calls in the given source code.
 *
 * This function scans the provided JavaScript/TypeScript code string for usages of
 * the invokeTool(name, args) pattern and collects all unique tool name strings
 * passed as the first argument to the invokeTool function.
 *
 * Example matched patterns:
 *   invokeTool("tool-name", {...})
 *   invokeTool('other-tool', ...)
 *
 * @param code - The source code to scan for invokeTool() calls.
 * @returns Array of tool name strings found as first argument to invokeTool().
 */
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
  if (d.kind !== TOOL_KIND.atomic && d.kind !== TOOL_KIND.composite) {
    errs.push(`kind must be "${TOOL_KIND.atomic}" or "${TOOL_KIND.composite}" (got ${valueKind(d.kind)}).`);
  }
  if (d.smokeTestInput === undefined) {
    errs.push(
      "smokeTestInput is required (use {} if the smoke test needs no input). If missing, structured output omitted a required ToolDraft field.",
    );
  }
}

function validateToolIdentity(draft: ToolDraft, ctx: ValidationContext, errs: string[]): void {
  if (typeof draft.name !== "string") return;
  if (!TOOL_NAME_PATTERN.test(draft.name)) errs.push(`invalid name '${draft.name}'`);
  if (ctx.existingNames.has(draft.name)) errs.push(`name '${draft.name}' already exists`);
  if (ctx.tombstoned.has(draft.name)) errs.push(`name '${draft.name}' is tombstoned`);
}

function validateEvalInCode(draft: ToolDraft, errs: string[]): void {
  if (typeof draft.code === "string" && EVAL_RE.test(draft.code)) errs.push("eval/Function() not permitted");
}

function validatePermissionsBlock(pe: unknown, errs: string[]): void {
  if (!pe || typeof pe !== "object") {
    errs.push("permissions must be an object");
    return;
  }
  const p = pe as Permissions;
  if (!Array.isArray(p.fsRead)) errs.push("permissions.fsRead must be an array");
  if (!Array.isArray(p.fsWrite)) errs.push("permissions.fsWrite must be an array");
  if (!Array.isArray(p.netAllowlist)) errs.push("permissions.netAllowlist must be an array");
  if (!Array.isArray(p.env)) errs.push("permissions.env must be an array");
  if (p.net !== PERMISSIONS_NET.none && p.net !== PERMISSIONS_NET.allowlist) {
    errs.push(`permissions.net must be "${PERMISSIONS_NET.none}" or "${PERMISSIONS_NET.allowlist}"`);
  }
}

function validateImportsAgainstPermissions(draft: ToolDraft, errs: string[]): void {
  const pe = draft.permissions;
  const imports = typeof draft.code === "string" ? extractImports(draft.code) : [];
  for (const mod of imports) {
    if (FORBIDDEN_MODULES.has(mod)) {
      errs.push(`forbidden import '${mod}'`);
      continue;
    }
    if (FS_MODULES.has(mod)) {
      const fsReadLen = Array.isArray(pe?.fsRead) ? pe.fsRead.length : 0;
      const fsWriteLen = Array.isArray(pe?.fsWrite) ? pe.fsWrite.length : 0;
      if (fsReadLen === 0 && fsWriteLen === 0) {
        errs.push(`import of '${mod}' requires fsRead/fsWrite permissions`);
      }
      continue;
    }
    if (NET_MODULES.has(mod) || mod === NODE_FETCH_MODULE) {
      if (pe?.net === PERMISSIONS_NET.none) errs.push(`import of '${mod}' requires net permission`);
      continue;
    }
    if (ALLOWED_NODE_MODULES.has(mod)) continue;
    if (!mod.startsWith("node:")) errs.push(`non-node import '${mod}' not allowed (v1 allows only node:* modules)`);
    else errs.push(`node module '${mod}' not in allowlist`);
  }
}

function validateInvokeToolConsistency(draft: ToolDraft, ctx: ValidationContext, errs: string[]): void {
  const calls = typeof draft.code === "string" ? extractInvokeToolCalls(draft.code) : [];
  if (draft.kind === TOOL_KIND.atomic && calls.length > 0) {
    errs.push(`${TOOL_KIND.atomic} tool must not call ${INVOKE_TOOL_CALLEE} (found: ${calls.join(",")})`);
  }
  if (draft.kind === TOOL_KIND.composite && Array.isArray(draft.dependencies)) {
    const declared = new Set(draft.dependencies);
    const actual = new Set(calls);
    for (const dep of declared) {
      if (!actual.has(dep)) errs.push(`declared dep '${dep}' has no ${INVOKE_TOOL_CALLEE} call site`);
    }
    for (const a of actual) {
      if (!declared.has(a)) errs.push(`${INVOKE_TOOL_CALLEE}('${a}') has no declared dependency`);
    }
    for (const dep of declared) {
      if (!ctx.existingNames.has(dep)) errs.push(`dependency '${dep}' does not exist in registry`);
    }
  }
}

/**
 * Performs static validation on a tool draft before it is accepted or approved.
 * This function checks the following aspects of the draft:
 *   - Structural correctness (required fields, types, presence of code, etc.)
 *   - Tool identity (uniqueness, allowed characters, collision with existing names)
 *   - Absence of forbidden dynamic evaluation constructs (such as eval)
 *   - Permissions block validity (structure, allowed/enabled values)
 *   - Import statements alignment with declared permissions and allowed modules
 *   - Consistency of invokeTool calls with declared dependencies and registry existence
 *
 * All validation errors are accumulated and returned if any are found.
 *
 * @param draft The ToolDraft object to statically validate.
 * @param ctx ValidationContext containing information about the existing registry/tools.
 * @returns {ValidationResult} An object with ok: true if valid, or ok: false and errors: string[] if invalid.
 */
export function staticValidateDraft(draft: ToolDraft, ctx: ValidationContext): ValidationResult {
  const errs: string[] = [];

  validateDraftStructure(draft, errs);
  validateToolIdentity(draft, ctx, errs);
  validateEvalInCode(draft, errs);
  validatePermissionsBlock(draft.permissions, errs);
  validateImportsAgainstPermissions(draft, errs);
  validateInvokeToolConsistency(draft, ctx, errs);

  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true };
}
