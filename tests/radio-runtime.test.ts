import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { radioRecordSchema } from '../src/radio/schema.js';
import { MemoryRadioEvidenceStore, radioEvidenceInputSchema } from '../src/radio/evidence.js';
import { injectionScopeFingerprint, TripRadioRuntime } from '../src/radio/runtime.js';
import { radioScheduleMode, requiresBoundedDelivery } from '../src/radio/scheduling.js';
import { startStubRadioReceiver } from '../src/trips/radioStubReceiver.js';
import { connectLoopback, createAuthenticatedRadioTransport } from '../src/trips/radioTransport.js';
import { RadioDeliveryAdapter } from '../src/trips/radioDelivery.js';
import { previewRadioCodec } from '../src/trips/radioWire.js';
import { withPhysicalImageLease, type ImageLeaseClient, type ImageOwnership } from '../src/trips/imageOwnership.js';

const session = '11111111-1111-4111-8111-111111111111';
const position = { lat: 25, lng: -80 };
const wifi = radioRecordSchema.parse({ ...position, kind: 'WIFI', identifier: '00:11:22:33:44:55', ssid: 'AP', frequencyMHz: 2412 });
const cellA = radioRecordSchema.parse({
  ...position, kind: 'CELL', identifier: 'tower-a', frequencyMHz: 1800,
  cell: { rat: 'LTE', mcc: '310', mnc: '260', areaCode: 42, cellId: 12345, pci: 2 },
  propagation: { referenceDbm: -65, referenceDistanceM: 100, exponent: 3, referenceFrequencyMHz: 1800, azimuthDeg: 0, beamwidthDeg: 120 },
});
const cellB = radioRecordSchema.parse({
  lat: 25.01, lng: -80, kind: 'CELL', identifier: 'tower-b', frequencyMHz: 1800,
  cell: { rat: 'LTE', mcc: '310', mnc: '260', areaCode: 42, cellId: 54321, pci: 3 },
  propagation: { referenceDbm: -65, referenceDistanceM: 100, exponent: 3, referenceFrequencyMHz: 1800, azimuthDeg: 0, beamwidthDeg: 120 },
});
const records = [wifi, cellA, cellB];
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

function progress(sequence: number, extra: Partial<{ lat: number; lng: number; phase: 'MOVING' | 'ARRIVED' | 'CLEANUP'; elapsedMs: number }> = {}) {
  return {
    tripId: 'trip-a', deviceId: 'device-a', tenantId: 'workspace-one', imageId: 'phone-a',
    position: { lat: extra.lat ?? position.lat, lng: extra.lng ?? position.lng },
    elapsedMs: extra.elapsedMs ?? sequence * 1000, sequence,
    phase: extra.phase ?? 'MOVING', wallMs: 1_779_000_000_000 + sequence * 1000,
  };
}

function openRuntime(evidence: MemoryRadioEvidenceStore, extra: ConstructorParameters<typeof TripRadioRuntime>[0] extends infer T ? Partial<T> : never = {}) {
  return new TripRadioRuntime({
    records, tenantId: 'workspace-one', imageId: 'phone-a', tripId: 'trip-a', deviceId: 'device-a',
    datasetRevision: 'city:1', mcc: '310', mnc: '260', bootId: 'boot-a', instanceId: 'agent-a',
    scopeFingerprint: scope, sessionId: session, evidence, scheduleMode: 'LOCAL_SCHEDULE',
    source: 'STUB_RECEIVER', ...extra,
  });
}

test('schedule mode is selectable and only arrival and cleanup use the delivered path by default', () => {
  assert.equal(radioScheduleMode({}), 'LOCAL_SCHEDULE');
  assert.equal(radioScheduleMode({ DUOMOVE_RADIO_SCHEDULE_MODE: 'DELIVERED' }), 'DELIVERED');
  assert.equal(requiresBoundedDelivery('MOVING', 'LOCAL_SCHEDULE'), false);
  assert.equal(requiresBoundedDelivery('ARRIVED', 'LOCAL_SCHEDULE'), true);
  assert.equal(requiresBoundedDelivery('CLEANUP', 'LOCAL_SCHEDULE'), true);
  assert.equal(requiresBoundedDelivery('MOVING', 'DELIVERED'), true);
  assert.throws(() => radioScheduleMode({ DUOMOVE_RADIO_SCHEDULE_MODE: 'WHENEVER' }));
});

