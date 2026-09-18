import { MEASUREMENT_MODES, type ApplyRequest, type Readback } from './contract.js';

/**
 * Frozen freshness, latency and comparison policy for the radio integration
 * (checklist B06, E04, E05). These are the supported release values, not physical guarantees.
 */

/**
 * E04. Modeled cache cadence, kept explicitly separate from what Android will actually let a
 * plugin request. `WifiManager.startScan()` is throttled to four calls per two minutes for a
 * foreground app from Android 9 onward, so a sustained sub-30-second Wi-Fi refresh is only
 * available on an image where scan throttling is disabled and the plugin declares it.
 */
export const SCAN_CADENCE = {
  wifi: {
    defaultIntervalMs: 30000, minIntervalMs: 10000, maxIntervalMs: 300000,
    androidThrottle: '4 scans per 120000 ms per foreground app (Android 9+)',
    belowDefaultRequires: 'capabilities.interfaces.wifi.scanThrottleDisabled === true',
  },
  cells: {
    defaultIntervalMs: 1000, minIntervalMs: 1000, maxIntervalMs: 30000,
    androidThrottle: 'none documented for CellInfo reads; TelephonyManager may return cached CellInfo',
    belowDefaultRequires: null,
  },
  bluetooth: {
    defaultIntervalMs: 30000, minIntervalMs: 15000, maxIntervalMs: 300000,
    androidThrottle: 'classic discovery takes roughly 12 s per cycle',
    belowDefaultRequires: null,
  },
} as const;
export type ScanInterface = keyof typeof SCAN_CADENCE;

/** A sample older than this multiple of its own cadence is overdue, not merely cached. */
export const OVERDUE_INTERVAL_MULTIPLE = 2;

export type Freshness = 'FRESH' | 'CACHED' | 'OVERDUE';

/** E04. Age is measured in the SIM domain against the frame that carries the sample. */
export function sampleAgeMs(frameSimElapsedMs: number, sampledSimElapsedMs: number): number {
  if (![frameSimElapsedMs, sampledSimElapsedMs].every(v => Number.isSafeInteger(v) && v >= 0)) throw new Error('Invalid simulation clock');
  if (sampledSimElapsedMs > frameSimElapsedMs) throw new Error('Sample is newer than its frame');
  return frameSimElapsedMs - sampledSimElapsedMs;
}

export function freshness(ageMs: number, intervalMs: number): Freshness {
  if (ageMs < 0 || intervalMs <= 0) throw new Error('Invalid freshness inputs');
  if (ageMs === 0) return 'FRESH';
  return ageMs >= intervalMs * OVERDUE_INTERVAL_MULTIPLE ? 'OVERDUE' : 'CACHED';
}

export interface AgeReport { interface: ScanInterface; ageMs: number | null; intervalMs: number | null; freshness: Freshness | null; held: boolean }

/**
 * E04. Per-interface age for display and evidence. A cached scan is reported with its own age;
 * it is never presented as a one-second measurement.
 */
export function describeAges(request: ApplyRequest): AgeReport[] {
  return (['wifi', 'cells', 'bluetooth'] as const).map(name => {
    const block = request[name];
    if (block.directive !== 'REPLACE') return { interface: name, ageMs: null, intervalMs: null, freshness: null, held: true };
    const ageMs = sampleAgeMs(request.simElapsedMs, block.sampledSimElapsedMs);
    return { interface: name, ageMs, intervalMs: block.cacheIntervalMs, freshness: freshness(ageMs, block.cacheIntervalMs), held: false };
  });
}

export function overdueWarnings(request: ApplyRequest): string[] {
  return describeAges(request).filter(a => a.freshness === 'OVERDUE').map(a => `SCAN_CACHE_OVERDUE:${a.interface.toUpperCase()}`);
}

// ---------------------------------------------------------------------------
// B06 — latency budget
// ---------------------------------------------------------------------------

/**
 * B06. Budget for the recommended arrangement: radio frames are scheduled locally on the phone
 * from prepared data on the same one-second tick as GPS, and only reactive frames (arrival
 * Bluetooth, cleanup) are delivered under a bounded delay.
 *
 * These are the values the release advertises and G02 must measure. Controller supervision is
 * roughly 1500 ms and browser polling roughly 2500 ms, so an operator's view is seconds behind
 * the phone by construction. One-second local playback is not a one-second operator feed.
 */
