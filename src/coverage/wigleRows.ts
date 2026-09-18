import { z } from "zod";
import { haversineMeters } from "../geo/haversine.js";
import { channelFrequencyMHz } from "./arfcn.js";
import { observationSchema, type Observation } from "./observation.js";
import type { Position } from "../radio/schema.js";

/**
 * Normalizer for the WiGLE payloads this project actually receives: `network/search`, `cell/search` and
 * BLE search responses, plus the aggregated area fetches that carry an `origin`/`radiusKm` and a `kind`
 * per row. It is deliberately separate from the per-device upload parser, which keeps cell rows opaque.
 *
 * Rules that follow from the real responses:
 * - `gentype` is unreliable (an NR row arrived with `gentype: "WCDMA"`), so the radio type is taken from
 *   `attributes`, then `type`, then `gentype`, and disagreements are counted.
 * - Cell identity is read from the underscore-separated WiGLE key (PLMN_AREA_CELL), where the PLMN is
 *   documented as MCC and MNC concatenated to six digits. Nothing is decoded out of the cell number.
 *   WiGLE does not distinguish LAC from TAC: an LTE/NR tracking area occupies the same slot, so the
 *   parsed area code carries whichever the source recorded.
 * - Cellular frequency is never present; it is derived from the channel number only through the fixed
 *   3GPP rasters and labelled as derived.
 * - `transid`, `qos`, `firsttime`, `lasttime` and `lastupdt` are preserved as provenance.
 */

export const cellScenarioSchema = z.object({
  name: z.string().trim().min(1).max(100),
  declaredBy: z.string().trim().min(1).max(200),
  frequencyMHz: z.number().finite().min(1).max(100000).nullable().optional(),
  propagation: z.object({
    referenceDbm: z.number().finite().min(-150).max(30),
    referenceDistanceM: z.number().finite().min(1).max(10000),
    exponent: z.number().finite().min(1).max(6),
    referenceFrequencyMHz: z.number().finite().min(1).max(100000),
  }).strict(),
}).strict();
export type CellScenario = z.infer<typeof cellScenarioSchema>;

export type ResponseKind = "SEARCH" | "AGGREGATE" | "RATE_LIMITED" | "ERROR";

export type ClassifiedResponse = {
  kind: ResponseKind;
  message: string | null;
  rows: unknown[];
  page: {
    totalResults: number | null;
    resultCount: number | null;
    first: number | null;
    last: number | null;
    searchAfter: string | null;
  };
  origin: Position | null;
  radiusKm: number | null;
  /** True when the response is a valid page with no rows, which is coverage information, not a failure. */
  empty: boolean;
};

const RAT_ALIASES: Record<string, string> = {
  LTE: "LTE", "LTE-A": "LTE", LTEA: "LTE", NR: "NR", "5GNR": "NR", "5G": "NR",
  GSM: "GSM", GPRS: "GSM", EDGE: "GSM", UMTS: "WCDMA", WCDMA: "WCDMA", HSPA: "WCDMA",
  "HSPA+": "WCDMA", HSDPA: "WCDMA", HSUPA: "WCDMA", CDMA: "CDMA", EVDO: "CDMA",
};
const MODEL_SUPPORTED_RAT = new Set(["LTE", "NR"]);
const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const CELL_KEY = /^(\d{5,6})_(\d{1,8})_(\d{1,12})$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function text(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value !== "" && !CONTROL.test(value) ? value.slice(0, maxLength) : null;
}

function timestamp(value: unknown, now: number): string | null {
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at > now) return null;
  return new Date(at).toISOString();
}