test('one trip session retains cache and serving-cell continuity across GPS ticks', async () => {
  const evidence = new MemoryRadioEvidenceStore();
  const runtime = openRuntime(evidence);
  const first = await runtime.ingest(progress(0));
  const second = await runtime.ingest(progress(1, { lat: 25.00001 }));
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(first.sessionId, session);
  assert.deepEqual(first.frame?.wifi, second.frame?.wifi);
  assert.equal(first.frame?.wifi[0]?.sampleElapsedMs, 0);
  assert.equal(first.delivered, false);
  assert.equal(second.applied, false);
  const atNeighbor = await runtime.ingest(progress(2, { lat: 25.01, elapsedMs: 2000 }));
  const afterTrigger = await runtime.ingest(progress(3, { lat: 25.01, elapsedMs: 6000 }));
  assert.equal(atNeighbor.frame?.cells.find((cell) => cell.registered)?.identifier, 'CELL:LTE:310:260:42:12345');
  assert.equal(afterTrigger.frame?.cells.find((cell) => cell.registered)?.identifier, 'CELL:LTE:310:260:42:54321');
  assert.equal(afterTrigger.frame?.handover?.from, 'CELL:LTE:310:260:42:12345');
  assert.equal(afterTrigger.frame?.handover?.to, 'CELL:LTE:310:260:42:54321');
  assert.ok(evidence.rows.every((row) => row.sessionId === session && row.imageId === 'phone-a' && row.bootId === 'boot-a'));
});

test('a stub APPLIED result is never stored as real application evidence', async () => {
  const token = 'radio-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const redis = fakeRedis();
  const evidence = new MemoryRadioEvidenceStore();
  const receiver = await startStubRadioReceiver({ imageId: 'phone-a', token, agentInstanceId: 'agent-a', bootId: 'boot-a' });
  try {
    await withPhysicalImageLease('phone-a', redis, async (ownership: ImageOwnership) => {
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
      const runtime = openRuntime(evidence, { delivery, source: 'STUB_RECEIVER' });
      await runtime.ingest(progress(0));
      const arrived = await runtime.ingest(progress(1, { phase: 'ARRIVED' }));
      transport.close();
      assert.equal(arrived.delivered, true);
      assert.equal(arrived.delivery?.state, 'APPLIED');
      assert.equal(arrived.applied, false);
      assert.equal(arrived.evidence.evidenceClass, 'STUB_NOT_APPLICATION');
      assert.equal(receiver.applied.length, 1);
      assert.match(arrived.evidence.detail, /not evidence of real application/);
      assert.equal(arrived.apply?.identity.bootId, 'boot-a');
      assert.equal(arrived.apply?.identity.datasetRevision, 'city:1');
      assert.equal(arrived.apply?.identity.sessionId, session);
    });
  } finally { await receiver.close(); }
});

test('late frames are rejected and duplicates do not roll radio state backward', async () => {
  const evidence = new MemoryRadioEvidenceStore();
  const runtime = openRuntime(evidence);
  const first = await runtime.ingest(progress(0));
  const second = await runtime.ingest(progress(1, { lat: 25.01 }));
  const late = await runtime.ingest(progress(0, { lat: 24 }));
  const duplicate = await runtime.ingest(progress(1, { lat: 25.01 }));
  assert.equal(late.late, true);
  assert.equal(late.applied, false);
  assert.equal(runtime.summary().lastSequence, 1);
  assert.equal(second.frame?.cells.find((cell) => cell.registered)?.identifier, runtime.summary().lastServing);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.frame?.sequence, 1);
  assert.notEqual(first.frame?.position.lat, 24);
});

