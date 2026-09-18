import type { RadioRecord } from "../radio/schema.js";
import type { Kind } from "./inventory.js";

/**
 * Process-local cache of parsed dataset tiles, shared by every phone in the same service area.
 * Entries are keyed by dataset revision, so an occasional refresh publishes a new revision instead of
 * mutating the world an active run is pinned to. Cached arrays are frozen: phones share source
 * observations, never mutable runtime state.
 */
export type CachedTile = {
  revisionId: string;
  kind: Kind;
  tileKey: string;
  records: readonly RadioRecord[];
};

export type TileCacheStats = {
  tiles: number;
  records: number;
  maxRecords: number;
  hits: number;
  misses: number;
  evictions: number;
};

function freezeRecords(records: RadioRecord[]): readonly RadioRecord[] {
  for (const record of records) {
    if (record.cell) Object.freeze(record.cell);
    if (record.propagation) Object.freeze(record.propagation);
    if (record.bluetooth) Object.freeze(record.bluetooth);
    Object.freeze(record);
  }
  return Object.freeze(records);
}

export class TileCache {
  private entries = new Map<string, CachedTile>();
  private records = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly maxRecords = 250_000) {}

  private static id(revisionId: string, kind: Kind, tileKey: string): string {
    return `${revisionId}|${kind}|${tileKey}`;
  }

  get(revisionId: string, kind: Kind, tileKey: string): readonly RadioRecord[] | undefined {
    const id = TileCache.id(revisionId, kind, tileKey);
    const entry = this.entries.get(id);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.records;
  }

  set(revisionId: string, kind: Kind, tileKey: string, records: RadioRecord[]): readonly RadioRecord[] {
    const frozen = freezeRecords(records);
    const id = TileCache.id(revisionId, kind, tileKey);
    const previous = this.entries.get(id);
    if (previous) this.records -= previous.records.length;
    this.entries.set(id, { revisionId, kind, tileKey, records: frozen });
    this.records += frozen.length;
    for (const [key, entry] of this.entries) {
      if (this.records <= this.maxRecords) break;
      if (key === id) continue;
      this.entries.delete(key);
      this.records -= entry.records.length;
      this.evictions++;
    }
    return frozen;
  }

  /** Drops one revision without disturbing others, so a superseded refresh frees memory immediately. */
  dropRevision(revisionId: string): number {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.revisionId !== revisionId) continue;
      this.entries.delete(key);
      this.records -= entry.records.length;
      dropped++;
    }
    return dropped;
  }

  stats(): TileCacheStats {
    return { tiles: this.entries.size, records: this.records, maxRecords: this.maxRecords, hits: this.hits, misses: this.misses, evictions: this.evictions };
  }

  reset(): void {
    this.entries.clear();
    this.records = 0;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
}

export const tileCache = new TileCache();
