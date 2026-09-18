import assert from 'node:assert/strict';
import test from 'node:test';
import { cadenceReport, deriveApplications, histogram, percentile, summarize } from '../scripts/duomove-cadence-stats.mjs';
import { probeVerdicts } from '../scripts/duomove-image-probe.mjs';
import { hasV1Signature, readApkSigners } from '../scripts/duomove-apk-signer.mjs';
import { acceptanceRoute, planPhases } from '../scripts/duomove-acceptance-plan.js';
import { buildPlayerPlan } from '../src/trips/playerPlan.js';

const NANOS_PER_MS = 1e6;

/** Build a poll series where sample `n` is applied `latenessMs[n]` late on the device clock. */
function pollSeries(latenessMs: number[], options: { startNanos?: number; repeatPolls?: number } = {}) {
  const startNanos = options.startNanos ?? 1_000_000 * NANOS_PER_MS;
  const repeats = options.repeatPolls ?? 2;
  const polls: { atMs: number; rttMs: number; status: Record<string, unknown> }[] = [];
  latenessMs.forEach((lateness, seq) => {
    const scheduledMs = 500 + seq * 1000;
    const observerNanos = startNanos + (scheduledMs + lateness) * NANOS_PER_MS;
    for (let repeat = 0; repeat < repeats; repeat++) {
      polls.push({
        atMs: seq * 1000 + repeat * 120,
        rttMs: 3,
        status: {
          start_elapsed_nanos: startNanos,
          observer_elapsed_nanos: observerNanos,
          applied_seq: seq,
          framework_observed_seq: seq,
          fused_observed_seq: seq,
          skipped_samples: 0,
          max_lateness_ms: Math.round(Math.max(...latenessMs.slice(0, seq + 1))),
          observer_mismatches: 0,
          state: seq === latenessMs.length - 1 ? 'COMPLETED' : 'RUNNING',
          cleanup_ok: true,
          error: '',
          delivery: 'framework_and_fused',
          observer_scope: 'player_app',
        },
      });
    }
  });
  return polls;
}

test('percentile interpolates and handles degenerate input', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.95), 48);
});

test('summarize reports count, extremes and central values', () => {
  const result = summarize([1000, 1010, 990, 1005]);
  assert.equal(result.count, 4);
  assert.equal(result.min, 990);
  assert.equal(result.max, 1010);
  assert.equal(result.median, 1002.5);
  assert.equal(result.mean, 1001.25);
  assert.deepEqual(summarize([]), { count: 0, min: null, median: null, p95: null, max: null, mean: null });
});

test('histogram assigns values to half-open buckets and keeps a tail bucket', () => {
  const buckets = histogram([880, 995, 1000, 1005, 3000], [900, 990, 1010]);
  assert.equal(buckets.at(0)!.count, 1, 'below the first edge');
  assert.equal(buckets.at(2)!.count, 3, '990..1010 holds 995, 1000 and 1005');
  assert.equal(buckets.at(-1)!.count, 1, 'tail bucket holds the outlier');
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.count, 0), 5);
});

test('deriveApplications keeps one record per index and ignores repeated observer timestamps', () => {
  const { applications, startElapsedNanos } = deriveApplications(pollSeries([0, 10, 20], { repeatPolls: 4 }));
  assert.equal(applications.length, 3, 'three indices despite four polls each');
  assert.equal(startElapsedNanos, 1_000_000 * NANOS_PER_MS);
  assert.deepEqual(applications.map(application => application.seq), [0, 1, 2]);
});

test('cadenceReport recovers injected lateness on the device clock', () => {
  const injected = [0, 12, 4, 40, 8, 16];
  const report = cadenceReport(pollSeries(injected), { expectedSamples: injected.length });
  assert.equal(report.samplesObserved, injected.length);
  assert.deepEqual(report.unobservedSeqs, []);
  // Absolute lateness is measured against start + 500 ms + n * 1000 ms, so it returns the input.
  assert.equal(report.lateness.absoluteMs.max, 40);
  assert.equal(report.lateness.absoluteMs.median, percentile(injected, 0.5));
  assert.equal(report.lateness.absoluteMs.p95, percentile(injected, 0.95));
  assert.equal(report.lateness.deviceReportedMaxMs, 40, 'phone-reported maximum is carried through');
  // Interval between consecutive indices is 1000 ms plus the change in lateness.
  assert.equal(report.intervalMs.count, injected.length - 1);
  assert.equal(report.intervalMs.max, 1036, '1000 + (40 - 4)');
  assert.equal(report.intervalMs.min, 968, '1000 + (8 - 40)');
});

