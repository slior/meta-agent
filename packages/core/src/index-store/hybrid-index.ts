import type { CatalogEntry, FindResult } from "../types.ts";
import type { ToolRegistry } from "../registry/interface.ts";
import type { ToolIndex } from "./interface.ts";

const TOKEN_RE = /[a-z0-9]+/gi;

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) out.push(m[0]);
  return out;
}

function firstSentence(desc: string, max: number): string {
  const s = desc.trim().split(/(?<=[.!?])\s/)[0] ?? desc.trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export class HybridToolIndex implements ToolIndex {
  private readonly registry: ToolRegistry;

  private constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  static async open(registry: ToolRegistry): Promise<HybridToolIndex> {
    return new HybridToolIndex(registry);
  }

  catalog(opts: { maxEntries?: number } = {}): CatalogEntry[] {
    const max = opts.maxEntries ?? 40;
    return this.registry.listSync().slice(0, max).map((s) => ({
      name: s.name,
      shortDescription: firstSentence(s.description, 80),
      kind: s.kind,
    }));
  }

  async find(query: string, opts: { k?: number } = {}): Promise<FindResult[]> {
    const k = opts.k ?? 5;
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    const qSet = new Set(qTokens);
    const tools = await this.registry.list();

    const corpus = await Promise.all(tools.map(async (t) => {
      const full = await this.registry.get(t.name);
      const text = [t.name, t.description, full?.manifest.rationale ?? ""].join(" ");
      return { name: t.name, description: t.description, inputSchema: full?.manifest.inputSchema ?? {}, tokens: tokenize(text) };
    }));

    const df = new Map<string, number>();
    for (const doc of corpus) {
      const seen = new Set(doc.tokens);
      for (const tok of seen) df.set(tok, (df.get(tok) ?? 0) + 1);
    }
    const N = corpus.length || 1;

    const scored: FindResult[] = corpus.map((doc) => {
      let score = 0;
      const spans: string[] = [];

      const nameTokens = tokenize(doc.name);
      if (nameTokens.some((t) => qSet.has(t))) { score += 4; spans.push(doc.name); }
      if (doc.description.toLowerCase().includes(query.toLowerCase())) {
        score += 2; spans.push(doc.description);
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

      return { name: doc.name, description: doc.description, inputSchema: doc.inputSchema as Record<string, unknown>, score, matchSpans: spans };
    });

    return scored.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }
}
