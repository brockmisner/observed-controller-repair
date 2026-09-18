import { HttpError } from "../http/errors.js";
import type { RadioRecord } from "../radio/schema.js";
import { usability } from "./usability.js";

/** Prisma schema defaults for a freshly created device row. */
export const DEVICE_CARRIER_DEFAULTS = { mcc: "310", mnc: "260", operator: "T-Mobile USA", lac: 12001, cid: 44821 } as const;

export type CarrierDeviceRow = {
  id: string;
  imageId: string;
  mcc: string;
  mnc: string;
  operator: string;
  carrierLocked: boolean;
  cellLocked: boolean;
  cellRadio: string;
  lac: number;
  cid: number;
  wigleCellQueriedAt: Date | string | null;
  proxyIsp: string | null;
  proxyKind: string | null;
  proxyAsn: string | null;
  imsi: string | null;
  iccid: string | null;
};

export type ObservedRadioReadback = {
  checkedAt: string;
  cell: string;
  wifi: string;
  bluetooth: string;
} | null;

export type CarrierIdentity = {
  deviceId: string;
  imageId: string;
  mcc: string;
  mnc: string;
  operator: string;
  /** Where the controller reads the identity from. It is configuration in every current path. */
  identitySource: "DEVICE_CONFIGURATION";
  /** What that configuration can be traced to. Ambiguity between code paths is reported, not guessed away. */
  identityBasis: "MATCHES_SCHEMA_DEFAULT" | "PROXY_ISP_DERIVED_OR_GEO_FALLBACK" | "EXPLICIT_NON_DEFAULT";
  basisCandidates: string[];
  observedConfirmation: "NOT_OBSERVED" | "OBSERVED_ANDROID_READBACK";
  confirmationDetail: string;
  /** Device-profile cell lock. The radio engine's serving cell comes from dataset records, not from these values. */
  profileCellLock: {
    radio: string;
    lac: number;
    cid: number;
    locked: boolean;
    provenance: "WIGLE_CELL_QUERY" | "MATCHES_SCHEMA_DEFAULT" | "UNVERIFIED_LOCAL_SEED";
    queriedAt: string | null;
  };
  simIdentifiers: {
    imsiPresent: boolean;
    imsiMatchesConfiguredPlmn: boolean | null;
    provenance: "LOCALLY_GENERATED_OR_OPERATOR_SUPPLIED";
  };
  warnings: string[];
};

export type EligibleCellSummary = {
  mcc: string;
  mnc: string;
  cellRecords: number;
  matchingPlmn: number;
  usableForModel: number;
  byRat: Record<string, number>;
  /** Reasons matching cells still cannot serve, counted per missing field. */
  blockedBy: Record<string, number>;
  otherPlmns: Array<{ plmn: string; records: number }>;
};

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * Associates a phone with the carrier the model will filter on, and states exactly how strong that
 * association is. Configuration and provider-proxy inference are never reported as observation.
 */