export const LATENCY_BUDGET_MS = {
  gpsSampleIntervalMs: 1000,
  gpsApplyLatenessP50: 150,
  gpsApplyLatenessP95: 400,
  gpsApplyLatenessMax: 1000,
  /** Scheduled path: radio frame and its paired GPS sample share the tick. */
  scheduledRadioToGpsSkewMax: 250,
  /** Delivered path, used for arrival and cleanup frames. */
  deliveredEmitToReceipt: 1500,
  deliveredReceiptToApplied: 500,
  deliveredAppliedToResult: 1500,
  deliveredTotal: 3500,
  /** Default `validForMs`; matches the engine's continuity gap and the arrival gate's staleness limit. */
  frameValidForDefault: 5000,
  readbackMeasurementToReport: 5000,
  arrivalApplyToVerify: 60000,
  uiSnapshotPollInterval: 2500,
  /** Worst case age of what an operator sees on the delivered path. */
  operatorVisibleWorstCase: 6000,
} as const;

// ---------------------------------------------------------------------------
// E05 — warning classification
// ---------------------------------------------------------------------------

export interface WarningPolicy {
  readonly name: string;
  readonly blocking: readonly string[];
  readonly advisory: readonly string[];
  readonly toleranceDb: number;
  /** EXCLUSIVE claims the plugin replaces the whole scan result; ADDITIVE injects alongside real networks. */
  readonly requiredMeasurementMode: (typeof MEASUREMENT_MODES)[number] | null;
}

const ALL_WARNINGS = [
  'WIFI_METADATA_MISSING', 'BLUETOOTH_METADATA_MISSING', 'CELL_METADATA_MISSING', 'NO_ELIGIBLE_CELL',
  'SECTOR_UNKNOWN', 'COVERAGE_SPARSE', 'SCAN_CACHE_OVERDUE', 'CLOCK_UNANCHORED',
] as const;

/**
 * Ships as the default and preserves the current `ArrivalGate` behavior: every recognized warning
 * blocks arrival application. Nothing is relaxed without an explicit policy change.
 */
export const CONSERVATIVE_ARRIVAL_POLICY: WarningPolicy = {
  name: 'CONSERVATIVE', blocking: ALL_WARNINGS, advisory: [], toleranceDb: 3, requiredMeasurementMode: null,
};

/**
 * Recommended for the release and pending sign-off. Unknown antenna orientation and sparse
 * coverage are recorded modeling limits rather than comparison failures; they cannot change an
 * identity or push a power reading outside tolerance on their own.
 */
export const RECOMMENDED_ARRIVAL_POLICY: WarningPolicy = {
  name: 'RECOMMENDED',
  blocking: ALL_WARNINGS.filter(w => w !== 'SECTOR_UNKNOWN' && w !== 'COVERAGE_SPARSE'),
  advisory: ['SECTOR_UNKNOWN', 'COVERAGE_SPARSE'],
  toleranceDb: 3,
  requiredMeasurementMode: null,
};

export interface ClassifiedWarnings { blocking: string[]; advisory: string[]; unrecognized: string[] }

/** Unrecognized warning codes block. A future model warning cannot pass by being unknown. */
export function classifyWarnings(warnings: readonly string[], policy: WarningPolicy = CONSERVATIVE_ARRIVAL_POLICY): ClassifiedWarnings {
  const result: ClassifiedWarnings = { blocking: [], advisory: [], unrecognized: [] };
  for (const warning of warnings) {
    const code = warning.split(':', 1)[0]!;
    if (policy.advisory.includes(code)) result.advisory.push(warning);
    else if (policy.blocking.includes(code)) result.blocking.push(warning);
    else { result.unrecognized.push(warning); result.blocking.push(warning); }
  }
  return result;
}

// ---------------------------------------------------------------------------
// E05 — readback comparison
// ---------------------------------------------------------------------------

export const VERDICT_STATUSES = ['MATCH', 'MISMATCH', 'UNAVAILABLE', 'OUT_OF_SCOPE', 'INCONCLUSIVE', 'NOT_REQUESTED'] as const;
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

