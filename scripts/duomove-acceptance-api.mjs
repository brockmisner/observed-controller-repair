#!/usr/bin/env node
// Primary route for the G02 acceptance run: drive the phone through the deployed controller's
// own API, so the ADB leg happens from the service egress the provider already accepts.
//
// The controller refreshes its player record roughly every 1.5 s (playerRunner sets nextTickAt to
// now + 1500), and each refresh carries the phone's own `start_elapsed_nanos` and
// `observer_elapsed_nanos`. Those are device boot-relative, so per-sample lateness is still
// measured on the phone's clock — the 1.5 s supervision interval limits how many sample indices
// get caught, not the precision of the ones that are.
//
//   node scripts/duomove-acceptance-api.mjs \
//     --base-url https://observatory-controller-production.up.railway.app \
//     --trip-token-file token.txt --image-id <DUOMOVE_IMAGE_ID> --dest 37.42,-122.08
//
//   node scripts/duomove-acceptance-api.mjs --base-url ... --email me@example.com \
//     --password-file pw.txt --image-id <id> --dest 37.42,-122.08 --stop 37.41,-122.09:20
//
// A trip token can only use POST /api/trips/trigger, which has no waypoint field, so it cannot
// express a mid-route stop. A workspace login can, via POST /api/trips waypoints[].stopSeconds.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cadenceReport } from './duomove-cadence-stats.mjs';

const argv = process.argv.slice(2);
const value = name => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const flag = name => argv.includes(`--${name}`);
const log = (...parts) => console.error(`[${new Date().toISOString()}]`, ...parts);

function coordinate(raw, label) {
  const parts = (raw ?? '').split(',').map(Number);
  if (parts.length !== 2 || !parts.every(Number.isFinite)) throw new Error(`--${label} must be <lat>,<lng>`);
  return { lat: parts[0], lng: parts[1] };
}

class Controller {
  constructor(baseUrl) { this.baseUrl = baseUrl.replace(/\/$/, ''); this.cookie = null; this.bearer = null; }

  async call(method, path, { body, idempotencyKey } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.bearer) headers.Authorization = `Bearer ${this.bearer}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const startedAt = performance.now();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const rttMs = performance.now() - startedAt;
    const setCookie = response.headers.get('set-cookie');
    if (setCookie?.includes('obs_session=')) this.cookie = setCookie.split(';')[0];
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 400) }; }
    if (!response.ok) {
      const error = new Error(`${method} ${path} -> HTTP ${response.status}: ${payload?.error ?? text.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    return { payload, rttMs, status: response.status };
  }

  async login(email, password) {
    await this.call('POST', '/auth/login', { body: { email, password } });
    const me = await this.call('GET', '/auth/me');
    log(`signed in as ${me.payload.user.email} in workspace ${me.payload.user.tenantName}`);
    return me.payload.user;
  }
}

/** One record per controller refresh, shaped for the shared cadence statistics. */
function pollsFromSamples(samples) {
  return samples.map(sample => ({ atMs: sample.atMs, rttMs: sample.rttMs, status: sample.status }));
}

/** Anything suggesting a second writer touched this phone during the run. */
function competingWriterSignals(samples, trips) {
  const signals = [];
  let lastInstance = null;
  let lastSession = null;
  let lastApplied = -Infinity;
  for (const sample of samples) {
    const status = sample.status ?? {};
    if (status.instance_id && lastInstance && status.instance_id !== lastInstance) {
      signals.push({ atMs: sample.atMs, kind: 'PLAYER_INSTANCE_CHANGED', detail: `${lastInstance} -> ${status.instance_id}` });
    }
    if (status.session_id && lastSession && status.session_id !== lastSession) {
      signals.push({ atMs: sample.atMs, kind: 'PLAYER_SESSION_CHANGED', detail: `${lastSession} -> ${status.session_id}` });
    }
    if (Number.isInteger(status.applied_seq) && status.applied_seq < lastApplied) {
      signals.push({ atMs: sample.atMs, kind: 'APPLIED_SEQ_WENT_BACKWARDS', detail: `${lastApplied} -> ${status.applied_seq}` });
    }
    if (status.instance_id) lastInstance = status.instance_id;
    if (status.session_id) lastSession = status.session_id;
    if (Number.isInteger(status.applied_seq)) lastApplied = status.applied_seq;
  }
  for (const trip of trips) {
    if (trip.pauseReason) signals.push({ kind: 'TRIP_PAUSED', detail: trip.pauseReason });
    if (trip.error) signals.push({ kind: 'TRIP_ERROR', detail: trip.error });
  }
  return signals;
}

