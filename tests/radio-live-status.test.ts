import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EVIDENCE_CLAIM } from '../src/radio/policy.js';
import { LATENCY_BUDGET_MS } from '../src/radio/policy.js';
import { projectLiveRadioStatus, type LiveRadioInputs } from '../src/radio/liveStatus.js';

const nowMs = 1_779_000_006_000;

function base(extra: Partial<LiveRadioInputs> = {}): LiveRadioInputs {
  return {
    imageId: 'phone-a',
    deviceId: 'device-a',
    mcc: '310',
    mnc: '260',
    nowMs,
    trip: { id: 'trip-a', status: 'RUNNING' },
    dataset: { revision: 'city:1', recordsPresent: true },
    playerReadiness: {
      code: 'READY', ready: true, detail: 'The player answered on this phone and is idle',
      checkedAt: new Date(nowMs - 1000).toISOString(), endpoint: '10.0.0.1:5555',
    },
    verification: {
      outcome: 'CHECKED', checkedAt: new Date(nowMs - 2000).toISOString(),
      installed: { matchesUploadedApk: true, packageName: 'net.stakeout.duomove.player' },
      radios: { wifi: 'NOT_OBSERVED', cell: 'NOT_OBSERVED', bluetooth: 'NOT_OBSERVED' },
    },
    radioPluginPresent: false,
    ...extra,
  };
}

test('requested, applied and observed sequences stay on separate lanes', () => {
  const status = projectLiveRadioStatus(base({
    session: {
      sessionId: '11111111-1111-4111-8111-111111111111',
      bootId: 'boot-a',
      instanceId: 'agent-a',
      tripId: 'trip-a',
      datasetRevision: 'city:1',
      lastRequestedSequence: 12,
      lastAppliedSequence: null,
      lastObservedSequence: null,
      lastServing: '310-260-42-12345',
      lastHandover: { from: '310-260-42-11111', to: '310-260-42-12345' },
      bluetoothAction: 'HOLD',
      uncertain: false,
      lifecycle: 'VALIDATED',
      detail: 'Scheduled radio frame 12 locally',
      simElapsedMs: 12000,
      tickWallMs: nowMs - 800,
      source: 'LOCAL_PREPARE',
      applied: false,
      scanAges: [{ interface: 'wifi', ageMs: 2000, intervalMs: 30000, freshness: 'CACHED', held: false }],
    },
  }));
  assert.equal(status.requested.sequence, 12);
  assert.equal(status.applied.sequence, null);
  assert.equal(status.applied.applied, false);
  assert.equal(status.observed.sequence, null);
  assert.equal(status.observed.availability, 'NOT_OBSERVED');
  assert.notEqual(status.requested.source, status.observed.source);
  assert.match(status.scanAge[0]!.label, /model cache/i);
  assert.equal(status.display.interpolation, 'PRESENTATION_ONLY');
  assert.equal(status.display.pollIntervalMs, LATENCY_BUDGET_MS.uiSnapshotPollInterval);
});

test('a stub or local prepare never fills the applied or observed lanes', () => {
  const status = projectLiveRadioStatus(base({
    session: {
      sessionId: '11111111-1111-4111-8111-111111111111',
      bootId: 'boot-a', instanceId: 'agent-a', tripId: 'trip-a', datasetRevision: 'city:1',
      lastRequestedSequence: 4, lastAppliedSequence: 4, lastObservedSequence: 4,
      lastServing: 'cell-a', lastHandover: null, bluetoothAction: 'HOLD',
      uncertain: false, lifecycle: 'APPLIED', detail: 'Stub applied',
      simElapsedMs: 4000, tickWallMs: nowMs - 500, source: 'STUB_RECEIVER', applied: true,
      scanAges: [],
    },
  }));
  assert.equal(status.applied.applied, false);
  assert.equal(status.applied.sequence, null);
  assert.equal(status.observed.sequence, null);
  assert.equal(status.observed.availability, 'NOT_OBSERVED');
  assert.match(status.applied.detail, /not evidence of real application/i);
});

