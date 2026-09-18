import { radioRecordSchema, recordKey, type RadioRecord } from "../radio/schema.js";
import { ENGINE_OBSERVATION_LIMIT, usability, type MissingField } from "./usability.js";

export const KINDS = ["WIFI", "CELL", "BLUETOOTH"] as const;
export type Kind = (typeof KINDS)[number];

/** Matches the 18-month recency warning already used for saved Wi-Fi observations. */
export const STALE_AFTER_MS = Math.round((18 * 365.25 / 12) * 86_400_000);

export type ParsedDataset = {
  records: RadioRecord[];
  /** Saved rows the current schema rejects. They are unavailable to the engine, not silently repaired. */
  invalid: number;
  invalidReasons: Record<string, number>;
  duplicateIdentities: string[];
};

export type DateSpan = {
  oldestLastSeen: string | null;
  newestLastSeen: string | null;
  unknownLastSeen: number;
  olderThanEighteenMonths: number;
};

export type KindAudit = {
  records: number;
  usable: number;
  unusable: number;
  missing: Partial<Record<MissingField, number>>;
  unknown: Record<string, number>;
};

export type SourceAudit = {
  source: string;
  records: number;
  kinds: Record<Kind, number>;
  usable: number;
} & DateSpan;

export type DatasetAudit = {
  totalRecords: number;
  byKind: Record<Kind, KindAudit>;
  dates: DateSpan;
  sources: SourceAudit[];
  capacity: {
    limit: number;
    used: number;
    headroom: number;
    atLimit: boolean;
  };
  invalid: number;
  invalidReasons: Record<string, number>;
  duplicateIdentities: string[];
};

