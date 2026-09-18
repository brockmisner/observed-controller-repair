import { z } from "zod";
import { radioRecordSchema, type RadioRecord } from "../radio/schema.js";

/**
 * Stored observation: the shared radio record plus the source provenance an operator needs to judge it.
 * The engine parses only its own fields, so these extras travel with saved data without changing the
 * runtime protocol. Every derived value names its derivation instead of passing as a measurement.
 */
export const observationSchema = radioRecordSchema.extend({
  /** WiGLE upload/transaction identifier for the row this record came from. */
  transid: z.string().max(64).nullable().optional(),
  frequencySource: z.enum(["SOURCE", "DERIVED_EARFCN", "DERIVED_NR_ARFCN", "DERIVED_WIFI_CHANNEL"]).nullable().optional(),
  propagationSource: z.string().max(200).nullable().optional(),
  ratSource: z.enum(["ATTRIBUTES", "TYPE", "GENTYPE"]).nullable().optional(),
  /** True for rows the source marked BLE, whose advertised names and addresses rotate. */
  ble: z.boolean().optional(),
});
export type Observation = z.infer<typeof observationSchema>;

export type ConfidenceTier = "STRONG" | "FAIR" | "WEAK" | "UNKNOWN";

/**
 * Confidence policy for a saved observation, from the two fields WiGLE actually provides:
 * `qos` (its own quality score, 0-7) and the record dates. Observation age uses `lasttime` — when the
 * network was last seen — while `lastupdt` shows when the catalogue entry last changed. A record can be
 * freshly updated and still describe a years-old sighting, so both are reported.
 */
export const CONFIDENCE_POLICY = {
  strong: { maxObservationAgeDays: 365, minQos: 4 },
  fair: { maxObservationAgeDays: 1095, minQos: 2 },
} as const;

export type Confidence = {
  tier: ConfidenceTier;
  qos: number | null;
  observationAgeDays: number | null;
  catalogueAgeDays: number | null;
  reasons: string[];
};

function ageDays(value: string | null | undefined, now: number): number | null {
  const at = Date.parse(value ?? "");
  return Number.isFinite(at) ? Math.round((now - at) / 86_400_000) : null;
}

/** Applies the source-quality and observation-age policy to one saved radio record. */
export function observationConfidence(record: RadioRecord, now = Date.now()): Confidence {
  const observationAgeDays = ageDays(record.lastSeen, now);
  const catalogueAgeDays = ageDays(record.lastUpdated, now);
  const qos = record.qos ?? null;
  const reasons: string[] = [];
  if (observationAgeDays === null) reasons.push("LAST_SEEN_UNKNOWN");
  if (qos === null) reasons.push("QOS_UNKNOWN");
  let tier: ConfidenceTier;
  if (observationAgeDays === null || qos === null) tier = "UNKNOWN";
  else if (observationAgeDays <= CONFIDENCE_POLICY.strong.maxObservationAgeDays && qos >= CONFIDENCE_POLICY.strong.minQos) tier = "STRONG";
  else if (observationAgeDays <= CONFIDENCE_POLICY.fair.maxObservationAgeDays && qos >= CONFIDENCE_POLICY.fair.minQos) tier = "FAIR";
  else tier = "WEAK";
  if (tier === "WEAK") {
    if (observationAgeDays !== null && observationAgeDays > CONFIDENCE_POLICY.fair.maxObservationAgeDays) reasons.push("LAST_SEEN_OLDER_THAN_3_YEARS");
    if (qos !== null && qos < CONFIDENCE_POLICY.fair.minQos) reasons.push("LOW_SOURCE_QOS");
  }
  if (catalogueAgeDays !== null && observationAgeDays !== null && catalogueAgeDays + 180 < observationAgeDays) {
    reasons.push("CATALOGUE_UPDATED_AFTER_LAST_SIGHTING");
  }
  return { tier, qos, observationAgeDays, catalogueAgeDays, reasons };
}

export type ConfidenceBreakdown = Record<ConfidenceTier, number>;

/** Counts saved records by their confidence tier at the supplied time. */
export function confidenceBreakdown(records: readonly RadioRecord[], now = Date.now()): ConfidenceBreakdown {
  const breakdown: ConfidenceBreakdown = { STRONG: 0, FAIR: 0, WEAK: 0, UNKNOWN: 0 };
  for (const record of records) breakdown[observationConfidence(record, now).tier]++;
  return breakdown;
}

/** BLE rows are historical sightings of rotating identities, never a current discovery result. */
export function isRotatingBleIdentity(record: Observation): boolean {
  if (record.kind !== "BLUETOOTH") return false;
  if (record.ble === true) return true;
  return (record.radio ?? "").toUpperCase() === "BLE";
}
