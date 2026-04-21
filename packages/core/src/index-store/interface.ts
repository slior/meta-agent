import type { CatalogEntry, FindResult } from "../types.ts";

export interface ToolIndex {
  catalog(opts?: { maxEntries?: number }): CatalogEntry[];
  find(query: string, opts?: { k?: number }): Promise<FindResult[]>;
}