function count(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** Parses saved dataset rows one at a time so a single unusable row is visible instead of failing the report. */
export function parseDataset(value: unknown): ParsedDataset {
  const rows = Array.isArray(value) ? value : [];
  const records: RadioRecord[] = [];
  const invalidReasons: Record<string, number> = {};
  const seen = new Set<string>();
  const duplicateIdentities: string[] = [];
  let invalid = 0;
  for (const row of rows) {
    const parsed = radioRecordSchema.safeParse(row);
    if (!parsed.success) {
      invalid++;
      const issue = parsed.error.issues[0];
      count(invalidReasons, issue ? `${issue.path.join(".") || "record"}: ${issue.message}` : "unparsable record");
      continue;
    }
    const key = recordKey(parsed.data);
    if (seen.has(key)) duplicateIdentities.push(key);
    else seen.add(key);
    records.push(parsed.data);
  }
  return { records, invalid, invalidReasons, duplicateIdentities };
}

/** Summarizes observation dates, falling back to catalog update dates when last-seen dates are absent. */
export function dateSpan(records: readonly RadioRecord[], now = Date.now()): DateSpan {
  let oldest: number | null = null;
  let newest: number | null = null;
  let unknownLastSeen = 0;
  let olderThanEighteenMonths = 0;
  for (const record of records) {
    const at = Date.parse(record.lastSeen ?? record.lastUpdated ?? "");
    if (!Number.isFinite(at)) {
      unknownLastSeen++;
      continue;
    }
    oldest = oldest === null ? at : Math.min(oldest, at);
    newest = newest === null ? at : Math.max(newest, at);
    if (now - at > STALE_AFTER_MS) olderThanEighteenMonths++;
  }
  return {
    oldestLastSeen: oldest === null ? null : new Date(oldest).toISOString(),
    newestLastSeen: newest === null ? null : new Date(newest).toISOString(),
    unknownLastSeen,
    olderThanEighteenMonths,
  };
}

function mergeCounters<T extends Record<string, number | undefined>>(a: T, b: T): T {
  const merged: Record<string, number> = {};
  for (const source of [a, b]) {
    for (const [key, value] of Object.entries(source)) merged[key] = (merged[key] ?? 0) + (value ?? 0);
  }
  return merged as T;
}

function mergeSpans(a: DateSpan, b: DateSpan): DateSpan {
  const oldest = [a.oldestLastSeen, b.oldestLastSeen].filter((value): value is string => value !== null).sort();
  const newest = [a.newestLastSeen, b.newestLastSeen].filter((value): value is string => value !== null).sort();
  return {
    oldestLastSeen: oldest[0] ?? null,
    newestLastSeen: newest[newest.length - 1] ?? null,
    unknownLastSeen: a.unknownLastSeen + b.unknownLastSeen,
    olderThanEighteenMonths: a.olderThanEighteenMonths + b.olderThanEighteenMonths,
  };
}

/** Combines per-tile audits so a large service area is never audited in one pass. */
export function mergeAudits(a: DatasetAudit, b: DatasetAudit): DatasetAudit {
  const sources = new Map<string, SourceAudit>();
  for (const source of [...a.sources, ...b.sources]) {
    const previous = sources.get(source.source);
    sources.set(source.source, previous
      ? {
        source: source.source,
        records: previous.records + source.records,
        kinds: mergeCounters(previous.kinds, source.kinds),
        usable: previous.usable + source.usable,
        ...mergeSpans(previous, source),
      }
      : source);
  }
  const totalRecords = a.totalRecords + b.totalRecords;
  return {
    totalRecords,
    byKind: Object.fromEntries(KINDS.map((kind) => [kind, {
      records: a.byKind[kind].records + b.byKind[kind].records,
      usable: a.byKind[kind].usable + b.byKind[kind].usable,
      unusable: a.byKind[kind].unusable + b.byKind[kind].unusable,
      missing: mergeCounters(a.byKind[kind].missing, b.byKind[kind].missing),
      unknown: mergeCounters(a.byKind[kind].unknown, b.byKind[kind].unknown),
    }])) as Record<Kind, KindAudit>,
    dates: mergeSpans(a.dates, b.dates),
    sources: [...sources.values()].sort((x, y) => y.records - x.records || x.source.localeCompare(y.source)),
    capacity: {
      limit: ENGINE_OBSERVATION_LIMIT,
      used: totalRecords,
      headroom: Math.max(0, ENGINE_OBSERVATION_LIMIT - totalRecords),
      atLimit: totalRecords >= ENGINE_OBSERVATION_LIMIT,
    },
    invalid: a.invalid + b.invalid,
    invalidReasons: mergeCounters(a.invalidReasons, b.invalidReasons),
    duplicateIdentities: [...new Set([...a.duplicateIdentities, ...b.duplicateIdentities])].slice(0, 20),
  };
}

/** Field-level audit of what the saved dataset can actually give the model (E02). */
export function auditDataset(parsed: ParsedDataset, now = Date.now()): DatasetAudit {
  const byKind = Object.fromEntries(KINDS.map((kind) => [kind, {
    records: 0, usable: 0, unusable: 0, missing: {}, unknown: {},
  } as KindAudit])) as Record<Kind, KindAudit>;
  const bySource = new Map<string, RadioRecord[]>();
  for (const record of parsed.records) {
    const audit = byKind[record.kind];
    const result = usability(record);
    audit.records++;
    if (result.usable) audit.usable++;
    else audit.unusable++;
    for (const field of result.missing) audit.missing[field] = (audit.missing[field] ?? 0) + 1;
    for (const note of result.unknown) count(audit.unknown, note);
    const source = record.source || "Unknown source";
    const list = bySource.get(source) ?? [];
    list.push(record);
    bySource.set(source, list);
  }
  const sources: SourceAudit[] = [...bySource.entries()].map(([source, list]) => ({
    source,
    records: list.length,
    kinds: Object.fromEntries(KINDS.map((kind) => [kind, list.filter((r) => r.kind === kind).length])) as Record<Kind, number>,
    usable: list.filter((record) => usability(record).usable).length,
    ...dateSpan(list, now),
  })).sort((a, b) => b.records - a.records || a.source.localeCompare(b.source));
  const used = parsed.records.length;
  return {
    totalRecords: used,
    byKind,
    dates: dateSpan(parsed.records, now),
    sources,
    capacity: {
      limit: ENGINE_OBSERVATION_LIMIT,
      used,
      headroom: Math.max(0, ENGINE_OBSERVATION_LIMIT - used),
      atLimit: used >= ENGINE_OBSERVATION_LIMIT,
    },
    invalid: parsed.invalid,
    invalidReasons: parsed.invalidReasons,
    duplicateIdentities: [...new Set(parsed.duplicateIdentities)].slice(0, 20),
  };
}