test('operator states distinguish progressing, stale, blocked, mismatched and uncertain', () => {
  const progressing = projectLiveRadioStatus(base({
    session: {
      sessionId: 's', bootId: 'b', instanceId: 'i', tripId: 'trip-a', datasetRevision: 'city:1',
      lastRequestedSequence: 2, lastAppliedSequence: null, lastObservedSequence: null,
      lastServing: null, lastHandover: null, bluetoothAction: 'HOLD', uncertain: false,
      lifecycle: 'VALIDATED', detail: 'ok', simElapsedMs: 2000, tickWallMs: nowMs - 400,
      source: 'LOCAL_PREPARE', applied: false, scanAges: [],
    },
  }));
  assert.equal(progressing.operator.code, 'PROGRESSING');

  const stale = projectLiveRadioStatus(base({
    session: {
      sessionId: 's', bootId: 'b', instanceId: 'i', tripId: 'trip-a', datasetRevision: 'city:1',
      lastRequestedSequence: 2, lastAppliedSequence: null, lastObservedSequence: null,
      lastServing: null, lastHandover: null, bluetoothAction: 'HOLD', uncertain: false,
      lifecycle: 'VALIDATED', detail: 'ok', simElapsedMs: 2000, tickWallMs: nowMs - 20_000,
      source: 'LOCAL_PREPARE', applied: false, scanAges: [],
    },
  }));
  assert.equal(stale.operator.code, 'STALE');

  const blocked = projectLiveRadioStatus(base({
    arrival: { stage: 'BLOCKED', gateReason: 'OUTSIDE_RADIUS', bluetoothIntent: 'HOLD', uncertain: false, detail: 'outside' },
    session: {
      sessionId: 's', bootId: 'b', instanceId: 'i', tripId: 'trip-a', datasetRevision: 'city:1',
      lastRequestedSequence: 2, lastAppliedSequence: null, lastObservedSequence: null,
      lastServing: null, lastHandover: null, bluetoothAction: 'HOLD', uncertain: false,
      lifecycle: 'VALIDATED', detail: 'ok', simElapsedMs: 2000, tickWallMs: nowMs - 400,
      source: 'LOCAL_PREPARE', applied: false, scanAges: [],
    },
  }));
  assert.equal(blocked.operator.code, 'BLOCKED');

  const mismatched = projectLiveRadioStatus(base({
    radioPluginPresent: true,
    comparison: { overall: 'SCOPE_LEAK', role: 'OUT_OF_SCOPE_CONTROL', claim: EVIDENCE_CLAIM.OUT_OF_SCOPE_CONTROL, scopeLimited: false },
    session: {
      sessionId: 's', bootId: 'b', instanceId: 'i', tripId: 'trip-a', datasetRevision: 'city:1',
      lastRequestedSequence: 2, lastAppliedSequence: null, lastObservedSequence: null,
      lastServing: null, lastHandover: null, bluetoothAction: 'HOLD', uncertain: false,
      lifecycle: 'VALIDATED', detail: 'ok', simElapsedMs: 2000, tickWallMs: nowMs - 400,
      source: 'PLUGIN', applied: false, scanAges: [],
    },
  }));
  assert.equal(mismatched.operator.code, 'MISMATCHED');
  assert.equal(mismatched.observed.overall, 'SCOPE_LEAK');
  assert.match(mismatched.observed.claim, /scope boundary/i);

  const uncertain = projectLiveRadioStatus(base({
    session: {
      sessionId: 's', bootId: 'b', instanceId: 'i', tripId: 'trip-a', datasetRevision: 'city:1',
      lastRequestedSequence: 2, lastAppliedSequence: null, lastObservedSequence: null,
      lastServing: null, lastHandover: null, bluetoothAction: 'HOLD', uncertain: true,
      lifecycle: 'TIMED_OUT', detail: 'lost ack', simElapsedMs: 2000, tickWallMs: nowMs - 400,
      source: 'PLUGIN', applied: false, scanAges: [],
    },
  }));
  assert.equal(uncertain.operator.code, 'UNCERTAIN');
});