test('cadenceReport records unobserved indices instead of silently dropping them', () => {
  const polls = pollSeries([0, 5, 5, 5, 5]).filter(poll => ![2, 3].includes(Number(poll.status.framework_observed_seq)));
  const report = cadenceReport(polls, { expectedSamples: 5 });
  assert.deepEqual(report.unobservedSeqs, [2, 3]);
  assert.equal(report.samplesObserved, 3);
  // A gap must not be counted as a one-second interval.
  assert.equal(report.intervalMs.count, 1, 'only the 0->1 pair is consecutive');
});

test('cadenceReport carries the phone counters and per-phase breakdown', () => {
  const report = cadenceReport(pollSeries([0, 1, 2, 3]), {
    expectedSamples: 4,
    phases: [{ name: 'acceleration', fromSeq: 0, toSeq: 1 }, { name: 'cruise', fromSeq: 2, toSeq: 3 }],
  });
  assert.equal(report.deviceCounters.skippedSamples, 0);
  assert.equal(report.deviceCounters.observerScope, 'player_app');
  assert.equal(report.deviceCounters.delivery, 'framework_and_fused');
  assert.equal(report.deviceCounters.cleanupOk, true);
  assert.deepEqual(report.phaseBreakdown.map(phase => phase.name), ['acceleration', 'cruise']);
  assert.equal(report.phaseBreakdown[0]!.samplesObserved, 2);
  assert.equal(report.clockDomain.includes('device boot-relative'), true);
});

test('probeVerdicts reports no modem and no adapter when the image reports nothing', () => {
  const verdicts = probeVerdicts({
    'cell.operatorNumeric': { output: '', ok: true },
    'cell.simState': { output: 'ABSENT', ok: true },
    'cell.telephonyRegistry': { output: '', ok: true },
    'cell.serviceCheck': { output: 'Service phone: not found', ok: true },
    'bluetooth.serviceCheck': { output: 'Service bluetooth: not found', ok: true },
    'bluetooth.enabled': { output: '0', ok: true },
    'bluetooth.manager': { output: '', ok: true },
    'wifi.scanThrottle': { output: 'null', ok: true },
    'plugin.dplusDump': { output: '/system/bin/sh: dplus: inaccessible or not found', ok: false },
    'plugin.packages': { output: 'package:com.android.settings', ok: true },
  });
  assert.equal(verdicts.modemPresent, 'NO_EVIDENCE');
  assert.equal(verdicts.bluetoothAdapterPresent, 'NO_EVIDENCE');
  assert.equal(verdicts.wifiScanThrottle, 'UNSET_PLATFORM_DEFAULT_APPLIES');
  assert.equal(verdicts.dplusFrameworkPresent, 'NO_EVIDENCE');
  assert.equal(verdicts.playerPackageListed, 'NOT_LISTED');
});