export function carrierIdentity(device: CarrierDeviceRow, readback: ObservedRadioReadback = null): CarrierIdentity {
  const isDefaultPlmn = device.mcc === DEVICE_CARRIER_DEFAULTS.mcc && device.mnc === DEVICE_CARRIER_DEFAULTS.mnc;
  const hasProxyEvidence = Boolean(device.proxyIsp);
  const identityBasis = hasProxyEvidence
    ? "PROXY_ISP_DERIVED_OR_GEO_FALLBACK"
    : isDefaultPlmn ? "MATCHES_SCHEMA_DEFAULT" : "EXPLICIT_NON_DEFAULT";
  const basisCandidates: string[] = [];
  if (hasProxyEvidence) {
    basisCandidates.push("Proxy ISP lookup mapped to a US carrier profile during fleet import");
    if (device.proxyKind === "unknown" || !device.proxyKind) {
      basisCandidates.push("Unknown proxy kind falls back to a coordinate-based carrier guess");
    }
  }
  if (isDefaultPlmn) {
    basisCandidates.push("Equal to the device-table default 310/260, which an unset phone also has");
    basisCandidates.push("Unrecognized carrier names also resolve to this profile");
  }
  if (!hasProxyEvidence && !isDefaultPlmn) basisCandidates.push("Set explicitly at registration or by a later operator change");

  const observedConfirmation = readback?.cell === "OBSERVED" ? "OBSERVED_ANDROID_READBACK" : "NOT_OBSERVED";
  const confirmationDetail = readback
    ? `Saved phone verification at ${readback.checkedAt} reports cell readback as ${readback.cell}.`
    : "No saved phone verification record was found for this phone.";

  const queriedAt = iso(device.wigleCellQueriedAt);
  const matchesDefaultCell = device.lac === DEVICE_CARRIER_DEFAULTS.lac && device.cid === DEVICE_CARRIER_DEFAULTS.cid;
  const warnings: string[] = [];
  const identity: CarrierIdentity = {
    deviceId: device.id,
    imageId: device.imageId,
    mcc: device.mcc,
    mnc: device.mnc,
    operator: device.operator,
    identitySource: "DEVICE_CONFIGURATION",
    identityBasis,
    basisCandidates,
    observedConfirmation,
    confirmationDetail,
    profileCellLock: {
      radio: device.cellRadio,
      lac: device.lac,
      cid: device.cid,
      locked: device.cellLocked,
      provenance: queriedAt ? "WIGLE_CELL_QUERY" : matchesDefaultCell ? "MATCHES_SCHEMA_DEFAULT" : "UNVERIFIED_LOCAL_SEED",
      queriedAt,
    },
    simIdentifiers: {
      imsiPresent: Boolean(device.imsi),
      imsiMatchesConfiguredPlmn: device.imsi ? device.imsi.startsWith(`${device.mcc}${device.mnc}`) : null,
      provenance: "LOCALLY_GENERATED_OR_OPERATOR_SUPPLIED",
    },
    warnings,
  };
  warnings.push("Configured MCC/MNC is not an observed confirmation of the phone's active carrier.");
  if (identity.profileCellLock.provenance === "UNVERIFIED_LOCAL_SEED") {
    warnings.push("Profile LAC/CID has no recorded query time; registration seeds these values locally when no cell query succeeds.");
  }
  if (identity.profileCellLock.provenance === "MATCHES_SCHEMA_DEFAULT") {
    warnings.push("Profile LAC/CID equals the device-table default, so it identifies no observed station.");
  }
  if (identity.simIdentifiers.imsiPresent) {
    warnings.push("IMSI/ICCID are generated from the image identifier unless an operator supplied real values.");
  }
  return identity;
}

/** Counts the cells a dataset can actually offer this carrier, per the engine's own filters. */
export function eligibleCells(records: readonly RadioRecord[], identity: Pick<CarrierIdentity, "mcc" | "mnc">): EligibleCellSummary {
  const cells = records.filter((record) => record.kind === "CELL");
  const byRat: Record<string, number> = {};
  const blockedBy: Record<string, number> = {};
  const otherPlmns = new Map<string, number>();
  let matchingPlmn = 0;
  let usableForModel = 0;
  for (const record of cells) {
    if (!record.cell) {
      blockedBy.CELL_IDENTITY = (blockedBy.CELL_IDENTITY ?? 0) + 1;
      continue;
    }
    const plmn = `${record.cell.mcc}-${record.cell.mnc}`;
    if (record.cell.mcc !== identity.mcc || record.cell.mnc !== identity.mnc) {
      otherPlmns.set(plmn, (otherPlmns.get(plmn) ?? 0) + 1);
      continue;
    }
    matchingPlmn++;
    byRat[record.cell.rat] = (byRat[record.cell.rat] ?? 0) + 1;
    const result = usability(record);
    if (result.usable) usableForModel++;
    for (const field of result.missing) blockedBy[field] = (blockedBy[field] ?? 0) + 1;
  }
  return {
    mcc: identity.mcc,
    mnc: identity.mnc,
    cellRecords: cells.length,
    matchingPlmn,
    usableForModel,
    byRat,
    blockedBy,
    otherPlmns: [...otherPlmns.entries()].map(([plmn, records]) => ({ plmn, records })).sort((a, b) => b.records - a.records),
  };
}

/**
 * Refuses a run whose dataset cannot produce a serving cell for the configured carrier.
 * The alternative — continuing with an empty cell list — is what would let a fabricated
 * or unintended serving cell appear later, so this fails instead of degrading quietly.
 */
export function assertEligibleCarrierCoverage(summary: EligibleCellSummary, datasetLabel: string): void {
  if (summary.usableForModel > 0) return;
  const detail = summary.matchingPlmn === 0
    ? `no saved cell observation carries MCC ${summary.mcc} / MNC ${summary.mnc}`
    : `${summary.matchingPlmn} matching cell(s) are missing required fields (${Object.entries(summary.blockedBy)
      .map(([field, count]) => `${field}: ${count}`).join(", ")})`;
  throw new HttpError(409, `${datasetLabel} has no eligible serving cell for this phone: ${detail}. `
    + "Import cell identity, frequency and propagation for this carrier, or run without a cellular claim. No serving cell is generated.");
}
