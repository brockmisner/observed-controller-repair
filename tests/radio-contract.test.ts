import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RadioEngine } from '../src/radio/engine.js';
import { radioRecordSchema } from '../src/radio/schema.js';
import { hashFrame } from '../src/radio/arrival.js';
import {
  RADIO_PROTOCOL, RADIO_PROTOCOL_VERSION, applyRequestFromFrame, applyRequestSchema, assertApplied,
  interpretResult, simToPhoneBootMs, timedOutVerdict, validateAs, validateMessage,
  type ApplyRequest, type ApplyResult, type MessageType, type Readback,
} from '../src/radio/contract.js';
import {
  CONSERVATIVE_ARRIVAL_POLICY, LATENCY_BUDGET_MS, RECOMMENDED_ARRIVAL_POLICY, SCAN_CADENCE,
  classifyWarnings, compareReadback, describeAges, freshness, overdueWarnings, sampleAgeMs,
} from '../src/radio/policy.js';

const contracts = resolve(dirname(fileURLToPath(import.meta.url)), '../contracts/radio/v1');
const load = <T>(file: string): T => JSON.parse(readFileSync(resolve(contracts, file), 'utf8')) as T;
interface ManifestCase { file: string; messageType: MessageType; expect: 'ACCEPT' | 'REJECT'; code: string | null; detail: string | null; why: string }
const manifest = load<{ protocol: string; protocolVersion: number; cases: ManifestCase[] }>('manifest.json');
const fixture = <T>(name: string): T => load<T>(`fixtures/${name}`);

test('the shared fixture manifest describes the frozen protocol version', () => {
  assert.equal(manifest.protocol, RADIO_PROTOCOL);
  assert.equal(manifest.protocolVersion, RADIO_PROTOCOL_VERSION);
  assert.ok(manifest.cases.length >= 40);
  assert.equal(new Set(manifest.cases.map(c => c.file)).size, manifest.cases.length);
  for (const shape of ['radio.apply', 'radio.result', 'radio.readback', 'radio.capabilities']) {
    assert.ok(manifest.cases.some(c => c.messageType === shape && c.expect === 'ACCEPT'), `${shape} needs an accepted example`);
    assert.ok(manifest.cases.some(c => c.messageType === shape && c.expect === 'REJECT'), `${shape} needs a rejected example`);
  }
});

test('controller validation agrees with every shared fixture outcome', () => {
  for (const entry of manifest.cases) {
    const result = validateMessage(load(entry.file));
    if (entry.expect === 'ACCEPT') {
      assert.equal(result.ok, true, `${entry.file} should be accepted: ${result.ok ? '' : `${result.code} ${result.message}`}`);
      continue;
    }
    assert.equal(result.ok, false, `${entry.file} should be rejected`);
    if (result.ok) continue;
    assert.equal(result.code, entry.code, `${entry.file} reject code`);
    if (entry.detail !== null) assert.equal(result.detail, entry.detail, `${entry.file} reject detail`);
  }
});

test('an incompatible protocol version is refused before any field is interpreted', () => {
  const valid = fixture<ApplyRequest>('apply-moving-valid.json');
  for (const change of [{ protocolVersion: 2 }, { protocolVersion: 0 }, { protocolVersion: '1' }, { protocol: 'duoplus.radio.v2' }]) {
    const result = validateMessage({ ...valid, ...change, sequence: -1, cells: null });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'PROTOCOL_VERSION_UNSUPPORTED');
  }
});

test('validateAs refuses a well-formed message of the wrong type', () => {
  const result = validateAs('radio.apply', fixture('result-applied-valid.json'));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'MESSAGE_TYPE_UNSUPPORTED');
});