/** Classifies a WiGLE payload as a search page, aggregate, rate-limit or balance refusal, or error. */
export function classifyResponse(value: unknown): ClassifiedResponse {
  const empty: ClassifiedResponse = {
    kind: "ERROR", message: "Unrecognized response", rows: [],
    page: { totalResults: null, resultCount: null, first: null, last: null, searchAfter: null },
    origin: null, radiusKm: null, empty: true,
  };
  const response = asObject(value);
  if (!response) return empty;
  const message = text(response.message ?? response.error, 300);
  if (response.success === false) {
    // "Too many queries today" is the documented daily-allowance refusal; "insufficient balance" is the
    // commercial-token equivalent. Both mean "cannot query now", so both pause an ingest rather than fail it.
    const rateLimited = /too many queries|rate limit|quota|insufficient balance/i.test(message ?? "");
    return { ...empty, kind: rateLimited ? "RATE_LIMITED" : "ERROR", message: message ?? "WiGLE reported a failed search" };
  }
  if (!Array.isArray(response.results)) return empty;
  const rows = response.results;
  const origin = asObject(response.origin);
  const aggregated = response.source === "airgrid" || rows.some((row) => typeof asObject(row)?.kind === "string");
  return {
    kind: aggregated ? "AGGREGATE" : "SEARCH",
    message,
    rows,
    page: {
      totalResults: integer(response.totalResults),
      resultCount: integer(response.resultCount),
      first: integer(response.first),
      last: integer(response.last),
      searchAfter: text(response.searchAfter, 100),
    },
    origin: origin && typeof origin.lat === "number" && typeof origin.lng === "number" ? { lat: origin.lat, lng: origin.lng } : null,
    radiusKm: typeof response.radiusKm === "number" ? response.radiusKm : null,
    empty: rows.length === 0,
  };
}

/**
 * Splits a WiGLE cell key into its stated parts. A five-digit PLMN prefix is ambiguous between a
 * two-digit and a three-digit MNC; the ambiguity is reported rather than resolved by guessing.
 */
export function parseCellKey(value: unknown): {
  mcc: string; mnc: string; areaCode: number; cellId: number; mncDigits: number; ambiguousMnc: boolean;
} | null {
  if (typeof value !== "string") return null;
  const match = CELL_KEY.exec(value.trim());
  if (!match) return null;
  const plmn = match[1]!;
  const mcc = plmn.slice(0, 3);
  const mnc = plmn.slice(3);
  const areaCode = Number(match[2]);
  const cellId = Number(match[3]);
  if (!Number.isSafeInteger(areaCode) || !Number.isSafeInteger(cellId)) return null;
  return { mcc, mnc, areaCode, cellId, mncDigits: mnc.length, ambiguousMnc: mnc.length === 2 };
}

function plmnFromAttributes(attributes: string | null): string | null {
  const parts = (attributes ?? "").split(";").map((part) => part.trim());
  return parts.find((part) => /^\d{5,6}$/.test(part)) ?? null;
}

function ratCandidates(row: Record<string, unknown>): Array<{ value: string; source: "ATTRIBUTES" | "TYPE" | "GENTYPE" }> {
  const attributes = text(row.attributes, 200);
  const first = (attributes ?? "").split(";")[0]?.trim().toUpperCase();
  const candidates: Array<{ value: string; source: "ATTRIBUTES" | "TYPE" | "GENTYPE" }> = [];
  if (first) candidates.push({ value: first, source: "ATTRIBUTES" });
  const type = text(row.type, 40)?.toUpperCase();
  if (type) candidates.push({ value: type, source: "TYPE" });
  const gentype = text(row.gentype, 40)?.toUpperCase();
  if (gentype) candidates.push({ value: gentype, source: "GENTYPE" });
  return candidates;
}

function wifiFrequency(row: Record<string, unknown>): { frequencyMHz: number | null; source: Observation["frequencySource"] } {
  const reported = integer(row.frequency);
  if (reported && reported >= 1 && reported <= 100_000) return { frequencyMHz: reported, source: "SOURCE" };
  const channel = integer(row.channel);
  if (channel === null) return { frequencyMHz: null, source: null };
  // 2.4 GHz and 5 GHz channel plans only. 6 GHz channel numbers overlap the 2.4 GHz set, so they are
  // left unknown rather than resolved by assuming a band.
  if (channel >= 1 && channel <= 13) return { frequencyMHz: 2412 + 5 * (channel - 1), source: "DERIVED_WIFI_CHANNEL" };
  if (channel === 14) return { frequencyMHz: 2484, source: "DERIVED_WIFI_CHANNEL" };
  if (channel >= 32 && channel <= 177) return { frequencyMHz: 5000 + 5 * channel, source: "DERIVED_WIFI_CHANNEL" };
  return { frequencyMHz: null, source: null };
}