test('one readiness result per phone uses the first actionable start blocker', () => {
  assert.equal(projectLiveRadioStatus(base({
    playerReadiness: { code: 'UNREACHABLE', ready: false, detail: 'The phone is powered off', checkedAt: new Date(nowMs).toISOString(), endpoint: '10.0.0.1:5555' },
  })).readiness.code, 'TRANSPORT_UNREACHABLE');

  assert.equal(projectLiveRadioStatus(base({
    verification: {
      outcome: 'CHECKED', checkedAt: new Date(nowMs).toISOString(),
      installed: { matchesUploadedApk: false, packageName: 'net.stakeout.duomove.player' },
      radios: { wifi: 'NOT_OBSERVED', cell: 'NOT_OBSERVED', bluetooth: 'NOT_OBSERVED' },
    },
  })).readiness.code, 'WRONG_BUILD');

  assert.equal(projectLiveRadioStatus(base({
    dataset: { revision: null, recordsPresent: false },
  })).readiness.code, 'DATASET_INVALID');

  assert.equal(projectLiveRadioStatus(base()).readiness.code, 'PLUGIN_MISSING');
  assert.match(projectLiveRadioStatus(base()).readiness.detail, /radio agent/i);

  assert.equal(projectLiveRadioStatus(base({
    radioPluginPresent: true,
    unsupportedInterfaces: ['cells'],
  })).readiness.code, 'INTERFACE_UNSUPPORTED');
  assert.equal(projectLiveRadioStatus(base({ radioPluginPresent: true })).readiness.code, 'READY');
});

test('Bluetooth REPLACE is shown as intent, not as observed application', () => {
  const status = projectLiveRadioStatus(base({
    arrival: { stage: 'READY', gateReason: null, bluetoothIntent: 'REPLACE', uncertain: false, detail: 'dwell complete' },
    session: {
      sessionId: 's', bootId: 'b', instanceId: 'i', tripId: 'trip-a', datasetRevision: 'city:1',
      lastRequestedSequence: 9, lastAppliedSequence: null, lastObservedSequence: null,
      lastServing: null, lastHandover: null, bluetoothAction: 'REPLACE', uncertain: false,
      lifecycle: 'REQUESTED', detail: 'arrival', simElapsedMs: 9000, tickWallMs: nowMs - 200,
      source: 'STUB_RECEIVER', applied: false, scanAges: [],
    },
  }));
  assert.equal(status.bluetooth.intent, 'REPLACE');
  assert.equal(status.bluetooth.observed, 'NOT_OBSERVED');
  assert.equal(status.carrier.servingCellObserved, 'NOT_OBSERVED');
});

test('UI markup keeps model, applied and observed values in separate rows', () => {
  const context = { module: { exports: {} as Record<string, any> } };
  vm.runInNewContext(readFileSync(new URL('../public/radio-status.js', import.meta.url), 'utf8'), context);
  const { markup } = context.module.exports;
  const html = markup(projectLiveRadioStatus(base({
    session: {
      sessionId: 's', bootId: 'b', instanceId: 'i', tripId: 'trip-a', datasetRevision: 'city:1',
      lastRequestedSequence: 3, lastAppliedSequence: null, lastObservedSequence: null,
      lastServing: 'cell-a', lastHandover: { from: null, to: 'cell-a' }, bluetoothAction: 'HOLD',
      uncertain: false, lifecycle: 'VALIDATED', detail: 'scheduled', simElapsedMs: 3000,
      tickWallMs: nowMs - 300, source: 'LOCAL_PREPARE', applied: false,
      scanAges: [{ interface: 'wifi', ageMs: 5000, intervalMs: 30000, freshness: 'CACHED', held: false }],
    },
  })));
  assert.match(html, /Last requested sequence/);
  assert.match(html, /Last applied sequence/);
  assert.match(html, /Last observed sequence/);
  assert.match(html, /NOT_OBSERVED/);
  assert.match(html, /PRESENTATION_ONLY|presentation, not new phone evidence/);
  assert.match(html, /PLUGIN_MISSING/);
  assert.doesNotMatch(html, />12</);
});