test('hold, empty replacement and unavailable data stay distinguishable', () => {
  const held = validateAs('radio.apply', fixture('apply-moving-valid.json'));
  const emptied = validateAs('radio.apply', fixture('apply-empty-replace-valid.json'));
  const cleared = validateAs('radio.apply', fixture('apply-cleanup-clear-valid.json'));
  assert.ok(held.ok && emptied.ok && cleared.ok);
  if (!held.ok || !emptied.ok || !cleared.ok) return;
  assert.equal(held.value.bluetooth.directive, 'HOLD');
  assert.equal(held.value.bluetooth.entries, null);
  assert.equal(emptied.value.bluetooth.directive, 'REPLACE');
  assert.deepEqual(emptied.value.bluetooth.entries, []);
  assert.equal(cleared.value.bluetooth.directive, 'CLEAR');
  assert.equal(cleared.value.bluetooth.entries, null);

  const measured = validateAs('radio.readback', fixture('readback-empty-measured-valid.json'));
  const unavailable = validateAs('radio.readback', fixture('readback-unavailable-valid.json'));
  assert.ok(measured.ok && unavailable.ok);
  if (!measured.ok || !unavailable.ok) return;
  assert.equal(measured.value.bluetooth.availability, 'MEASURED');
  assert.deepEqual(measured.value.bluetooth.entries, []);
  assert.equal(unavailable.value.cells.availability, 'UNAVAILABLE');
  assert.equal(unavailable.value.cells.entries, null);
});

test('receipt is never reported or interpreted as application', () => {
  const received = validateAs('radio.result', fixture('result-received-pending-valid.json'));
  assert.ok(received.ok);
  if (!received.ok) return;
  const verdict = interpretResult(received.value);
  assert.equal(verdict.applied, false);
  assert.equal(verdict.uncertain, false);
  assert.equal(verdict.retry, 'NONE');
  assert.throws(() => assertApplied(received.value), /not applied/);

  const claimed = validateMessage(fixture('result-received-claims-application.json'));
  assert.equal(claimed.ok, false);
  if (!claimed.ok) assert.equal(claimed.detail, 'RECEIPT_CLAIMS_APPLICATION');
});

test('each result lifecycle maps to one retry decision', () => {
  const expectations: Array<[string, { applied: boolean; uncertain: boolean; retry: string }]> = [
    ['result-applied-valid.json', { applied: true, uncertain: false, retry: 'NONE' }],
    ['result-received-pending-valid.json', { applied: false, uncertain: false, retry: 'NONE' }],
    ['result-partial-valid.json', { applied: false, uncertain: false, retry: 'NEW_FRAME' }],
    ['result-expired-valid.json', { applied: false, uncertain: false, retry: 'NEW_FRAME' }],
    ['result-failed-uncertain-valid.json', { applied: false, uncertain: true, retry: 'STATUS_QUERY' }],
  ];
  for (const [file, expected] of expectations) {
    const parsed = validateAs('radio.result', fixture(file));
    assert.ok(parsed.ok, file);
    if (!parsed.ok) continue;
    const verdict = interpretResult(parsed.value);
    assert.equal(verdict.applied, expected.applied, `${file} applied`);
    assert.equal(verdict.uncertain, expected.uncertain, `${file} uncertain`);
    assert.equal(verdict.retry, expected.retry, `${file} retry`);
  }
});

test('a missing response stays uncertain instead of becoming a failure or a success', () => {
  const verdict = timedOutVerdict(47);
  assert.equal(verdict.state, 'TIMED_OUT');
  assert.equal(verdict.applied, false);
  assert.equal(verdict.uncertain, true);
  assert.equal(verdict.retry, 'STATUS_QUERY');
});

test('a duplicate sequence is answered from the stored result rather than re-applied', () => {
  const duplicate = validateAs('radio.result', fixture('result-duplicate-valid.json'));
  assert.ok(duplicate.ok);
  if (!duplicate.ok) return;
  assert.equal(duplicate.value.duplicate, true);
  assert.equal(interpretResult(duplicate.value).applied, true);
});

test('simulation time converts to phone boot time only through the session anchor', () => {
  const opened = validateAs('radio.session.opened', fixture('session-opened-valid.json'));
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const anchor = opened.value.clockAnchor;
  assert.equal(simToPhoneBootMs(anchor, 0), anchor.phoneBootMs);
  assert.equal(simToPhoneBootMs(anchor, 47000), anchor.phoneBootMs + 47000);
  assert.throws(() => simToPhoneBootMs(anchor, -1), /Invalid simulation clock/);
  const foreign = validateMessage(fixture('session-opened-foreign-anchor.json'));
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.detail, 'BOOT_MISMATCH');
});

test('a cached scan keeps its own age and is never restamped to the frame time', () => {
  const parsed = validateAs('radio.apply', fixture('apply-moving-valid.json'));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const ages = describeAges(parsed.value);
  assert.deepEqual(ages.find(a => a.interface === 'wifi'), { interface: 'wifi', ageMs: 17000, intervalMs: 30000, freshness: 'CACHED', held: false });
  assert.deepEqual(ages.find(a => a.interface === 'cells'), { interface: 'cells', ageMs: 0, intervalMs: 1000, freshness: 'FRESH', held: false });
  assert.equal(ages.find(a => a.interface === 'bluetooth')!.held, true);
  assert.deepEqual(overdueWarnings(parsed.value), []);
});

