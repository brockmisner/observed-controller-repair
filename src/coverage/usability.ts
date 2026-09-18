import { modeledPower } from "../radio/engine.js";
import type { Position, RadioRecord } from "../radio/schema.js";

/** The radio engine parses at most this many observations for one dataset (H02). */
export const ENGINE_OBSERVATION_LIMIT = 10_000;

/** Reported floors mirror the engine's emission thresholds so counts describe usable coverage, not row totals. */
export const AUDIBLE_FLOOR_DBM = { WIFI: -90, BLUETOOTH: -95, LTE: -140, NR: -156 } as const;

export const DEFAULT_RADII_M = { wifiM: 120, cellM: 3000, bluetoothM: 60 } as const;

const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export type MissingField =
  | "BSSID_FORMAT"
  | "SSID"
  | "FREQUENCY_MHZ"
  | "ADDRESS_FORMAT"
  | "CELL_IDENTITY"
  | "PROPAGATION";

export type Usability = {
  usable: boolean;
  missing: MissingField[];
  /** Present in the source but not enough on its own; recorded so operators can see what a reimport could use. */
  unknown: string[];
};

function wifiUsability(record: RadioRecord): Usability {
  const missing: MissingField[] = [];
  if (!MAC.test(record.identifier)) missing.push("BSSID_FORMAT");
  if (!record.ssid) missing.push("SSID");
  if (!record.frequencyMHz) missing.push("FREQUENCY_MHZ");
  const unknown: string[] = [];
  if (!record.frequencyMHz && record.channel != null) unknown.push("CHANNEL_PRESENT_FREQUENCY_MISSING");
  if (!record.propagation) unknown.push("PROPAGATION_DEFAULTED");
  return { usable: !missing.length, missing, unknown };
}

function bluetoothUsability(record: RadioRecord): Usability {
  const missing: MissingField[] = MAC.test(record.identifier) ? [] : ["ADDRESS_FORMAT"];
  const unknown: string[] = [];
  if (!record.frequencyMHz) unknown.push("FREQUENCY_DEFAULTED_2402_MHZ");
  if (!record.bluetooth?.name && !record.ssid) unknown.push("NAME_UNKNOWN");
  return { usable: !missing.length, missing, unknown };
}

function cellUsability(record: RadioRecord): Usability {
  const missing: MissingField[] = [];
  if (!record.cell) missing.push("CELL_IDENTITY");
  if (!record.frequencyMHz) missing.push("FREQUENCY_MHZ");
  if (!record.propagation) missing.push("PROPAGATION");
  const unknown: string[] = [];
  if (record.propagation && (record.propagation.azimuthDeg == null || record.propagation.beamwidthDeg == null)) {
    unknown.push("SECTOR_UNKNOWN");
  }
  return { usable: !missing.length, missing, unknown };
}

/** Mirrors the engine's per-kind field requirements. A record it would skip is never counted as coverage. */
export function usability(record: RadioRecord): Usability {
  if (record.kind === "WIFI") return wifiUsability(record);
  if (record.kind === "BLUETOOTH") return bluetoothUsability(record);
  return cellUsability(record);
}

/**
 * Median modeled power at a sample position, with the engine's per-device fading set to zero.
 * Real frames vary by up to ±6 dB around this value, so a record just above the floor is reported
 * as marginal rather than as reliable coverage.
 */
export function medianPowerDbm(record: RadioRecord, position: Position, distanceM: number): number | null {
  const frequencyMHz = record.frequencyMHz ?? (record.kind === "BLUETOOTH" ? 2402 : null);
  if (frequencyMHz === null) return null;
  return modeledPower(record, position, distanceM, frequencyMHz, 0);
}

export function audibleFloorDbm(record: RadioRecord): number {
  if (record.kind === "WIFI") return AUDIBLE_FLOOR_DBM.WIFI;
  if (record.kind === "BLUETOOTH") return AUDIBLE_FLOOR_DBM.BLUETOOTH;
  return record.cell?.rat === "NR" ? AUDIBLE_FLOOR_DBM.NR : AUDIBLE_FLOOR_DBM.LTE;
}