test('probeVerdicts reports hardware and a disabled throttle when the image does report them', () => {
  const verdicts = probeVerdicts({
    'cell.operatorNumeric': { output: '310260', ok: true },
    'cell.simState': { output: 'READY', ok: true },
    'cell.telephonyRegistry': { output: 'mServiceState=1 mSignalStrength=...', ok: true },
    'cell.serviceCheck': { output: 'Service phone: [com.android.internal.telephony.ITelephony]', ok: true },
    'bluetooth.serviceCheck': { output: 'Service bluetooth: [android.bluetooth.IBluetooth]', ok: true },
    'bluetooth.enabled': { output: '1', ok: true },
    'bluetooth.manager': { output: 'enabled: true', ok: true },
    'wifi.scanThrottle': { output: '0', ok: true },
    'plugin.dplusDump': { output: 'module: duomove-radio package: net.stakeout.radio', ok: true },
    'plugin.packages': { output: 'package:net.stakeout.duomove.player', ok: true },
    'platform.release': { output: '13', ok: true },
    'platform.sdk': { output: '33', ok: true },
  });
  assert.equal(verdicts.modemPresent, 'EVIDENCE_FOUND');
  assert.equal(verdicts.modemEvidence.includes('gsm.operator.numeric=310260'), true);
  assert.equal(verdicts.bluetoothAdapterPresent, 'EVIDENCE_FOUND');
  assert.equal(verdicts.wifiScanThrottle, 'DISABLED');
  assert.equal(verdicts.dplusFrameworkPresent, 'EVIDENCE_FOUND');
  assert.equal(verdicts.playerPackageListed, 'YES');
  assert.equal(verdicts.androidSdk, '33');
});

test('probeVerdicts distinguishes an explicitly enabled throttle from an unset one', () => {
  assert.equal(probeVerdicts({ 'wifi.scanThrottle': { output: '1', ok: true } }).wifiScanThrottle, 'ENABLED');
  assert.equal(probeVerdicts({ 'wifi.scanThrottle': { output: '2', ok: true } }).wifiScanThrottle, 'UNEXPECTED:2');
});

test('the acceptance route contains acceleration, a turn, a mid-route stop and a dwell', () => {
  const route = acceptanceRoute({ lat: 37.7749, lng: -122.4194 });
  assert.equal(route.provider, 'OSRM');
  assert.equal(route.stops!.length, 1, 'one mid-route stop');
  const plan = buildPlayerPlan(route, { maxSpeedMps: 13.4, accelerationMps2: 1.5, decelerationMps2: 2.5 });
  assert.equal(plan.interval_ms, 1000);
  assert.equal(plan.samples[0]!.speed_mps, 0, 'starts from rest');
  assert.equal(plan.samples.at(-1)!.speed_mps, 0, 'ends stopped');
  assert.equal(plan.samples.some(sample => sample.speed_mps > 13), true, 'reaches cruise');
  assert.equal(plan.samples.some(sample => sample.bearing_deg > 45), true, 'turns');
  // A dwell sample with a non-zero speed is rejected by the player as moving_dwell.
  for (const sample of plan.samples) {
    if (sample.phase === 'dwell') assert.equal(sample.speed_mps, 0, `dwell sample ${sample.seq} must be stationary`);
    assert.ok(sample.lat >= -85 && sample.lat <= 85, 'player validates latitude to +/-85');
    assert.ok(sample.accuracy_m >= 0.1 && sample.accuracy_m <= 1000);
  }
  const phases = planPhases(plan);
  assert.deepEqual(phases.map(phase => phase.name),
    ['acceleration', 'cruise', 'turn', 'cruise-to-stop', 'mid-route-stop', 'approach', 'destination-dwell']);
  for (const phase of phases) assert.ok(phase.toSeq >= phase.fromSeq, `${phase.name} range is ordered`);
});

test('the acceptance plan stays inside the player upload limits', () => {
  const plan = buildPlayerPlan(acceptanceRoute({ lat: 51.5074, lng: -0.1278 }), { maxSpeedMps: 13.4 });
  const bytes = Buffer.from(JSON.stringify(plan));
  assert.ok(bytes.length < 8_000_000, 'under the 8 MB prepare ceiling');
  assert.ok(plan.samples.length <= 14_401, 'under the player sample ceiling');
});

test('the APK signer reader rejects input that is not a zip', () => {
  assert.throws(() => readApkSigners(Buffer.alloc(64)), /end-of-central-directory/);
});

test('hasV1Signature detects JAR signature entries', () => {
  assert.equal(hasV1Signature(Buffer.from('...META-INF/CERT.RSA...', 'latin1')), true);
  assert.equal(hasV1Signature(Buffer.from('...classes.dex...AndroidManifest.xml...', 'latin1')), false);
});