test('scan freshness separates fresh, cached and overdue samples', () => {
  assert.equal(freshness(0, 30000), 'FRESH');
  assert.equal(freshness(29000, 30000), 'CACHED');
  assert.equal(freshness(60000, 30000), 'OVERDUE');
  assert.equal(sampleAgeMs(47000, 30000), 17000);
  assert.throws(() => sampleAgeMs(30000, 47000), /newer than its frame/);
  assert.equal(SCAN_CADENCE.wifi.defaultIntervalMs, 30000);
  assert.equal(SCAN_CADENCE.cells.defaultIntervalMs, 1000);
});

test('an overdue cache raises a warning instead of being presented as current', () => {
  const parsed = validateAs('radio.apply', fixture('apply-moving-valid.json'));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const stale = applyRequestSchema.parse({ ...parsed.value, simElapsedMs: 120000, sequence: 120,
    wifi: { ...parsed.value.wifi, sampledSimElapsedMs: 30000 }, cells: { ...parsed.value.cells, sampledSimElapsedMs: 120000 } });
  assert.deepEqual(overdueWarnings(stale), ['SCAN_CACHE_OVERDUE:WIFI']);
  assert.equal(classifyWarnings(overdueWarnings(stale)).blocking.length, 1);
});

test('warning classification fails closed and only relaxes what the chosen policy names', () => {
  const warnings = ['SECTOR_UNKNOWN:tower-b', 'NO_ELIGIBLE_CELL', 'SOMETHING_NEW:x'];
  const conservative = classifyWarnings(warnings, CONSERVATIVE_ARRIVAL_POLICY);
  assert.deepEqual(conservative.advisory, []);
  assert.equal(conservative.blocking.length, 3);
  assert.deepEqual(conservative.unrecognized, ['SOMETHING_NEW:x']);
  const recommended = classifyWarnings(warnings, RECOMMENDED_ARRIVAL_POLICY);
  assert.deepEqual(recommended.advisory, ['SECTOR_UNKNOWN:tower-b']);
  assert.deepEqual(recommended.blocking, ['NO_ELIGIBLE_CELL', 'SOMETHING_NEW:x']);
});

function pair(readbackFile = 'readback-measured-valid.json') {
  const request = validateAs('radio.apply', fixture('apply-arrival-valid.json'));
  const report = validateAs('radio.readback', fixture(readbackFile));
  assert.ok(request.ok && report.ok);
  if (!request.ok || !report.ok) throw new Error('fixtures must parse');
  return { request: request.value, report: report.value };
}
const verdictFor = (result: ReturnType<typeof compareReadback>, name: string) => result.verdicts.find(v => v.interface === name)!;

test('a matching independent readback verifies the applied frame within tolerance', () => {
  const { request, report } = pair();
  const result = compareReadback(request, report);
  assert.equal(result.overall, 'VERIFIED');
  assert.equal(result.scopeLimited, false);
  for (const name of ['wifi', 'cells', 'bluetooth']) assert.equal(verdictFor(result, name).status, 'MATCH', name);
});

test('mismatch, unavailable data and unsupported scope remain three different answers', () => {
  const { request, report } = pair();
  const missing = compareReadback(request, { ...report, wifi: { availability: 'MEASURED', measurementMode: 'EXCLUSIVE', entries: report.wifi.entries!.slice(0, 1) } } as Readback);
  assert.equal(missing.overall, 'MISMATCH');
  assert.equal(verdictFor(missing, 'wifi').status, 'MISMATCH');
  assert.deepEqual(verdictFor(missing, 'wifi').missing, ['a4:2b:8c:00:11:23']);

  const unavailable = compareReadback(request, pair('readback-unavailable-valid.json').report);
  assert.equal(unavailable.overall, 'INCONCLUSIVE');
  assert.equal(verdictFor(unavailable, 'cells').status, 'UNAVAILABLE');
  assert.equal(verdictFor(unavailable, 'cells').reason, 'PERMISSION_DENIED');

  const outOfScope = compareReadback(request, pair('readback-out-of-scope-valid.json').report);
  assert.equal(verdictFor(outOfScope, 'bluetooth').status, 'OUT_OF_SCOPE');
  assert.equal(outOfScope.scopeLimited, true);
  assert.notEqual(outOfScope.overall, 'MISMATCH');
});

