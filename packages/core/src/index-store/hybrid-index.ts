import { FIND_TOOL_TOP_K } from "../agent/meta-tools.ts";
import type { CatalogEntry, FindResult, ToolSummary } from "../types.ts";
import type { ToolRegistry } from "../registry/tool-registry.ts";
import type { ToolIndex } from "./interface.ts";

const TOKEN_RE = /[a-z0-9]+/gi;

/** Default cap for {@link HybridToolIndex.catalog}; sized for system prompt real estate. */
const DEFAULT_CATALOG_MAX_ENTRIES = 40;

/** Max length for one-line descriptions in catalog entries (same cap as AgentLoop catalog previews). */
const CATALOG_DESCRIPTION_PREVIEW_MAX = 80;

/** Score bump when any token from the query appears in the tool name tokens. */
const SCORE_WEIGHT_NAME_TOKEN_OVERLAP = 4;

/** Score bump when the raw query appears as a substring of the description (case-insensitive). */
const SCORE_WEIGHT_DESCRIPTION_SUBSTRING = 2;

type CorpusDoc = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  tokens: string[];
};

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) out.push(m[0]);
  return out;
}

function firstSentence(desc: string, max: number): string {
  const s = desc.trim().split(/(?<=[.!?])\s/)[0] ?? desc.trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function documentFrequency(corpus: CorpusDoc[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of corpus) {
    const seen = new Set(doc.tokens);
    for (const tok of seen) df.set(tok, (df.get(tok) ?? 0) + 1);
  }
  return df;
}

function scoreCorpus(
  corpus: CorpusDoc[],
  qTokens: string[],
  qSet: Set<string>,
  queryLower: string,
  df: Map<string, number>,
): FindResult[] {
  const N = corpus.length || 1;

  return corpus.map((doc) => {
    let score = 0;
    const spans: string[] = [];

    const nameTokens = tokenize(doc.name);
    if (nameTokens.some((t) => qSet.has(t))) {
      score += SCORE_WEIGHT_NAME_TOKEN_OVERLAP;
      spans.push(doc.name);
    }
    if (doc.description.toLowerCase().includes(queryLower)) {
      score += SCORE_WEIGHT_DESCRIPTION_SUBSTRING;
      spans.push(doc.description);
    }

    const tf = new Map<string, number>();
    for (const tok of doc.tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
    for (const q of qTokens) {
      const t = tf.get(q) ?? 0;
      if (t === 0) continue;
      const idf = Math.log(1 + N / (df.get(q) ?? 1));
      score += t * idf;
    }

    const overlap = qTokens.filter((t) => doc.tokens.includes(t)).length / qTokens.length;
    score += overlap;

    return {
      name: doc.name,
      description: doc.description,
      inputSchema: doc.inputSchema,
      score,
      matchSpans: spans,
    };
  });
}

/**
 * HybridToolIndex provides an implementation of the ToolIndex interface,
 * offering hybrid in-memory and registry-backed capabilities for tool indexing, cataloging, and search.
 *
 * Responsibilities:
 *   - Maintains a reference to an underlying ToolRegistry for listing and accessing tool definitions.
 *   - Allows efficient top-K search via a simple text similarity ranking (TF-IDF inspired).
 *   - Provides a concise catalog summary for UI or API consumption.
 *
 * Methods:
 *   - static async open(registry): Factory for constructing an instance, may be extended to async initialization.
 *   - catalog(opts): Returns an array of CatalogEntry, containing summary information about available tools.
 *   - find(query, opts): Searches the tools for matches to the user query string, returning ranked matches with scores.
 *
 * Internals:
 *   - buildCorpus(tools): Constructs a search corpus with tokenized fields for each tool,
 *     using tool name, description, and rationale for more meaningful scoring.
 */
export class HybridToolIndex implements ToolIndex {
  private readonly registry: ToolRegistry;

  /**
   * Private constructor; use static open() to instantiate.
   * @param registry - The ToolRegistry instance providing tool metadata and code access.
   */
  private constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /**
   * Asynchronously creates and returns an instance of HybridToolIndex.
   * @param registry - The ToolRegistry to use as the backend data source.
   */
  static async open(registry: ToolRegistry): Promise<HybridToolIndex> {
    return new HybridToolIndex(registry);
  }

  /**
   * Returns a summary catalog of available tools, limited by maxEntries.
   * Entries provide the tool name, a short description (first sentence, truncated),
   * and the kind of tool.
   * @param opts - Optional configuration, e.g., { maxEntries }
   */
  catalog(opts: { maxEntries?: number } = {}): CatalogEntry[] {
    const max = opts.maxEntries ?? DEFAULT_CATALOG_MAX_ENTRIES;
    return this.registry.listSync().slice(0, max).map((s) => ({
      name: s.name,
      shortDescription: firstSentence(s.description, CATALOG_DESCRIPTION_PREVIEW_MAX),
      kind: s.kind,
    }));
  }

  /**
   * Performs a ranked search for tools matching the given query string.
   * The search ranks by token overlap (name, description, rationale) and TF-IDF-inspired scoring.
   * @param query - The search string to match against tool metadata.
   * @param opts - Optional parameters (e.g., k: max number of results, default FIND_TOOL_TOP_K)
   * @returns An array of FindResult objects, each describing a matching tool and its score.
   */
  async find(query: string, opts: { k?: number } = {}): Promise<FindResult[]> {
    const k = opts.k ?? FIND_TOOL_TOP_K.default;
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    const qSet = new Set(qTokens);
    const queryLower = query.toLowerCase();
    const tools = await this.registry.list();
    const corpus = await this.buildCorpus(tools);
    const df = documentFrequency(corpus);
    const scored = scoreCorpus(corpus, qTokens, qSet, queryLower, df);
    return scored.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }

  /**
   * Internal helper to build the search corpus for tools.
   * Tokenizes name, description, and rationale for each tool for richer semantic search.
   * @param tools - Array of ToolSummary entries to extract details from.
   * @returns Promise resolving to an array of CorpusDoc for search processing.
   * @private
   */
  private async buildCorpus(tools: ToolSummary[]): Promise<CorpusDoc[]> {
    return Promise.all(
      tools.map(async (t) => {
        const full = await this.registry.get(t.name);
        const text = [t.name, t.description, full?.manifest.rationale ?? ""].join(" ");
        return {
          name: t.name,
          description: t.description,
          inputSchema: (full?.manifest.inputSchema ?? {}) as Record<string, unknown>,
          tokens: tokenize(text),
        };
      }),
    );
  }
}
