import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { radioRecordSchema } from '../src/radio/schema.js';
import { MemoryRadioEvidenceStore } from '../src/radio/evidence.js';
import { injectionScopeFingerprint, TripRadioRuntime } from '../src/radio/runtime.js';
import { TripArrivalLifecycle } from '../src/radio/lifecycle.js';
import { destinationPolicy, durableLocationAfterTrip } from '../src/radio/destinationPolicy.js';
import { startStubRadioReceiver } from '../src/trips/radioStubReceiver.js';
import { connectLoopback, createAuthenticatedRadioTransport } from '../src/trips/radioTransport.js';
import { RadioDeliveryAdapter } from '../src/trips/radioDelivery.js';
import { previewRadioCodec } from '../src/trips/radioWire.js';
import { withPhysicalImageLease, type ImageLeaseClient, type ImageOwnership } from '../src/trips/imageOwnership.js';
import { EVIDENCE_CLASS, type ApplyRequest, type Readback } from '../src/radio/contract.js';

const session = '11111111-1111-4111-8111-111111111111';
const dest = { lat: 25, lng: -80 };
const anchor = { lat: 25.1, lng: -80.1 };
const wifi = radioRecordSchema.parse({ ...dest, kind: 'WIFI', identifier: '00:11:22:33:44:55', ssid: 'AP', frequencyMHz: 2412 });
const cell = radioRecordSchema.parse({
  ...dest, kind: 'CELL', identifier: 'tower-a', frequencyMHz: 1800,
  cell: { rat: 'LTE', mcc: '310', mnc: '260', areaCode: 42, cellId: 12345, pci: 2 },
  propagation: { referenceDbm: -65, referenceDistanceM: 100, exponent: 3, referenceFrequencyMHz: 1800, azimuthDeg: 0, beamwidthDeg: 120 },
});
const bluetooth = radioRecordSchema.parse({ ...dest, kind: 'BLUETOOTH', identifier: 'aa:bb:cc:dd:ee:ff' });
const records = [wifi, cell, bluetooth];
const emptyBtRecords = [wifi, cell];
const scope = injectionScopeFingerprint(['net.stakeout.duomove.player']);

function fakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const alive = (key: string) => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) { store.delete(key); return undefined; }
    return entry;
  };
  const client: ImageLeaseClient = {
    async set(key, value, _px, ttlMs) {
      if (alive(key)) return null;
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return 'OK';
    },
    async eval(script, _numKeys, ...args) {
      const [key, expected, ttlMs] = args as [string, string, number | undefined];
      const entry = alive(key);
      if (!entry || entry.value !== expected) return 0;
      if (script.includes('PEXPIRE')) { entry.expiresAt = Date.now() + Number(ttlMs ?? 60_000); return 1; }
      store.delete(key);
      return 1;
    },
    async incr(key) {
      const entry = alive(key);
      const next = Number(entry?.value ?? 0) + 1;
      store.set(key, { value: String(next), expiresAt: Number.MAX_SAFE_INTEGER });
      return next;
    },
  };
  return client;
}

function openRuntime(evidence: MemoryRadioEvidenceStore, extra: ConstructorParameters<typeof TripRadioRuntime>[0] extends infer T ? Partial<T> : never = {}) {
  return new TripRadioRuntime({
    records, tenantId: 'workspace-one', imageId: 'phone-a', tripId: 'trip-a', deviceId: 'device-a',
    datasetRevision: 'city:1', mcc: '310', mnc: '260', bootId: 'boot-a', instanceId: 'agent-a',
    scopeFingerprint: scope, sessionId: session, evidence, scheduleMode: 'LOCAL_SCHEDULE',
    source: 'STUB_RECEIVER', ...extra,
  });
}

function lifecycle(runtime: TripRadioRuntime | null, evidence: MemoryRadioEvidenceStore, extra: Partial<ConstructorParameters<typeof TripArrivalLifecycle>[0]> = {}) {
  return new TripArrivalLifecycle({
    runtime, evidence, tenantId: 'workspace-one', tripId: 'trip-a', deviceId: 'device-a', imageId: 'phone-a',
    sessionId: runtime?.sessionId ?? session, bootId: 'boot-a', instanceId: 'agent-a',
    destination: dest, anchor, destinationPolicy: 'HOLD_DESTINATION', dwellMs: 2000, radiusM: 30,
    observationTimeoutMs: 5000, ...extra,
  });
}

