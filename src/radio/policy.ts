import { AVAILABILITY, MEASUREMENT_MODES, type ApplyRequest, type Readback } from './contract.js';

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
    androidThrottle: '4 scans per 120000 ms foreground, 1 per 30 minutes background (Android 9+); a scan itself takes 2-4 s',
    imagePrerequisite: 'settings put global wifi_scan_throttle_enabled 0',
    belowDefaultRequires: 'capabilities.imagePrerequisites.wifiScanThrottleDisabled === true',
  },
  cells: {
    defaultIntervalMs: 1000, minIntervalMs: 1000, maxIntervalMs: 30000,
    androidThrottle: 'platform refreshes getAllCellInfo at most ~1 Hz and returns cached or null data to background apps',
    imagePrerequisite: 'a modem must be present; a cloud phone may return an empty cell list',
    belowDefaultRequires: null,
  },
  bluetooth: {
    defaultIntervalMs: 30000, minIntervalMs: 15000, maxIntervalMs: 300000,
    androidThrottle: 'classic discovery takes roughly 12 s per cycle',
    imagePrerequisite: 'a Bluetooth adapter must be present',
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
  'IMAGE_PREREQUISITE_MISSING', 'DATASET_WINDOW_INCOMPLETE',
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

/**
 * E05. Availability, scope and mismatch are separate answers.
 *
 * - `MATCH` / `MISMATCH`       decided by comparison, and only for an in-scope observer.
 * - `NOT_YET_MEASURED`         no measurement exists yet; expected while Wi-Fi scanning is throttled.
 * - `UNAVAILABLE`              the interface could not be read on this image.
 * - `UNSUPPORTED_IN_SCOPE`     this build does not hook the interface inside the injected packages.
 * - `INCONCLUSIVE`             measured, but the measurement cannot settle the question.
 * - `NOT_REQUESTED`            the frame held or cleared this interface.
 * - `OUT_OF_SCOPE_CONFIRMED`   an out-of-scope observer correctly did not see the injected values.
 * - `SCOPE_LEAK`               an out-of-scope observer did see them, so the declared scope is wrong.
 */
export const VERDICT_STATUSES = [
  'MATCH', 'MISMATCH', 'NOT_YET_MEASURED', 'UNAVAILABLE', 'UNSUPPORTED_IN_SCOPE', 'INCONCLUSIVE',
  'NOT_REQUESTED', 'OUT_OF_SCOPE_CONFIRMED', 'SCOPE_LEAK',
] as const;
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

/**
 * What a readback can establish. An injected value read back through the module's own hook proves
 * the hook ran with the right identity and scope; it is not a measurement of radio hardware.
 */
export const EVIDENCE_CLAIM = {
  IN_SCOPE_VERIFICATION: 'The listed packages observe the modeled environment. This establishes injection fidelity, scope and identity binding, not physical RF behavior.',
  OUT_OF_SCOPE_CONTROL: 'A package outside the injected scope observes the host\'s real radios, which confirms the scope boundary.',
  SCOPE_UNKNOWN: 'Observer scope membership was not resolved, so this report supports no coverage claim.',
} as const;
export type ComparisonRole = keyof typeof EVIDENCE_CLAIM;

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
  /** Decided by the observer's scope membership, because that fixes what the report can mean. */
  role: ComparisonRole;
  claim: string;
  verdicts: InterfaceVerdict[];
  overall: 'VERIFIED' | 'MISMATCH' | 'INCONCLUSIVE' | 'BLOCKED' | 'OUT_OF_SCOPE_CONFIRMED' | 'SCOPE_LEAK';
  /** True when an interface was unsupported in scope or unavailable, so the claim is narrower. */
  scopeLimited: boolean;
  warnings: ClassifiedWarnings;
}

type Observation = { identity: string; measuredAtBootMs: number; fields: Record<string, number | string> };
type Expectation = { identity: string; fields: Record<string, number | string> };

interface InterfaceInput {
  name: ScanInterface;
  expectations: Expectation[];
  observations: Observation[] | null;
  availability: (typeof AVAILABILITY)[number];
  reason: string | null;
  measurementMode: (typeof MEASUREMENT_MODES)[number] | null;
}