test('a power reading beyond tolerance is a mismatch, and one inside it is not', () => {
  const { request, report } = pair();
  const shift = (delta: number) => compareReadback(request, {
    ...report, wifi: { ...report.wifi, entries: report.wifi.entries!.map(e => ({ ...e, rssiDbm: e.rssiDbm + delta })) },
  } as Readback);
  assert.equal(verdictFor(shift(2), 'wifi').status, 'MATCH');
  const failed = shift(6);
  assert.equal(verdictFor(failed, 'wifi').status, 'MISMATCH');
  assert.equal(verdictFor(failed, 'wifi').reason, 'MEASUREMENT_OUTSIDE_TOLERANCE');
  assert.equal(verdictFor(failed, 'wifi').mismatched[0]!.field, 'rssiDbm');
});

test('observations taken before application are inconclusive, not a match or a mismatch', () => {
  const { request, report } = pair();
  const preApplication = compareReadback(request, {
    ...report,
    wifi: { ...report.wifi, entries: report.wifi.entries!.map(e => ({ ...e, measuredAtBootUs: (report.appliedAtBootMs - 5) * 1000 })) },
  } as Readback);
  assert.equal(verdictFor(preApplication, 'wifi').status, 'INCONCLUSIVE');
  assert.equal(verdictFor(preApplication, 'wifi').reason, 'PRE_APPLICATION_ONLY');
  assert.deepEqual(verdictFor(preApplication, 'wifi').staleOnly.length, 2);
  assert.equal(preApplication.overall, 'INCONCLUSIVE');

  const partial = compareReadback(request, {
    ...report,
    wifi: { ...report.wifi, entries: [{ ...report.wifi.entries![0]! }, { ...report.wifi.entries![1]!, measuredAtBootUs: (report.appliedAtBootMs - 5) * 1000 }] },
  } as Readback);
  assert.equal(verdictFor(partial, 'wifi').reason, 'PARTIALLY_PRE_APPLICATION');
});

test('extra observations only fail when the plugin claims it replaces the whole scan result', () => {
  const { request } = pair();
  const additive = compareReadback(request, pair('readback-additive-mode-valid.json').report);
  assert.equal(verdictFor(additive, 'wifi').status, 'MATCH');
  assert.deepEqual(verdictFor(additive, 'wifi').extra, ['ff:ee:dd:00:00:01']);

  const exclusive = pair('readback-additive-mode-valid.json').report;
  const strict = compareReadback(request, { ...exclusive, wifi: { ...exclusive.wifi, measurementMode: 'EXCLUSIVE' } } as Readback);
  assert.equal(verdictFor(strict, 'wifi').status, 'MISMATCH');
  assert.equal(verdictFor(strict, 'wifi').reason, 'UNEXPECTED_OBSERVATION');
});

test('an empty replacement is verifiable only where absence can be observed', () => {
  const emptied = validateAs('radio.apply', fixture('apply-empty-replace-valid.json'));
  assert.ok(emptied.ok);
  if (!emptied.ok) return;
  const { report } = pair();
  const exclusive = compareReadback(emptied.value, { ...report, bluetooth: { availability: 'MEASURED', measurementMode: 'EXCLUSIVE', entries: [] } } as Readback);
  assert.equal(verdictFor(exclusive, 'bluetooth').status, 'MATCH');
  const additive = compareReadback(emptied.value, { ...report, bluetooth: { availability: 'MEASURED', measurementMode: 'ADDITIVE', entries: [] } } as Readback);
  assert.equal(verdictFor(additive, 'bluetooth').status, 'INCONCLUSIVE');
  assert.equal(verdictFor(additive, 'bluetooth').reason, 'ADDITIVE_ABSENCE_UNVERIFIABLE');
  const populated = compareReadback(emptied.value, { ...report, bluetooth: { availability: 'MEASURED', measurementMode: 'EXCLUSIVE', entries: report.bluetooth.entries! } } as Readback);
  assert.equal(verdictFor(populated, 'bluetooth').status, 'MISMATCH');
});