export interface FieldDifference { identity: string; field: string; expected: number | string; observed: number | string }

export interface InterfaceVerdict {
  interface: ScanInterface;
  status: VerdictStatus;
  reason: string | null;
  /** Expected identities absent from every observation taken after application. */
  missing: string[];
  /** Expected identities seen only in samples measured before application; unverified, not contradicted. */
  staleOnly: string[];
  mismatched: FieldDifference[];
  /** Observed identities the controller did not inject. Only a failure when the plugin claims EXCLUSIVE. */
  extra: string[];
  toleranceDb: number;
  measurementMode: (typeof MEASUREMENT_MODES)[number] | null;
}

export interface ComparisonResult {
  verdicts: InterfaceVerdict[];
  overall: 'VERIFIED' | 'MISMATCH' | 'INCONCLUSIVE' | 'BLOCKED';
  /** True when an interface was outside the declared plugin scope, so the claim is narrower. */
  scopeLimited: boolean;
  warnings: ClassifiedWarnings;
}

type Observation = { identity: string; measuredAtBootMs: number; fields: Record<string, number | string> };
type Expectation = { identity: string; fields: Record<string, number | string> };

function compareInterface(
  name: ScanInterface, request: ApplyRequest, report: Readback, policy: WarningPolicy,
  expectations: Expectation[], observations: Observation[] | null,
  availability: 'MEASURED' | 'UNAVAILABLE' | 'OUT_OF_SCOPE', reason: string | null,
  measurementMode: (typeof MEASUREMENT_MODES)[number] | null,
): InterfaceVerdict {
  const base = {
    interface: name, missing: [] as string[], staleOnly: [] as string[], mismatched: [] as FieldDifference[],
    extra: [] as string[], toleranceDb: policy.toleranceDb, measurementMode,
  };
  const directive = request[name].directive;
  if (directive === 'HOLD') return { ...base, status: 'NOT_REQUESTED', reason: 'HELD_NOT_VERIFIED' };
  if (directive === 'CLEAR') return { ...base, status: 'NOT_REQUESTED', reason: 'CLEAR_NOT_VERIFIED_BY_IDENTITY' };
  if (availability === 'OUT_OF_SCOPE') return { ...base, status: 'OUT_OF_SCOPE', reason };
  if (availability === 'UNAVAILABLE' || observations === null) return { ...base, status: 'UNAVAILABLE', reason };

  const applied = report.appliedAtBootMs;
  const post = new Map(observations.filter(o => o.measuredAtBootMs >= applied).map(o => [o.identity, o]));
  const pre = new Map(observations.filter(o => o.measuredAtBootMs < applied).map(o => [o.identity, o]));

  for (const expectation of expectations) {
    const observed = post.get(expectation.identity);
    if (!observed) {
      (pre.has(expectation.identity) ? base.staleOnly : base.missing).push(expectation.identity);
      continue;
    }
    for (const [field, want] of Object.entries(expectation.fields)) {
      const got = observed.fields[field];
      const within = typeof want === 'number' && typeof got === 'number'
        ? Math.abs(want - got) <= (field.endsWith('Dbm') ? policy.toleranceDb : 0)
        : want === got;
      if (!within) base.mismatched.push({ identity: expectation.identity, field, expected: want, observed: got ?? 'absent' });
    }
  }
  const expected = new Set(expectations.map(e => e.identity));
  base.extra = [...post.keys()].filter(identity => !expected.has(identity));
  const exclusive = measurementMode === 'EXCLUSIVE';

  if (!expectations.length) {
    if (!exclusive) return { ...base, status: 'INCONCLUSIVE', reason: 'ADDITIVE_ABSENCE_UNVERIFIABLE' };
    return base.extra.length ? { ...base, status: 'MISMATCH', reason: 'UNEXPECTED_OBSERVATION' } : { ...base, status: 'MATCH', reason: null };
  }
  if (base.missing.length || base.mismatched.length) return { ...base, status: 'MISMATCH', reason: base.missing.length ? 'EXPECTED_IDENTITY_ABSENT' : 'MEASUREMENT_OUTSIDE_TOLERANCE' };
  if (exclusive && base.extra.length) return { ...base, status: 'MISMATCH', reason: 'UNEXPECTED_OBSERVATION' };
  if (base.staleOnly.length === expectations.length) return { ...base, status: 'INCONCLUSIVE', reason: 'PRE_APPLICATION_ONLY' };
  if (base.staleOnly.length) return { ...base, status: 'INCONCLUSIVE', reason: 'PARTIALLY_PRE_APPLICATION' };
  return { ...base, status: 'MATCH', reason: null };
}