function compareInterface(
  input: InterfaceInput, request: ApplyRequest, report: Readback, policy: WarningPolicy, role: ComparisonRole,
): InterfaceVerdict {
  const { name, expectations, observations, availability, reason, measurementMode } = input;
  const base = {
    interface: name, missing: [] as string[], staleOnly: [] as string[], mismatched: [] as FieldDifference[],
    extra: [] as string[], toleranceDb: policy.toleranceDb, measurementMode,
  };
  const directive = request[name].directive;
  if (directive === 'HOLD') return { ...base, status: 'NOT_REQUESTED', reason: 'HELD_NOT_VERIFIED' };
  if (directive === 'CLEAR') return { ...base, status: 'NOT_REQUESTED', reason: 'CLEAR_NOT_VERIFIED_BY_IDENTITY' };
  if (availability === 'UNSUPPORTED_IN_SCOPE') return { ...base, status: 'UNSUPPORTED_IN_SCOPE', reason };
  if (availability === 'UNAVAILABLE') return { ...base, status: 'UNAVAILABLE', reason };
  if (availability === 'NOT_YET_MEASURED' || observations === null) return { ...base, status: 'NOT_YET_MEASURED', reason };

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
  const matchedAny = expectations.length > 0 && base.missing.length === 0 && base.staleOnly.length === 0 && base.mismatched.length === 0;

  // An out-of-scope observer is a negative control. Not seeing the injected values is the correct
  // result and must never be reported as a mismatch; seeing them contradicts the declared scope.
  if (role === 'OUT_OF_SCOPE_CONTROL') {
    if (!expectations.length) return { ...base, status: 'INCONCLUSIVE', reason: 'NOTHING_INJECTED_TO_CONTROL_FOR' };
    return matchedAny
      ? { ...base, status: 'SCOPE_LEAK', reason: 'INJECTED_VALUES_VISIBLE_OUTSIDE_PATTERN' }
      : { ...base, status: 'OUT_OF_SCOPE_CONFIRMED', reason: 'HOST_RADIOS_OBSERVED_AS_EXPECTED' };
  }
  if (role === 'SCOPE_UNKNOWN') return { ...base, status: 'INCONCLUSIVE', reason: 'OBSERVER_SCOPE_UNKNOWN' };

  const exclusive = measurementMode === 'EXCLUSIVE';
  if (!expectations.length) {
    if (!exclusive) return { ...base, status: 'INCONCLUSIVE', reason: 'ADDITIVE_ABSENCE_UNVERIFIABLE' };
    return base.extra.length ? { ...base, status: 'MISMATCH', reason: 'UNEXPECTED_OBSERVATION' } : { ...base, status: 'MATCH', reason: null };
  }
  // E04. With Wi-Fi scan throttling on, a fresh post-application scan is not reliably obtainable,
  // so an all-stale Wi-Fi result is an image prerequisite problem rather than a phone mismatch.
  const throttled = name === 'wifi' && !report.wifiScanThrottleDisabled;
  if (base.staleOnly.length === expectations.length && !base.mismatched.length) {
    return { ...base, status: 'INCONCLUSIVE', reason: throttled ? 'SCAN_THROTTLED_PRE_APPLICATION_ONLY' : 'PRE_APPLICATION_ONLY' };
  }
  if (base.missing.length || base.mismatched.length) return { ...base, status: 'MISMATCH', reason: base.missing.length ? 'EXPECTED_IDENTITY_ABSENT' : 'MEASUREMENT_OUTSIDE_TOLERANCE' };
  if (exclusive && base.extra.length) return { ...base, status: 'MISMATCH', reason: 'UNEXPECTED_OBSERVATION' };
  if (base.staleOnly.length) return { ...base, status: 'INCONCLUSIVE', reason: throttled ? 'SCAN_THROTTLED_PARTIALLY_PRE_APPLICATION' : 'PARTIALLY_PRE_APPLICATION' };
  return { ...base, status: 'MATCH', reason: null };
}

/**
 * E05. Compares one application request against one independent readback. Mismatch, unavailable
 * data and unsupported scope stay distinct, and a subset of expected identities never becomes a
 * full-coverage claim.
 */