function fix(sequence: number, extra: Partial<Identified> = {}) {
  const elapsedMs = extra.elapsedMs ?? sequence * 1000;
  return {
    lat: extra.lat ?? dest.lat, lng: extra.lng ?? dest.lng, accuracyM: extra.accuracyM ?? 8,
    speedMps: extra.speedMps ?? 0, elapsedMs, nowElapsedMs: extra.nowElapsedMs ?? elapsedMs,
    sequence, wallMs: 1_779_000_000_000 + sequence * 1000, bootId: extra.bootId ?? 'boot-a',
  };
}
type Identified = { lat: number; lng: number; accuracyM: number; speedMps: number; elapsedMs: number; nowElapsedMs: number; bootId: string };

async function withStub<T>(fn: (delivery: RadioDeliveryAdapter, receiver: Awaited<ReturnType<typeof startStubRadioReceiver>>) => Promise<T>, behavior?: () => 'APPLIED' | 'SILENT') {
  const token = 'radio-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const redis = fakeRedis();
  const receiver = await startStubRadioReceiver({
    imageId: 'phone-a', token, agentInstanceId: 'agent-a', bootId: 'boot-a', behavior,
  });
  try {
    return await withPhysicalImageLease('phone-a', redis, async (ownership: ImageOwnership) => {
      const transport = createAuthenticatedRadioTransport({
        imageId: 'phone-a', codec: previewRadioCodec,
        connect: () => connectLoopback(receiver.port), credential: async () => token,
      });
      const delivery = new RadioDeliveryAdapter({
        identity: {
          tenantId: 'workspace-one', imageId: 'phone-a', sessionId: session, moduleName: 'duomove-radio',
          moduleVersion: '0.1.0-stub', agentPackage: 'net.stakeout.duomove.radioagent',
          agentInstanceId: 'agent-a', bootId: 'boot-a', datasetRevision: 'city:1',
        },
        ownership, transport, codec: previewRadioCodec, timeoutMs: 1000,
      });
      try { return await fn(delivery, receiver); }
      finally { transport.close(); }
    });
  } finally { await receiver.close(); }
}

test('C04 default holds the destination and remains selectable', () => {
  assert.equal(destinationPolicy({}), 'HOLD_DESTINATION');
  assert.equal(destinationPolicy({ DUOMOVE_DESTINATION_POLICY: 'RETURN_TO_ANCHOR' }), 'RETURN_TO_ANCHOR');
  const held = durableLocationAfterTrip('HOLD_DESTINATION', dest, anchor);
  assert.equal(held.source, 'DESTINATION');
  assert.equal(held.lat, dest.lat);
  const home = durableLocationAfterTrip('RETURN_TO_ANCHOR', dest, anchor);
  assert.equal(home.source, 'ANCHOR');
  assert.equal(home.lat, anchor.lat);
});

test('D01 outside radius, stale, moving or discontinuous GPS cannot ready the arrival gate', async () => {
  const evidence = new MemoryRadioEvidenceStore();
  const outside = lifecycle(openRuntime(evidence), evidence);
  assert.equal((await outside.onIdentifiedFix(fix(0, { lat: 26, speedMps: 0 }))).gateState, 'MOVING');
  assert.equal((await outside.onIdentifiedFix(fix(1, { lat: 26 }))).bluetoothIntent, 'HOLD');

  const moving = lifecycle(openRuntime(evidence), evidence);
  assert.equal((await moving.onIdentifiedFix(fix(0, { speedMps: 8 }))).gateState, 'MOVING');

  const stale = lifecycle(openRuntime(evidence), evidence);
  const blocked = await stale.onIdentifiedFix(fix(0, { elapsedMs: 0, nowElapsedMs: 9000 }));
  assert.equal(blocked.gateState, 'BLOCKED');
  assert.equal(blocked.gateReason, 'LOCATION_STALE');
  assert.equal(blocked.radio?.apply?.bluetooth.directive ?? 'HOLD', 'HOLD');

  const gap = lifecycle(openRuntime(evidence), evidence);
  await gap.onIdentifiedFix(fix(0));
  const afterGap = await gap.onIdentifiedFix(fix(1, { elapsedMs: 8000 }));
  assert.equal(afterGap.gateState, 'MOVING');
  assert.notEqual(afterGap.stage, 'APPLYING_ARRIVAL');
});