/**
 * E05. Compares one application request against one independent readback. Mismatch, unavailable
 * data and unsupported scope stay distinct, and a subset of expected identities never becomes a
 * full-coverage claim.
 */
export function compareReadback(request: ApplyRequest, report: Readback, policy: WarningPolicy = CONSERVATIVE_ARRIVAL_POLICY): ComparisonResult {
  if (request.identity.imageId !== report.identity.imageId || request.identity.sessionId !== report.identity.sessionId ||
      request.identity.bootId !== report.identity.bootId || request.frameHash !== report.frameHash || request.sequence !== report.sequence) {
    throw new Error('Readback does not correlate with the requested frame');
  }
  const wifi = compareInterface('wifi', request, report, policy,
    request.wifi.directive === 'REPLACE' ? request.wifi.entries.map(e => ({ identity: e.bssid, fields: { ssid: e.ssid, frequencyMHz: e.frequencyMHz, rssiDbm: e.rssiDbm } })) : [],
    report.wifi.availability === 'MEASURED'
      ? report.wifi.entries.map(e => ({ identity: e.bssid.toLowerCase(), measuredAtBootMs: Math.floor(e.measuredAtBootUs / 1000), fields: { ssid: e.ssid, frequencyMHz: e.frequencyMHz, rssiDbm: e.rssiDbm } }))
      : null,
    report.wifi.availability, report.wifi.availability === 'MEASURED' ? null : report.wifi.reason,
    report.wifi.availability === 'MEASURED' ? report.wifi.measurementMode : null);

  const cells = compareInterface('cells', request, report, policy,
    request.cells.directive === 'REPLACE' ? request.cells.entries.map(e => ({ identity: e.identifier, fields: { registered: String(e.registered), rsrpDbm: e.rsrpDbm } })) : [],
    report.cells.availability === 'MEASURED'
      ? report.cells.entries.map(e => ({ identity: e.identifier, measuredAtBootMs: e.measuredAtBootMs, fields: { registered: String(e.registered), rsrpDbm: e.rsrpDbm } }))
      : null,
    report.cells.availability, report.cells.availability === 'MEASURED' ? null : report.cells.reason,
    report.cells.availability === 'MEASURED' ? report.cells.measurementMode : null);

  const bluetooth = compareInterface('bluetooth', request, report, policy,
    request.bluetooth.directive === 'REPLACE' ? request.bluetooth.entries.map(e => ({ identity: e.address, fields: { rssiDbm: e.rssiDbm } })) : [],
    report.bluetooth.availability === 'MEASURED'
      ? report.bluetooth.entries.map(e => ({ identity: e.address.toLowerCase(), measuredAtBootMs: e.measuredAtBootMs, fields: { rssiDbm: e.rssiDbm } }))
      : null,
    report.bluetooth.availability, report.bluetooth.availability === 'MEASURED' ? null : report.bluetooth.reason,
    report.bluetooth.availability === 'MEASURED' ? report.bluetooth.measurementMode : null);

  const verdicts = [wifi, cells, bluetooth];
  const warnings = classifyWarnings([...request.warnings, ...overdueWarnings(request)], policy);
  const overall = warnings.blocking.length ? 'BLOCKED'
    : verdicts.some(v => v.status === 'MISMATCH') ? 'MISMATCH'
    : verdicts.some(v => v.status === 'INCONCLUSIVE' || v.status === 'UNAVAILABLE') ? 'INCONCLUSIVE'
    : verdicts.some(v => v.status === 'MATCH') ? 'VERIFIED' : 'INCONCLUSIVE';
  return { verdicts, overall, scopeLimited: verdicts.some(v => v.status === 'OUT_OF_SCOPE'), warnings };
}