export function compareReadback(request: ApplyRequest, report: Readback, policy: WarningPolicy = CONSERVATIVE_ARRIVAL_POLICY): ComparisonResult {
  const identity = request.identity;
  const observed = report.identity;
  if (identity.imageId !== observed.imageId || identity.sessionId !== observed.sessionId ||
      identity.bootId !== observed.bootId || identity.instanceId !== observed.instanceId ||
      identity.datasetRevision !== observed.datasetRevision ||
      request.frameHash !== report.frameHash || request.sequence !== report.sequence) {
    throw new Error('Readback does not correlate with the requested frame');
  }
  if (request.scopeFingerprint !== report.scopeFingerprint) {
    throw new Error('Readback resolved scope membership against a different injected scope');
  }
  const role: ComparisonRole = report.scopeMembership === 'IN_SCOPE' ? 'IN_SCOPE_VERIFICATION'
    : report.scopeMembership === 'OUT_OF_SCOPE' ? 'OUT_OF_SCOPE_CONTROL' : 'SCOPE_UNKNOWN';

  const inputs: InterfaceInput[] = [
    {
      name: 'wifi',
      expectations: request.wifi.directive === 'REPLACE'
        ? request.wifi.entries.map(e => ({ identity: e.bssid, fields: { ssid: e.ssid, frequencyMHz: e.frequencyMHz, rssiDbm: e.rssiDbm } })) : [],
      observations: report.wifi.availability === 'MEASURED'
        ? report.wifi.entries.map(e => ({ identity: e.bssid.toLowerCase(), measuredAtBootMs: Math.floor(e.measuredAtBootUs / 1000), fields: { ssid: e.ssid, frequencyMHz: e.frequencyMHz, rssiDbm: e.rssiDbm } })) : null,
      availability: report.wifi.availability,
      reason: report.wifi.availability === 'MEASURED' ? null : report.wifi.reason,
      measurementMode: report.wifi.availability === 'MEASURED' ? report.wifi.measurementMode : null,
    },
    {
      name: 'cells',
      expectations: request.cells.directive === 'REPLACE'
        ? request.cells.entries.map(e => ({ identity: e.identifier, fields: { registered: String(e.registered), rsrpDbm: e.rsrpDbm } })) : [],
      observations: report.cells.availability === 'MEASURED'
        ? report.cells.entries.map(e => ({ identity: e.identifier, measuredAtBootMs: e.measuredAtBootMs, fields: { registered: String(e.registered), rsrpDbm: e.rsrpDbm } })) : null,
      availability: report.cells.availability,
      reason: report.cells.availability === 'MEASURED' ? null : report.cells.reason,
      measurementMode: report.cells.availability === 'MEASURED' ? report.cells.measurementMode : null,
    },
    {
      name: 'bluetooth',
      expectations: request.bluetooth.directive === 'REPLACE'
        ? request.bluetooth.entries.map(e => ({ identity: e.address, fields: { rssiDbm: e.rssiDbm } })) : [],
      observations: report.bluetooth.availability === 'MEASURED'
        ? report.bluetooth.entries.map(e => ({ identity: e.address.toLowerCase(), measuredAtBootMs: e.measuredAtBootMs, fields: { rssiDbm: e.rssiDbm } })) : null,
      availability: report.bluetooth.availability,
      reason: report.bluetooth.availability === 'MEASURED' ? null : report.bluetooth.reason,
      measurementMode: report.bluetooth.availability === 'MEASURED' ? report.bluetooth.measurementMode : null,
    },
  ];
  const verdicts = inputs.map(input => compareInterface(input, request, report, policy, role));
  const extra = [...overdueWarnings(request)];
  if (!report.wifiScanThrottleDisabled && request.wifi.directive === 'REPLACE') extra.push('IMAGE_PREREQUISITE_MISSING:WIFI_SCAN_THROTTLE');
  const warnings = classifyWarnings([...request.warnings, ...extra], policy);
  const narrowed = verdicts.some(v => v.status === 'UNSUPPORTED_IN_SCOPE' || v.status === 'UNAVAILABLE');

  if (role === 'OUT_OF_SCOPE_CONTROL') {
    const overall = verdicts.some(v => v.status === 'SCOPE_LEAK') ? 'SCOPE_LEAK'
      : verdicts.some(v => v.status === 'OUT_OF_SCOPE_CONFIRMED') ? 'OUT_OF_SCOPE_CONFIRMED' : 'INCONCLUSIVE';
    return { role, claim: EVIDENCE_CLAIM[role], verdicts, overall, scopeLimited: narrowed, warnings };
  }
  if (role === 'SCOPE_UNKNOWN') {
    return { role, claim: EVIDENCE_CLAIM[role], verdicts, overall: 'INCONCLUSIVE', scopeLimited: true, warnings };
  }
  const overall = warnings.blocking.length ? 'BLOCKED'
    : verdicts.some(v => v.status === 'MISMATCH' || v.status === 'SCOPE_LEAK') ? 'MISMATCH'
    : verdicts.some(v => v.status === 'INCONCLUSIVE' || v.status === 'UNAVAILABLE' || v.status === 'NOT_YET_MEASURED') ? 'INCONCLUSIVE'
    : verdicts.some(v => v.status === 'MATCH') ? 'VERIFIED' : 'INCONCLUSIVE';
  return { role, claim: EVIDENCE_CLAIM[role], verdicts, overall, scopeLimited: narrowed, warnings };
}