test('D01 qualifying stationary fixes advance settling then arrival Bluetooth REPLACE', async () => {
  await withStub(async (delivery, receiver) => {
    const evidence = new MemoryRadioEvidenceStore();
    const runtime = openRuntime(evidence, { delivery });
    const arrival = lifecycle(runtime, evidence);
    assert.equal((await arrival.onIdentifiedFix(fix(0, { speedMps: 12, lat: 24.9 }))).bluetoothIntent, 'HOLD');
    assert.equal((await arrival.onIdentifiedFix(fix(1))).stage, 'SETTLING');
    assert.equal((await arrival.onIdentifiedFix(fix(2))).bluetoothIntent, 'HOLD');
    const ready = await arrival.onIdentifiedFix(fix(3));
    assert.equal(ready.bluetoothIntent, 'REPLACE');
    assert.equal(ready.radio?.apply?.phase, 'ARRIVED');
    assert.equal(ready.radio?.apply?.bluetooth.directive, 'REPLACE');
    assert.equal(ready.radio?.apply?.cells.directive, 'HOLD');
    assert.ok((ready.radio?.apply?.bluetooth.entries?.length ?? 0) >= 1);
    assert.equal(ready.applied, false);
    assert.equal(ready.radio?.evidence.evidenceClass, 'STUB_NOT_APPLICATION');
    assert.equal(receiver.applied.length, 1);
    assert.equal(ready.providerCleanupAllowed, false);
    assert.match(ready.detail, /not observed application/);
  });
});

test('D03 empty REPLACE, HOLD, CLEAR and unavailable observation stay distinct', async () => {
  await withStub(async (delivery, receiver) => {
    const evidence = new MemoryRadioEvidenceStore();
    const runtime = new TripRadioRuntime({
      records: emptyBtRecords, tenantId: 'workspace-one', imageId: 'phone-a', tripId: 'trip-a', deviceId: 'device-a',
      datasetRevision: 'city:1', mcc: '310', mnc: '260', bootId: 'boot-a', instanceId: 'agent-a',
      scopeFingerprint: scope, sessionId: session, evidence, scheduleMode: 'LOCAL_SCHEDULE',
      source: 'STUB_RECEIVER', delivery,
    });
    const arrival = lifecycle(runtime, evidence);
    await arrival.onIdentifiedFix(fix(0, { speedMps: 9, lat: 24.9 }));
    await arrival.onIdentifiedFix(fix(1));
    const moving = await arrival.onIdentifiedFix(fix(2));
    assert.equal(moving.radio?.apply?.bluetooth.directive, 'HOLD');
    assert.equal(moving.radio?.apply?.bluetooth.entries, null);
    const arrived = await arrival.onIdentifiedFix(fix(3));
    assert.equal(arrived.radio?.apply?.bluetooth.directive, 'REPLACE');
    assert.deepEqual(arrived.radio?.apply?.bluetooth.entries, []);
    const timed = await arrival.onObservationTimeout(1_779_000_000_000 + 20_000);
    assert.equal(timed.radio?.apply?.bluetooth.directive, 'CLEAR');
    assert.equal(timed.radio?.apply?.bluetooth.entries, null);
    assert.equal(timed.radio?.apply?.phase, 'CLEANUP');
    assert.equal(timed.stage, 'COMPLETE');
    assert.equal(evidence.rows.some((row) => row.lifecycle === 'OBSERVATION_TIMED_OUT'), true);
    assert.equal(timed.applied, false);
  });
});