export type RowNormalization = {
  records: Observation[];
  rejected: Record<string, number>;
  byKind: Record<"WIFI" | "CELL" | "BLUETOOTH", number>;
  ratCounts: Record<string, number>;
  unsupportedRat: Record<string, number>;
  ratDisagreements: number;
  plmnCounts: Record<string, number>;
  plmnDisagreements: number;
  cellIdentity: { parsed: number; ambiguousMnc: number; unsupportedRat: number; withDerivedFrequency: number; withScenarioPropagation: number };
  derivedFrequencies: Record<string, number>;
  bleRows: number;
  transidPresent: number;
  qosDistribution: Record<string, number>;
  outsideRadius: number;
};

function emptyNormalization(): RowNormalization {
  return {
    records: [], rejected: {}, byKind: { WIFI: 0, CELL: 0, BLUETOOTH: 0 }, ratCounts: {}, unsupportedRat: {},
    ratDisagreements: 0, plmnCounts: {}, plmnDisagreements: 0,
    cellIdentity: { parsed: 0, ambiguousMnc: 0, unsupportedRat: 0, withDerivedFrequency: 0, withScenarioPropagation: 0 },
    derivedFrequencies: {}, bleRows: 0, transidPresent: 0, qosDistribution: {}, outsideRadius: 0,
  };
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * Normalizes WiGLE result rows into stored observations. Rows are rejected, with a counted reason, when
 * their identity cannot be read; no row is repaired by inference.
 */
export function normalizeWigleRows(rows: readonly unknown[], options: {
  source: string;
  scenario?: CellScenario | null;
  area?: { center: Position; radiusM: number } | null;
  now?: number;
}): RowNormalization {
  const now = options.now ?? Date.now();
  const scenario = options.scenario ?? null;
  const result = emptyNormalization();
  for (const value of rows) {
    const row = asObject(value);
    if (!row) {
      bump(result.rejected, "ROW_NOT_AN_OBJECT");
      continue;
    }
    const lat = typeof row.trilat === "number" ? row.trilat : null;
    const lng = typeof row.trilong === "number" ? row.trilong : null;
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      bump(result.rejected, "MISSING_OR_INVALID_LOCATION");
      continue;
    }
    if (options.area && haversineMeters(options.area.center.lat, options.area.center.lng, lat, lng) > options.area.radiusM) {
      result.outsideRadius++;
      continue;
    }
    const declaredKind = text(row.kind, 20)?.toUpperCase();
    const netid = text(row.netid, 200);
    const cellKeyText = netid && CELL_KEY.test(netid) ? netid : text(row.id, 200);
    const candidates = ratCandidates(row);
    const bleRow = candidates.some((candidate) => candidate.value === "BLE" || candidate.value === "BT");
    let kind: "WIFI" | "CELL" | "BLUETOOTH";
    if (declaredKind === "WIFI" || declaredKind === "CELL" || declaredKind === "BLUETOOTH") kind = declaredKind;
    else if (bleRow) kind = "BLUETOOTH";
    else if (netid && MAC.test(netid)) kind = "WIFI";
    else if (parseCellKey(cellKeyText)) kind = "CELL";
    else {
      bump(result.rejected, "UNCLASSIFIED_ROW");
      continue;
    }

    const attributes = text(row.attributes, 1024);
    const base = {
      lat, lng,
      ssid: text(row.ssid, kind === "WIFI" ? 64 : 256),
      qos: integer(row.qos) !== null && integer(row.qos)! >= 0 && integer(row.qos)! <= 7 ? integer(row.qos) : null,
      firstSeen: timestamp(row.firsttime, now),
      lastSeen: timestamp(row.lasttime, now),
      lastUpdated: timestamp(row.lastupdt, now),
      source: options.source,
      channel: integer(row.channel),
      encryption: text(row.encryption, 256),
      attributes,
      transid: text(row.transid, 64),
    };
    bump(result.qosDistribution, base.qos === null ? "unknown" : String(base.qos));
    if (base.transid) result.transidPresent++;

    if (kind === "WIFI" || kind === "BLUETOOTH") {
      const address = netid?.toLowerCase() ?? null;
      if (!address || !MAC.test(address) || address === "00:00:00:00:00:00" || address === "ff:ff:ff:ff:ff:ff") {
        bump(result.rejected, kind === "WIFI" ? "INVALID_BSSID" : "INVALID_BLUETOOTH_ADDRESS");
        continue;
      }
      if (kind === "WIFI" && (Number.parseInt(address.slice(0, 2), 16) & 1) !== 0) {
        bump(result.rejected, "MULTICAST_BSSID");
        continue;
      }
      const frequency = kind === "WIFI" ? wifiFrequency(row) : { frequencyMHz: null, source: null as Observation["frequencySource"] };
      if (frequency.source === "DERIVED_WIFI_CHANNEL") bump(result.derivedFrequencies, "WIFI_CHANNEL");
      const capabilities = Array.isArray(row.capabilities)
        ? row.capabilities.map((entry) => text(entry, 100)).filter((entry): entry is string => entry !== null).slice(0, 50)
        : null;
      const parsed = observationSchema.safeParse({
        ...base,
        kind,
        identifier: address,
        radio: kind === "BLUETOOTH" ? (bleRow ? (text(row.type, 20)?.toUpperCase() ?? "BLE") : "BT") : null,
        wifiType: kind === "WIFI" ? text(row.type, 20) ?? undefined : undefined,
        frequencyMHz: frequency.frequencyMHz,
        frequencySource: frequency.source,
        ...(kind === "BLUETOOTH" ? {
          ble: bleRow,
          bluetooth: {
            name: text(row.name, 256) ?? text(row.ssid, 256),
            manufacturerId: integer(row.mfgrId) !== null && integer(row.mfgrId)! <= 65535 ? integer(row.mfgrId) : null,
            deviceClass: integer(row.device),
            capabilities,
          },
        } : {}),
      });
      if (!parsed.success) {
        bump(result.rejected, `SCHEMA_${kind}`);
        continue;
      }
      if (kind === "BLUETOOTH" && bleRow) result.bleRows++;
      result.records.push(parsed.data);
      result.byKind[kind]++;
      continue;
    }

    const key = parseCellKey(cellKeyText);
    if (!key) {
      bump(result.rejected, "UNPARSABLE_CELL_KEY");
      continue;
    }
    const mapped = candidates.map((candidate) => ({ ...candidate, rat: RAT_ALIASES[candidate.value] ?? null }));
    const resolved = mapped.find((candidate) => candidate.rat !== null) ?? null;
    const distinct = new Set(mapped.filter((candidate) => candidate.rat).map((candidate) => candidate.rat));
    if (distinct.size > 1) result.ratDisagreements++;
    const ratLabel = resolved?.rat ?? "UNKNOWN";
    bump(result.ratCounts, ratLabel);
    const attributePlmn = plmnFromAttributes(attributes);
    if (attributePlmn && attributePlmn !== `${key.mcc}${key.mnc}`) result.plmnDisagreements++;
    bump(result.plmnCounts, `${key.mcc}-${key.mnc}`);
    result.cellIdentity.parsed++;
    if (key.ambiguousMnc) result.cellIdentity.ambiguousMnc++;

    const identifier = cellKeyText!;
    if (!MODEL_SUPPORTED_RAT.has(ratLabel)) {
      bump(result.unsupportedRat, ratLabel);
      result.cellIdentity.unsupportedRat++;
      // Kept as an opaque cell observation: real coverage information the model cannot use yet.
      const parsed = observationSchema.safeParse({
        ...base, kind: "CELL", identifier, radio: ratLabel === "UNKNOWN" ? null : ratLabel,
        frequencyMHz: null, frequencySource: null, ratSource: resolved?.source ?? null, cell: null, propagation: null,
      });
      if (parsed.success) {
        result.records.push(parsed.data);
        result.byKind.CELL++;
      } else bump(result.rejected, "SCHEMA_CELL_OPAQUE");
      continue;
    }
    const rat = ratLabel as "LTE" | "NR";
    const derived = channelFrequencyMHz(rat, base.channel);
    if (derived) {
      bump(result.derivedFrequencies, derived.source);
      result.cellIdentity.withDerivedFrequency++;
    }
    const frequencyMHz = derived?.frequencyMHz ?? scenario?.frequencyMHz ?? null;
    const frequencySource = derived ? derived.source : scenario?.frequencyMHz ? "SOURCE" : null;
    if (scenario) result.cellIdentity.withScenarioPropagation++;
    const parsed = observationSchema.safeParse({
      ...base,
      kind: "CELL",
      identifier,
      radio: rat,
      frequencyMHz,
      frequencySource,
      ratSource: resolved?.source ?? null,
      cell: { rat, mcc: key.mcc, mnc: key.mnc, areaCode: key.areaCode, cellId: key.cellId, channel: base.channel },
      propagation: scenario?.propagation ?? null,
      propagationSource: scenario ? `SCENARIO:${scenario.name} (declared by ${scenario.declaredBy})` : null,
    });
    if (!parsed.success) {
      // Identity outside the schema's LTE/NR ranges, e.g. an LTE cell number above the 28-bit limit.
      bump(result.rejected, "CELL_IDENTITY_OUT_OF_RANGE");
      continue;
    }
    result.records.push(parsed.data);
    result.byKind.CELL++;
  }
  return result;
}