test('a held interface is not verified by identity comparison and does not claim coverage', () => {
  const moving = validateAs('radio.apply', fixture('apply-moving-valid.json'));
  assert.ok(moving.ok);
  if (!moving.ok) return;
  const { report } = pair();
  const result = compareReadback({ ...moving.value, sequence: report.sequence } as ApplyRequest, report, RECOMMENDED_ARRIVAL_POLICY);
  assert.equal(verdictFor(result, 'bluetooth').status, 'NOT_REQUESTED');
  assert.equal(verdictFor(result, 'bluetooth').reason, 'HELD_NOT_VERIFIED');
});

test('blocking warnings stop verification regardless of the measurements', () => {
  const { request, report } = pair();
  const blocked = compareReadback({ ...request, warnings: ['NO_ELIGIBLE_CELL'] }, report);
  assert.equal(blocked.overall, 'BLOCKED');
  assert.deepEqual(blocked.warnings.blocking, ['NO_ELIGIBLE_CELL']);
  const advisory = compareReadback({ ...request, warnings: ['SECTOR_UNKNOWN:tower-b'] }, report, RECOMMENDED_ARRIVAL_POLICY);
  assert.equal(advisory.overall, 'VERIFIED');
  assert.deepEqual(advisory.warnings.advisory, ['SECTOR_UNKNOWN:tower-b']);
  assert.equal(compareReadback({ ...request, warnings: ['SECTOR_UNKNOWN:tower-b'] }, report, CONSERVATIVE_ARRIVAL_POLICY).overall, 'BLOCKED');
});

test('a readback for another frame, session or boot cannot be compared at all', () => {
  const { request, report } = pair();
  for (const change of [{ frameHash: 'c'.repeat(64) }, { sequence: 91 }]) {
    assert.throws(() => compareReadback(request, { ...report, ...change } as Readback), /does not correlate/);
  }
  for (const change of [{ bootId: 'boot-other' }, { sessionId: '00000000-0000-4000-8000-000000000000' }, { imageId: 'OTHER' }]) {
    assert.throws(() => compareReadback(request, { ...report, identity: { ...report.identity, ...change } } as Readback), /does not correlate/);
  }
});

test('the latency budget states the delivered path and does not advertise the polling rate as application', () => {
  assert.equal(LATENCY_BUDGET_MS.gpsSampleIntervalMs, 1000);
  assert.equal(LATENCY_BUDGET_MS.deliveredTotal,
    LATENCY_BUDGET_MS.deliveredEmitToReceipt + LATENCY_BUDGET_MS.deliveredReceiptToApplied + LATENCY_BUDGET_MS.deliveredAppliedToResult);
  assert.ok(LATENCY_BUDGET_MS.frameValidForDefault > LATENCY_BUDGET_MS.deliveredTotal);
  assert.ok(LATENCY_BUDGET_MS.operatorVisibleWorstCase >= LATENCY_BUDGET_MS.deliveredTotal + LATENCY_BUDGET_MS.uiSnapshotPollInterval);
});

const position = { lat: 25, lng: -80 };
const options = { tenantId: 'tenant', imageId: 'phone-a', sessionId: '11111111-1111-4111-8111-111111111111', datasetRevision: 'city:1', mcc: '310', mnc: '260' };
const records = [
  radioRecordSchema.parse({ ...position, kind: 'WIFI', identifier: '00:11:22:33:44:55', ssid: 'AP', frequencyMHz: 2412 }),
  radioRecordSchema.parse({ ...position, kind: 'CELL', identifier: 'tower', frequencyMHz: 1800,
    cell: { rat: 'LTE', mcc: '310', mnc: '260', areaCode: 42, cellId: 12345, pci: 2 },
    propagation: { referenceDbm: -65, referenceDistanceM: 100, exponent: 3, referenceFrequencyMHz: 1800, azimuthDeg: 0, beamwidthDeg: 120 } }),
  radioRecordSchema.parse({ ...position, kind: 'BLUETOOTH', identifier: '10:11:22:33:44:55' }),
];
const context = {
  messageId: '22222222-3333-4444-8555-666666666666', bootId: 'boot-1', sentAtWallMs: 1789700000000,
  wifiCacheIntervalMs: 30000, bluetoothCacheIntervalMs: 30000, wifiSampledSimElapsedMs: 0, bluetoothSampledSimElapsedMs: null,
};

