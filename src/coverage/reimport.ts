import { z } from "zod";
import type { Observation } from "./observation.js";
import { parseWigleUpload, type WigleUploadRecord } from "../ops/wigleUpload.js";
import { classifyResponse, mergeNormalizations, normalizeWigleRows, type CellScenario, type RowNormalization } from "./wigleRows.js";

/**
 * Audit and reimport of the per-device WiGLE uploads already saved by the controller. The original
 * import kept cell rows opaque and dropped fields the current normalizer preserves, so where an upload
 * retained its raw response, richer records can be recovered from it. Nothing absent from the source is
 * filled in.
 */

export type PayloadShape = {
  parsed: boolean;
  version: number | null;
  storedRecords: number;
  rawResponses: number;
  rawRows: number;
  endpoint: string | null;
  queriedAt: string | null;
  rateLimitedResponses: number;
  error: string | null;
};

export type ReimportAudit = {
  shape: PayloadShape;
  available: boolean;
  reason: string;
  /** Fields present in the retained original that the stored records do not have. */
  recoverableFields: Record<string, number>;
  newRecords: number;
  normalization: Omit<RowNormalization, "records">;
};

const RECOVERABLE_FIELDS = ["ssid", "frequencyMHz", "channel", "encryption", "firstSeen", "lastSeen", "lastUpdated", "attributes", "bluetooth"] as const;

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function payload(payloadJson: string): Record<string, unknown> | null {
  try { return asObject(JSON.parse(payloadJson)); } catch { return null; }
}

/** Inspects a saved upload envelope without throwing when its JSON or expected fields are missing. */
export function payloadShape(payloadJson: string): PayloadShape {
  const blank: PayloadShape = {
    parsed: false, version: null, storedRecords: 0, rawResponses: 0, rawRows: 0,
    endpoint: null, queriedAt: null, rateLimitedResponses: 0, error: null,
  };
  const parsed = payload(payloadJson);
  if (!parsed) return { ...blank, error: "Saved payload is not readable JSON" };
  const raw = Array.isArray(parsed.rawResponses) ? parsed.rawResponses : [];
  const classified = raw.map(classifyResponse);
  const query = asObject(parsed.query);
  return {
    parsed: true,
    version: typeof parsed.version === "number" ? parsed.version : null,
    storedRecords: Array.isArray(parsed.records) ? parsed.records.length : 0,
    rawResponses: raw.length,
    rawRows: classified.reduce((total, response) => total + response.rows.length, 0),
    endpoint: typeof query?.endpoint === "string" ? query.endpoint : null,
    queriedAt: typeof query?.queriedAt === "string" ? query.queriedAt : null,
    rateLimitedResponses: classified.filter((response) => response.kind === "RATE_LIMITED").length,
    error: null,
  };
}

function storedRecords(payloadJson: string): WigleUploadRecord[] {
  const parsed = payload(payloadJson);
  return Array.isArray(parsed?.records) ? parsed!.records as WigleUploadRecord[] : [];
}

function rawResponses(payloadJson: string): unknown[] {
  const parsed = payload(payloadJson);
  return Array.isArray(parsed?.rawResponses) ? parsed!.rawResponses : [];
}

/** Re-runs the current per-device parser over a retained original, for a field-level comparison only. */
export function reparsedUploadRecords(payloadJson: string): WigleUploadRecord[] {
  const records = new Map<string, WigleUploadRecord>();
  for (const response of rawResponses(payloadJson)) {
    let parsed;
    try { parsed = parseWigleUpload(response, { allowEmptyQueryResult: true }); }
    catch { continue; }
    for (const record of parsed.records) {
      const key = `${record.kind}:${record.identifier.toLowerCase()}`;
      const previous = records.get(key);
      if (!previous || Date.parse(record.lastSeen ?? "") >= Date.parse(previous.lastSeen ?? "")) records.set(key, record);
    }
  }
  return [...records.values()];
}

/** Full-fidelity records a reimport would store, including recovered cell identity. */
export function reimportRecords(payloadJson: string, options: { source: string; scenario?: CellScenario | null; now?: number }): {
  records: Observation[];
  normalization: RowNormalization;
} {
  const normalization = rawResponses(payloadJson).reduce<RowNormalization | null>((accumulated, response) => {
    const classified = classifyResponse(response);
    const addition = normalizeWigleRows(classified.rows, { source: options.source, scenario: options.scenario ?? null, now: options.now });
    return accumulated ? mergeNormalizations(accumulated, addition) : addition;
  }, null);
  const empty = normalizeWigleRows([], { source: options.source });
  return { records: normalization?.records ?? [], normalization: normalization ?? empty };
}

/** Reports which records and fields the current normalizers could recover from a saved upload. */
export function auditReimport(payloadJson: string, options: { source: string; scenario?: CellScenario | null; now?: number }): ReimportAudit {
  const shape = payloadShape(payloadJson);
  const { records, normalization } = reimportRecords(payloadJson, options);
  const { records: _ignored, ...normalizationSummary } = normalization;
  if (!shape.parsed || shape.rawResponses === 0) {
    return {
      shape,
      available: false,
      reason: shape.parsed
        ? "This upload kept only normalized records; without the original response, absent fields cannot be recovered."
        : shape.error ?? "Saved payload could not be read",
      recoverableFields: {},
      newRecords: 0,
      normalization: normalizationSummary,
    };
  }
  const stored = new Map(storedRecords(payloadJson).map((record) => [`${record.kind}:${record.identifier.toLowerCase()}`, record]));
  const recoverableFields: Record<string, number> = {};
  let newRecords = 0;
  for (const record of reparsedUploadRecords(payloadJson)) {
    const previous = stored.get(`${record.kind}:${record.identifier.toLowerCase()}`);
    if (!previous) {
      newRecords++;
      continue;
    }
    for (const field of RECOVERABLE_FIELDS) {
      const before = previous[field];
      const after = record[field];
      if ((before === null || before === undefined) && after !== null && after !== undefined) {
        recoverableFields[field] = (recoverableFields[field] ?? 0) + 1;
      }
    }
  }
  const identityRecovered = normalization.cellIdentity.parsed - stored.size >= 0 ? normalization.cellIdentity.parsed : 0;
  return {
    shape,
    available: newRecords > 0 || identityRecovered > 0 || Object.keys(recoverableFields).length > 0 || records.length > stored.size,
    reason: "The original WiGLE response is retained with this upload and can be normalized again.",
    recoverableFields,
    newRecords,
    normalization: normalizationSummary,
  };
}

export const uploadAuditRequestSchema = z.object({
  deviceId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(50).default(25),
}).strict();