test('a lost response stays uncertain and a status query does not invent application', async () => {
  const token = 'radio-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const redis = fakeRedis();
  const evidence = new MemoryRadioEvidenceStore();
  const receiver = await startStubRadioReceiver({
    imageId: 'phone-a', token, agentInstanceId: 'agent-a', bootId: 'boot-a', behavior: () => 'SILENT',
  });
  try {
    await withPhysicalImageLease('phone-a', redis, async (ownership) => {
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
        ownership, transport, codec: previewRadioCodec, timeoutMs: 80,
      });
      const runtime = openRuntime(evidence, { delivery, scheduleMode: 'DELIVERED', source: 'STUB_RECEIVER' });
      const tick = await runtime.ingest(progress(0));
      assert.equal(tick.uncertain, true);
      assert.equal(tick.applied, false);
      assert.equal(tick.delivery?.state, 'TIMED_OUT');
      const reconciled = await runtime.reconcile(0);
      assert.equal(reconciled?.applied, false);
      assert.equal(reconciled?.uncertain, true);
      const unknown = await runtime.reconcile(99);
      assert.equal(unknown, null);
      transport.close();
    });
  } finally { await receiver.close(); }
});

test('durable evidence is tenant-scoped and a new session is never shown as the old current result', async () => {
  const evidence = new MemoryRadioEvidenceStore();
  const first = openRuntime(evidence);
  await first.ingest(progress(0));
  const restarted = openRuntime(evidence, { sessionId: '22222222-2222-4222-8222-222222222222', bootId: 'boot-b' });
  await restarted.ingest(progress(0));
  const current = await evidence.current({
    tenantId: 'workspace-one', imageId: 'phone-a', tripId: 'trip-a',
    sessionId: '22222222-2222-4222-8222-222222222222', bootId: 'boot-b',
  });
  const history = await evidence.list({ tenantId: 'workspace-one', imageId: 'phone-a', tripId: 'trip-a' });
  assert.equal(current.every((row) => row.sessionId === '22222222-2222-4222-8222-222222222222' && row.bootId === 'boot-b' && row.current), true);
  assert.ok(history.some((row) => row.sessionId === session && row.current === false));
  assert.equal((await evidence.list({ tenantId: 'workspace-two', imageId: 'phone-a', tripId: 'trip-a' })).length, 0);
  assert.equal((await evidence.list({ tenantId: 'workspace-one', imageId: 'phone-b', tripId: 'trip-a' })).length, 0);
});

test('the evidence schema refuses to record a stub result as applied', () => {
  assert.throws(() => radioEvidenceInputSchema.parse({
    tenantId: 'workspace-one', imageId: 'phone-a', tripId: 'trip-a', deviceId: 'device-a',
    sessionId: session, bootId: 'boot-a', instanceId: 'agent-a', datasetRevision: 'city:1',
    sequence: 0, simElapsedMs: 0, phase: 'MOVING', kind: 'RESULT', lifecycle: 'APPLIED',
    applied: true, uncertain: false, evidenceClass: 'STUB_NOT_APPLICATION', source: 'STUB_RECEIVER',
    detail: 'stub lied', payload: {},
  }));
});

test('delivered mode sends every tick under the bounded budget while local mode withholds moving frames', async () => {
  const token = 'radio-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const redis = fakeRedis();
  const evidence = new MemoryRadioEvidenceStore();
  const receiver = await startStubRadioReceiver({ imageId: 'phone-a', token, agentInstanceId: 'agent-a', bootId: 'boot-a' });
  try {
    await withPhysicalImageLease('phone-a', redis, async (ownership) => {
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
        ownership, transport, codec: previewRadioCodec, timeoutMs: 3500,
      });
      const runtime = openRuntime(evidence, { delivery, scheduleMode: 'DELIVERED', source: 'STUB_RECEIVER' });
      await runtime.ingest(progress(0));
      await runtime.ingest(progress(1));
      transport.close();
      assert.equal(receiver.applied.length, 2);
      assert.equal(evidence.rows.filter((row) => row.kind === 'RESULT').every((row) => row.applied === false), true);
    });
  } finally { await receiver.close(); }
});