test('D04 player GPS cleanup before observation does not finish the trip or snap to the anchor', async () => {
  await withStub(async (delivery) => {
    const evidence = new MemoryRadioEvidenceStore();
    const arrival = lifecycle(openRuntime(evidence, { delivery }), evidence);
    await arrival.onIdentifiedFix(fix(0));
    await arrival.onIdentifiedFix(fix(1));
    await arrival.onIdentifiedFix(fix(2));
    await arrival.onIdentifiedFix(fix(3));
    const early = await arrival.notePlayerGpsCleaned(1_779_000_000_000 + 4000);
    assert.equal(early.gpsProvidersCleanedEarly, true);
    assert.equal(early.providerCleanupAllowed, false);
    assert.equal(early.canReleasePhone, false);
    assert.equal(early.durableLocation.source, 'DESTINATION');
    assert.equal(early.durableLocation.lat, dest.lat);
    const done = await arrival.onObservationTimeout(1_779_000_000_000 + 9000);
    assert.equal(done.providerCleanupAllowed, true);
    assert.equal(done.radioCleanupAllowed, true);
    assert.equal(done.canReleasePhone, true);
    assert.equal(done.durableLocation.source, 'DESTINATION');
  });
});

test('D06 pause/resume uses a new session and cannot fire arrival Bluetooth while travel resumes', async () => {
  await withStub(async (delivery, receiver) => {
    const evidence = new MemoryRadioEvidenceStore();
    const first = lifecycle(openRuntime(evidence, { delivery }), evidence);
    await first.onIdentifiedFix(fix(0, { speedMps: 10, lat: 24.99 }));
    await first.pause('Paused by user', 1_779_000_000_000 + 1500);
    assert.equal(first.snapshot().stage, 'PAUSED');
    const resumedSession = '22222222-2222-4222-8222-222222222222';
    const resumed = lifecycle(openRuntime(evidence, { delivery, sessionId: resumedSession, bootId: 'boot-b' }), evidence, {
      sessionId: resumedSession, bootId: 'boot-b',
    });
    const travel = await resumed.onIdentifiedFix(fix(0, { speedMps: 9, lat: 24.99, bootId: 'boot-b' }));
    assert.equal(travel.bluetoothIntent, 'HOLD');
    assert.equal(travel.radio?.apply?.phase, 'MOVING');
    assert.equal(travel.radio?.apply?.bluetooth.directive, 'HOLD');
    const arrivalFrames = receiver.applied.filter((row) => {
      const frame = row.frame as { bluetooth?: { directive?: string } };
      return frame.bluetooth?.directive === 'REPLACE';
    });
    assert.equal(arrivalFrames.length, 0);
    assert.equal(evidence.rows.filter((row) => row.sessionId === session && row.current).length, 0);
  });
});

test('D07/D08 restart, expiry and uncertain cancel stay visible and do not invent application', async () => {
  await withStub(async (delivery) => {
    const evidence = new MemoryRadioEvidenceStore();
    const arrival = lifecycle(openRuntime(evidence, { delivery, source: 'STUB_RECEIVER' }), evidence, { observationTimeoutMs: 50 });
    await arrival.onIdentifiedFix(fix(0));
    await arrival.onIdentifiedFix(fix(1));
    await arrival.onIdentifiedFix(fix(2));
    await arrival.onIdentifiedFix(fix(3));
    const expired = await arrival.expire('Radio session idle-expired; a new session is required', 1_779_000_000_000 + 70_000);
    assert.equal(expired.stage, 'EXPIRED');
    assert.equal(expired.applied, false);
    assert.equal(expired.canReleasePhone, false);
    assert.equal(evidence.rows.some((row) => row.lifecycle === 'EXPIRED'), true);
  }, () => 'SILENT');

  await withStub(async (delivery) => {
    const evidence = new MemoryRadioEvidenceStore();
    const arrival = lifecycle(openRuntime(evidence, { delivery }), evidence);
    await arrival.onIdentifiedFix(fix(0, { speedMps: 11, lat: 24.9 }));
    const cancelled = await arrival.cancel('Connection lost immediately after a delivered frame', 1_779_000_000_000 + 2000, true);
    assert.equal(cancelled.stage, 'UNCERTAIN_CANCEL');
    assert.equal(cancelled.applied, false);
    assert.equal(cancelled.canReleasePhone, false);
    assert.equal(cancelled.uncertain, true);
    assert.equal(evidence.rows.some((row) => row.lifecycle === 'UNCERTAIN_CANCEL'), true);
  }, () => 'SILENT');

  const evidence = new MemoryRadioEvidenceStore();
  const restarted = lifecycle(openRuntime(evidence), evidence);
  const broken = await restarted.continuityBreak('Controller restarted; previous radio session did not survive', Date.now());
  assert.equal(broken.stage, 'EXPIRED');
  assert.match(broken.detail, /did not survive/);
});