/** Mutates a normalization summary by appending records and accumulating every counter. */
export function mergeNormalizations(target: RowNormalization, addition: RowNormalization): RowNormalization {
  target.records.push(...addition.records);
  for (const [key, count] of Object.entries(addition.rejected)) target.rejected[key] = (target.rejected[key] ?? 0) + count;
  for (const kind of ["WIFI", "CELL", "BLUETOOTH"] as const) target.byKind[kind] += addition.byKind[kind];
  for (const [key, count] of Object.entries(addition.ratCounts)) target.ratCounts[key] = (target.ratCounts[key] ?? 0) + count;
  for (const [key, count] of Object.entries(addition.unsupportedRat)) target.unsupportedRat[key] = (target.unsupportedRat[key] ?? 0) + count;
  for (const [key, count] of Object.entries(addition.plmnCounts)) target.plmnCounts[key] = (target.plmnCounts[key] ?? 0) + count;
  for (const [key, count] of Object.entries(addition.derivedFrequencies)) target.derivedFrequencies[key] = (target.derivedFrequencies[key] ?? 0) + count;
  for (const [key, count] of Object.entries(addition.qosDistribution)) target.qosDistribution[key] = (target.qosDistribution[key] ?? 0) + count;
  target.ratDisagreements += addition.ratDisagreements;
  target.plmnDisagreements += addition.plmnDisagreements;
  target.bleRows += addition.bleRows;
  target.transidPresent += addition.transidPresent;
  target.outsideRadius += addition.outsideRadius;
  target.cellIdentity.parsed += addition.cellIdentity.parsed;
  target.cellIdentity.ambiguousMnc += addition.cellIdentity.ambiguousMnc;
  target.cellIdentity.unsupportedRat += addition.cellIdentity.unsupportedRat;
  target.cellIdentity.withDerivedFrequency += addition.cellIdentity.withDerivedFrequency;
  target.cellIdentity.withScenarioPropagation += addition.cellIdentity.withScenarioPropagation;
  return target;
}