test('a modeled frame converts to a valid request that keeps the model hold/replace decision', () => {
  const engine = new RadioEngine(records, options);
  const moving = engine.frame(position, 1000, 1);
  const request = applyRequestFromFrame(moving, { ...context, frameHash: hashFrame(moving) });
  assert.equal(validateMessage(request).ok, true);
  assert.equal(request.phase, 'MOVING');
  assert.equal(request.bluetooth.directive, 'HOLD');
  assert.equal(request.wifi.directive, 'REPLACE');
  assert.equal(request.identity.bootId, 'boot-1');
  assert.equal(request.sequence, moving.sequence);
  assert.equal(request.simElapsedMs, moving.elapsedMs);

  const arrived = engine.frame(position, 2000, 2, 'ARRIVED');
  const arrival = applyRequestFromFrame(arrived, { ...context, messageId: '22222222-3333-4444-8555-666666666667', frameHash: hashFrame(arrived), bluetoothSampledSimElapsedMs: 2000 });
  assert.equal(arrival.phase, 'ARRIVED');
  assert.equal(arrival.bluetooth.directive, 'REPLACE');
  assert.equal(arrival.bluetooth.entries!.length, 1);
  assert.equal(arrival.cells.entries![0]!.registered, true);
});

test('a converted frame reports its Wi-Fi cache age rather than the frame time', () => {
  const engine = new RadioEngine(records, options);
  engine.frame(position, 0, 0);
  const later = engine.frame(position, 12000, 12);
  const request = applyRequestFromFrame(later, { ...context, frameHash: hashFrame(later) });
  assert.equal(describeAges(request).find(a => a.interface === 'wifi')!.ageMs, 12000);
  assert.equal(describeAges(request).find(a => a.interface === 'cells')!.ageMs, 0);
});

test('the modeled frame version and the wire protocol version are validated independently', () => {
  const engine = new RadioEngine(records, options);
  const frame = engine.frame(position, 1000, 1);
  assert.equal(frame.version, 1);
  const request = applyRequestFromFrame(frame, { ...context, frameHash: hashFrame(frame) });
  assert.equal(request.protocolVersion, RADIO_PROTOCOL_VERSION);
  const bumped = validateMessage({ ...request, protocolVersion: RADIO_PROTOCOL_VERSION + 1 });
  assert.equal(bumped.ok, false);
  if (!bumped.ok) assert.equal(bumped.code, 'PROTOCOL_VERSION_UNSUPPORTED');
});

test('malformed measurements from a plugin cannot enter the controller as valid state', () => {
  const engine = new RadioEngine(records, options);
  const frame = engine.frame(position, 1000, 1);
  const request = applyRequestFromFrame(frame, { ...context, frameHash: hashFrame(frame) }) as ApplyRequest;
  const corrupt = (mutate: (value: Record<string, unknown>) => void) => {
    const copy = structuredClone(request) as unknown as Record<string, unknown>;
    mutate(copy);
    return validateMessage(copy);
  };
  const cases = [
    (v: Record<string, unknown>) => { (v.wifi as { entries: { rssiDbm: number }[] }).entries[0]!.rssiDbm = 12; },
    (v: Record<string, unknown>) => { (v.wifi as { entries: { bssid: string }[] }).entries[0]!.bssid = 'not-a-mac'; },
    (v: Record<string, unknown>) => { (v.cells as { entries: { rsrpDbm: number }[] }).entries[0]!.rsrpDbm = -300; },
    (v: Record<string, unknown>) => { (v.identity as { sessionId: string }).sessionId = 'not-a-uuid'; },
    (v: Record<string, unknown>) => { v.warnings = 'SECTOR_UNKNOWN'; },
  ];
  for (const mutate of cases) {
    const result = corrupt(mutate);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'MALFORMED_MESSAGE');
  }
});

test('an applied result correlates back to the request it answers', () => {
  const applied = validateAs('radio.result', fixture('result-applied-valid.json'));
  const request = validateAs('radio.apply', fixture('apply-moving-valid.json'));
  assert.ok(applied.ok && request.ok);
  if (!applied.ok || !request.ok) return;
  const result: ApplyResult = applied.value;
  assert.equal(result.requestMessageId, request.value.messageId);
  assert.equal(result.sequence, request.value.sequence);
  assert.equal(result.frameHash, request.value.frameHash);
  assert.deepEqual(result.identity, request.value.identity);
  assert.doesNotThrow(() => assertApplied(result));
});