function inScopeReadback(apply: ApplyRequest, extra: Partial<Readback> = {}): Readback {
  const wifi = apply.wifi.directive === 'REPLACE'
    ? {
      availability: 'MEASURED' as const, measurementMode: 'EXCLUSIVE' as const,
      collectionMethod: 'INJECTED_HOOK' as const, apiSource: 'WifiManager.getScanResults',
      entries: apply.wifi.entries.map((entry) => ({ ...entry, measuredAtBootUs: 1_500_000 })),
    }
    : { availability: 'UNSUPPORTED_IN_SCOPE' as const, reason: 'not requested', entries: null };
  const bluetooth = apply.bluetooth.directive === 'REPLACE'
    ? {
      availability: 'MEASURED' as const, measurementMode: 'EXCLUSIVE' as const,
      collectionMethod: 'INJECTED_HOOK' as const, apiSource: 'BluetoothLeScanner.ScanCallback',
      entries: apply.bluetooth.entries.map((entry) => ({ address: entry.address, name: entry.name, rssiDbm: entry.rssiDbm, measuredAtBootMs: 1500 })),
    }
    : { availability: 'UNSUPPORTED_IN_SCOPE' as const, reason: 'not requested', entries: null };
  return {
    protocol: 'duoplus.radio', protocolVersion: 1, messageType: 'radio.readback',
    messageId: randomUUID(), sentAtWallMs: apply.sentAtWallMs, identity: apply.identity,
    scope: 'ANDROID_API_READBACK', evidenceClass: EVIDENCE_CLASS,
    observerPackage: 'net.stakeout.duomove.probe', observerProcess: 'net.stakeout.duomove.probe:collector',
    observerPid: 8241, observerUid: 10231, scopeMembership: 'IN_SCOPE',
    scopeFingerprint: apply.scopeFingerprint, wifiScanThrottleDisabled: true,
    sequence: apply.sequence, frameHash: apply.frameHash, observedAtBootMs: 2000, appliedAtBootMs: 1000,
    wifi, cells: { availability: 'UNSUPPORTED_IN_SCOPE', reason: 'No LTE/NR dataset for this service area', entries: null },
    bluetooth, ...extra,
  };
}

test('arrival verifies Wi-Fi plus Bluetooth while cells stay UNSUPPORTED_IN_SCOPE', async () => {
  await withStub(async (delivery) => {
    const evidence = new MemoryRadioEvidenceStore();
    const arrival = lifecycle(openRuntime(evidence, { delivery }), evidence);
    await arrival.onIdentifiedFix(fix(0));
    await arrival.onIdentifiedFix(fix(1));
    await arrival.onIdentifiedFix(fix(2));
    const ready = await arrival.onIdentifiedFix(fix(3));
    const compared = await arrival.onReadback(inScopeReadback(ready.radio!.apply!), 1_779_000_000_000 + 4000);
    assert.equal(compared.comparison?.verdicts.find((v) => v.interface === 'cells')?.status, 'NOT_REQUESTED');
    assert.equal(compared.comparison?.overall, 'VERIFIED');
    assert.equal(compared.applied, false);
    assert.equal(compared.canReleasePhone, true);
    assert.equal(evidence.rows.some((row) => row.kind === 'READBACK' && row.applied), false);
  });
});