async function main() {
  const baseUrl = value('base-url') ?? 'https://observatory-controller-production.up.railway.app';
  const imageId = value('image-id');
  const pollMs = Number(value('poll-ms') ?? 500);
  const out = value('out') ?? `./duomove-api-acceptance-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const controller = new Controller(baseUrl);

  const evidence = {
    startedAt: new Date().toISOString(),
    harness: 'scripts/duomove-acceptance-api.mjs',
    baseUrl: controller.baseUrl,
    route: 'DEPLOYED_CONTROLLER_API',
    imageId: imageId ?? null,
    outcome: 'INCOMPLETE',
  };
  try {
    evidence.hostEgress = (await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(5000) }).then(r => r.text())).trim();
  } catch { evidence.hostEgress = null; }

  const samples = [];
  const tripSnapshots = [];
  try {
    if (!imageId) throw new Error('--image-id is required and must equal the deployment\'s DUOMOVE_IMAGE_ID');
    evidence.health = (await controller.call('GET', '/health')).payload;

    const tokenFile = value('trip-token-file');
    const email = value('email');
    let sessionMode;
    if (tokenFile) {
      controller.bearer = (await readFile(tokenFile, 'utf8')).trim();
      sessionMode = 'TRIP_TOKEN';
    } else if (email) {
      const passwordFile = value('password-file');
      if (!passwordFile) throw new Error('--email needs --password-file; the password is never passed on the command line');
      await controller.login(email, (await readFile(passwordFile, 'utf8')).trim());
      sessionMode = 'WORKSPACE_SESSION';
    } else {
      throw new Error('Supply either --trip-token-file (device-scoped) or --email with --password-file');
    }
    evidence.authMode = sessionMode;

    // G01 over the API: the controller's own verification endpoint, session-only.
    if (sessionMode === 'WORKSPACE_SESSION' && !flag('skip-verify')) {
      try {
        const verify = await controller.call('POST', `/devices/${encodeURIComponent(imageId)}/player/verify`, { body: {} });
        evidence.playerVerification = verify.payload;
        log(`player verify: matchesUploadedApk=${verify.payload?.installed?.matchesUploadedApk}`);
      } catch (error) { evidence.playerVerificationError = error.message; }
    }

    const destination = coordinate(value('dest'), 'dest');
    const timeScale = value('time-scale') ? Number(value('time-scale')) : 1;
    const options = { timeScale, maxSpeedMps: 13.4, accelerationMps2: 1.5, decelerationMps2: 2.5 };

    let trip;
    if (sessionMode === 'WORKSPACE_SESSION') {
      // Only this path can express a mid-route stop, which is what G02's "a stop and a dwell" needs.
      const stops = argv.reduce((list, entry, index) => {
        if (entry !== '--stop') return list;
        const [point, seconds] = (argv[index + 1] ?? '').split(':');
        const { lat, lng } = coordinate(point, 'stop');
        list.push({ lat, lng, stopSeconds: Number(seconds ?? 20) });
        return list;
      }, []);
      const created = await controller.call('POST', '/api/trips', {
        body: { imageId, destination, options, arrivalWifi: false, openMaps: false, ...(stops.length ? { waypoints: stops } : {}) },
      });
      trip = created.payload.trip;
      evidence.plan = { waypoints: stops, routeDistanceM: trip.route?.distanceM ?? null, totalDurationMs: trip.totalDurationMs ?? null };
      log(`trip ${trip.id} prepared in ${trip.status}; route ${Math.round(trip.route?.distanceM ?? 0)} m`);
      if (trip.status === 'PREVIEW') {
        trip = (await controller.call('POST', `/api/trips/${trip.id}/start`, { body: { revision: trip.revision } })).payload.trip;
      }
    } else {
      const triggered = await controller.call('POST', '/api/trips/trigger', {
        body: { image_id: imageId, dest_lat: destination.lat, dest_lng: destination.lng, options, open_maps: false },
        idempotencyKey: randomUUID(),
      });
      trip = triggered.payload.trip;
      evidence.plan = { waypoints: [], routeDistanceM: trip.route?.distanceM ?? null, totalDurationMs: trip.totalDurationMs ?? null };
      evidence.midRouteStopLimitation =
        'A trip token can only call POST /api/trips/trigger, whose schema has no waypoints field, '
        + 'so this run has acceleration, road turns and the destination dwell but no mid-route stop. '
        + 'A workspace session is required for the explicit stop G02 asks for.';
    }
    evidence.tripId = trip.id;
    evidence.playbackMode = trip.playbackMode;
    if (trip.playbackMode !== 'DEVICE_PLAYER') {
      evidence.playbackModeWarning =
        `The controller reports playbackMode=${trip.playbackMode}. Device-player playback only `
        + 'engages for the image named by DUOMOVE_IMAGE_ID; any other image runs REST checkpoints, '
        + 'whose cadence is a controller property and not the 1 Hz on-device clock G02 measures.';
    }

    const startedAtMs = performance.now();
    const budgetMs = (trip.totalDurationMs ?? 300_000) + 180_000;
    let lastObserverNanos = null;
    let terminal = null;
    log(`polling /api/trips/${trip.id} every ${pollMs} ms (controller itself refreshes about every 1500 ms)`);
    while (performance.now() - startedAtMs < budgetMs) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      let current;
      try { current = await controller.call('GET', `/api/trips/${trip.id}`); }
      catch (error) { log(`poll failed: ${error.message}`); continue; }
      const snapshot = current.payload.trip;
      tripSnapshots.push({
        atMs: performance.now(), status: snapshot.status, elapsedMs: snapshot.elapsedMs, progressM: snapshot.progressM,
        acceptedLat: snapshot.acceptedLat, acceptedLng: snapshot.acceptedLng,
        pauseReason: snapshot.pauseReason, error: snapshot.error,
        androidObservation: snapshot.androidObservation ?? null,
      });
      const player = snapshot.phoneSync?.player;
      const status = player?.status;
      if (status && status.observer_elapsed_nanos !== lastObserverNanos) {
        lastObserverNanos = status.observer_elapsed_nanos;
        samples.push({ atMs: performance.now(), rttMs: current.rttMs, checkedAt: player.checkedAt, status });
      }
      if (['ARRIVED', 'CANCELLED', 'FAILED', 'PAUSED'].includes(snapshot.status)) { terminal = snapshot; break; }
    }
    evidence.finalTripStatus = terminal?.status ?? tripSnapshots.at(-1)?.status ?? null;
    evidence.outcome = evidence.finalTripStatus === 'ARRIVED' ? 'DRIVE_COMPLETED' : `DRIVE_${evidence.finalTripStatus ?? 'UNRESOLVED'}`;
  } catch (error) {
    evidence.outcome = 'FAILED';
    evidence.failure = error.message;
    log(`FAILED: ${error.message}`);
  }

  evidence.controllerRefreshIntervalMs = 1500;
  evidence.samplesCollected = samples.length;
  evidence.cadence = samples.length
    ? cadenceReport(pollsFromSamples(samples), { plannedIntervalMs: 1000, startDelayMs: 500 })
    : null;
  if (evidence.cadence) {
    evidence.cadence.coverageCaveat =
      'Index coverage is bounded by the controller\'s roughly 1.5 s supervision interval against a '
      + '1 Hz plan, so about a third of sample indices are never seen and the interval series only '
      + 'includes pairs where two refreshes happened to catch adjacent indices. Lateness values '
      + 'themselves come from the phone\'s own boot-relative clock and are not degraded by the poll '
      + 'rate. Run scripts/duomove-acceptance.mjs inside the controller container for near-complete '
      + 'coverage.';
  }
  evidence.competingWriterSignals = competingWriterSignals(samples, tripSnapshots);
  evidence.competingWriterNote =
    'stakeout-warmup/warmup-worker and stakeout-stations/duomove reach phones over ADB independently '
    + 'of this controller and share no ownership with it. An instance or session change, or an '
    + 'applied sequence moving backwards, would indicate a second writer and invalidate these numbers.';
  evidence.tripSnapshots = tripSnapshots;
  evidence.playerSamples = samples;
  evidence.finishedAt = new Date().toISOString();

  await mkdir(out, { recursive: true });
  await writeFile(`${out}/evidence.json`, JSON.stringify(evidence, null, 2));
  log(`wrote ${out}/evidence.json`);
  console.log(JSON.stringify({
    outcome: evidence.outcome,
    tripId: evidence.tripId ?? null,
    failure: evidence.failure ?? null,
    samples: evidence.samplesCollected,
    competingWriterSignals: evidence.competingWriterSignals.length,
    cadence: evidence.cadence && {
      samplesObserved: evidence.cadence.samplesObserved,
      intervalMs: evidence.cadence.intervalMs,
      latenessMs: evidence.cadence.lateness,
      deviceCounters: evidence.cadence.deviceCounters,
    },
  }, null, 2));
  process.exitCode = evidence.outcome === 'FAILED' ? 1 : 0;
}

await main();
