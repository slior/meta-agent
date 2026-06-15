/** Max serialized bytes of a tool output before it is elided to a handle for the model. */
export const ELISION_MAX_BYTES = 1024;

/** Max characters of a previewed (elided) value shown to the model. */
export const PREVIEW_CHARS = 200;

/**
 * Sanitizes a binding name to ensure it is identifier-safe.
 * 
 * This function replaces all non-alphanumeric and non-underscore characters in the input name
 * with underscores, and converts the result to lowercase. This is useful when generating
 * binding names that must conform to variable naming rules or other identifier constraints.
 *
 * Mirrors the workflow validator's BINDING_NAME rules.
 * 
 * @param name - The original binding name to sanitize.
 * @returns The sanitized, identifier-safe binding name.
 */
export function sanitizeBinding(name: string): string {
  return name.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
}

/**
 * A model-emitted reference to a prior tool output, optionally projecting one top-level key.
 *
 * @property $ref - Binding id of a stored depth-0 tool result (e.g. `r_0_fetch`).
 * @property path - (Optional) Top-level key to project from the referenced value.
 */
export type RefSentinel = { $ref: string; path?: string };

/**
 * Type guard for {@link RefSentinel}.
 *
 * A value is a reference sentinel iff it has a string `$ref` and only `$ref`/`path` keys.
 *
 * @param v - Value to test.
 * @returns `true` when `v` is a well-formed {@link RefSentinel}.
 */
export function isRefSentinel(v: unknown): v is RefSentinel {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.$ref !== "string") return false;
  for (const k of Object.keys(o)) {
    if (k !== "$ref" && k !== "path") return false;
  }
  if ("path" in o && typeof o.path !== "string") return false;
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Outcome of looking up a binding in a {@link ResultStore}. */
type StoredResultLookup = { has: true; value: unknown } | { has: false };

/**
 * Session-scoped map of result binding id to the tool's full output value.
 *
 * Depth-0 tool results are stored here so later tool calls can reference them via
 * {@link RefSentinel} without re-sending large payloads to the model.
 */
export class ResultStore {
  private readonly map = new Map<string, unknown>();

  /**
   * Stores a tool output under a binding id.
   *
   * @param binding - Identifier-safe binding name (see {@link sanitizeBinding}).
   * @param value - Full tool output value to retain for reference resolution.
   */
  put(binding: string, value: unknown): void { this.map.set(binding, value); }

  /**
   * Looks up a stored result by binding id.
   *
   * @param binding - Binding id to retrieve.
   * @returns A {@link StoredResultLookup}: `{ has: true, value }` when present, `{ has: false }` otherwise.
   */
  get(binding: string): StoredResultLookup {
    return this.map.has(binding) ? { has: true, value: this.map.get(binding) } : { has: false };
  }

  /**
   * Lists all binding ids currently stored in this session.
   *
   * @returns Binding ids in insertion order.
   */
  keys(): string[] { return [...this.map.keys()]; }
}

/**
 * Outcome of resolving {@link RefSentinel} values in tool arguments.
 *
 * On success, `value` is the args object (or original non-object args) with refs substituted.
 * On failure, `error` is a human-readable message suitable for surfacing to the model.
 */
export type ResolveResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Resolves top-level {@link RefSentinel} argument values against the store, applying single-key
 * `path` projection. Non-object args and non-sentinel values pass through unchanged. Returns a
 * structured error (unknown ref or missing key) so the caller can surface it to the model.
 *
 * @param args - Tool arguments before execution; may contain {@link RefSentinel} values at top-level keys.
 * @param store - Session store of prior depth-0 tool outputs.
 * @returns Resolved arguments on success, or an error message when a ref is unknown or a path is missing.
 */
export function resolveRefs(args: unknown, store: ResultStore): ResolveResult {
  if (!isPlainObject(args)) return { ok: true, value: args };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!isRefSentinel(v)) { out[k] = v; continue; }
    const got = store.get(v.$ref);
    if (!got.has) {
      return { ok: false, error: `unknown ref '${v.$ref}'; available: ${store.keys().join(", ") || "(none)"}` };
    }
    if (v.path === undefined) { out[k] = got.value; continue; }
    if (!isPlainObject(got.value) || !(v.path in got.value)) {
      const keys = isPlainObject(got.value) ? Object.keys(got.value).join(", ") : "(not an object)";
      return { ok: false, error: `ref '${v.$ref}' has no key '${v.path}'; keys: ${keys}` };
    }
    out[k] = got.value[v.path];
  }
  return { ok: true, value: out };
}

function shapeOf(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (isPlainObject(value)) return { type: "object", keys: Object.keys(value) };
  if (typeof value === "string") return { type: "string", length: value.length };
  return { type: typeof value };
}

/**
 * Builds the object placed into the model's tool message for a depth-0 tool result. Small values are
 * inlined verbatim (with a `ref` so they can still be referenced); large values are elided to a
 * `{ ok, ref, shape, preview }` handle so the model never receives the full bytes.
 *
 * @param value - Full tool output to describe.
 * @param binding - Binding id assigned to this result for later {@link RefSentinel} references.
 * @returns Either `{ ok, ref, value }` when under {@link ELISION_MAX_BYTES}, or
 *   `{ ok, ref, shape, preview }` when elided.
 */
export function describeForModel(value: unknown, binding: string): unknown {
  const serialized = JSON.stringify(value) ?? "null";
  if (serialized.length <= ELISION_MAX_BYTES) {
    return { ok: true, ref: binding, value };
  }
  const truncated = serialized.slice(0, PREVIEW_CHARS);
  return {
    ok: true,
    ref: binding,
    shape: shapeOf(value),
    preview: serialized.length > PREVIEW_CHARS ? `${truncated}…` : truncated,
  };
}