test('out-of-scope observers cannot produce MISMATCH; throttle is INCONCLUSIVE not a phone mismatch', async () => {
  await withStub(async (delivery) => {
    const evidence = new MemoryRadioEvidenceStore();
    const arrival = lifecycle(openRuntime(evidence, { delivery }), evidence);
    await arrival.onIdentifiedFix(fix(0));
    await arrival.onIdentifiedFix(fix(1));
    await arrival.onIdentifiedFix(fix(2));
    const ready = await arrival.onIdentifiedFix(fix(3));
    const apply = ready.radio!.apply!;
    const host = await arrival.onReadback(inScopeReadback(apply, {
      scopeMembership: 'OUT_OF_SCOPE',
      wifi: { availability: 'MEASURED', measurementMode: 'EXCLUSIVE', collectionMethod: 'LIVE_SCAN', apiSource: 'WifiManager.getScanResults', entries: [] },
      bluetooth: { availability: 'MEASURED', measurementMode: 'EXCLUSIVE', collectionMethod: 'LIVE_SCAN', apiSource: 'BluetoothLeScanner.ScanCallback', entries: [] },
    }), 1_779_000_000_000 + 4100);
    assert.equal(host.comparison?.overall, 'OUT_OF_SCOPE_CONFIRMED');
    assert.notEqual(host.comparison?.overall, 'MISMATCH');
    assert.equal(host.stage, 'AWAITING_OBSERVATION');

    const leak = await arrival.onReadback(inScopeReadback(apply, { scopeMembership: 'OUT_OF_SCOPE' }), 1_779_000_000_000 + 4200);
    assert.equal(leak.comparison?.overall, 'SCOPE_LEAK');

    const throttled = await arrival.onReadback(inScopeReadback(apply, {
      wifiScanThrottleDisabled: false,
      wifi: {
        availability: 'MEASURED', measurementMode: 'EXCLUSIVE', collectionMethod: 'PLATFORM_CACHE',
        apiSource: 'WifiManager.getScanResults',
        entries: apply.wifi.directive === 'REPLACE' ? apply.wifi.entries.map((entry) => ({ ...entry, measuredAtBootUs: 500_000 })) : [],
      },
    }), 1_779_000_000_000 + 4300);
    assert.notEqual(throttled.comparison?.overall, 'MISMATCH');
    assert.equal(throttled.comparison?.verdicts.find((v) => v.interface === 'wifi')?.status, 'INCONCLUSIVE');
    assert.equal(throttled.comparison?.verdicts.find((v) => v.interface === 'wifi')?.reason, 'SCAN_THROTTLED_PRE_APPLICATION_ONLY');
    assert.match(throttled.detail, /not a phone mismatch/);
  });
});

test('wrong dataset revision and physical RF claims cannot compare or be stored as application', async () => {
  await withStub(async (delivery) => {
    const evidence = new MemoryRadioEvidenceStore();
    const arrival = lifecycle(openRuntime(evidence, { delivery }), evidence);
    await arrival.onIdentifiedFix(fix(0));
    await arrival.onIdentifiedFix(fix(1));
    await arrival.onIdentifiedFix(fix(2));
    const ready = await arrival.onIdentifiedFix(fix(3));
    const apply = ready.radio!.apply!;
    const wrongRevision = await arrival.onReadback(inScopeReadback(apply, {
      identity: { ...apply.identity, datasetRevision: 'other-city:9' },
    }), 1_779_000_000_000 + 4400);
    assert.match(wrongRevision.detail, /dataset revision/i);
    const wrongScope = await arrival.onReadback(inScopeReadback(apply, { scopeFingerprint: 'b'.repeat(64) }), 1_779_000_000_000 + 4600);
    assert.match(wrongScope.detail, /scope/i);
    await assert.rejects(
      () => arrival.onReadback(inScopeReadback(apply, { evidenceClass: 'PHYSICAL_RF' as typeof EVIDENCE_CLASS }), 1_779_000_000_000 + 4500),
    );
    assert.equal(evidence.rows.every((row) => row.applied === false), true);
  });
});
