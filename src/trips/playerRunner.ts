import type { DrivingTrip } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '../db.js';
import { HttpError } from '../http/errors.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { withPlayer, usesPlayer } from './playerConnection.js';
import { terminal, type PlayerStatus } from './playerProtocol.js';
import { buildPlayerPlan } from './playerPlan.js';
import type { TripLease } from './lease.js';
import { ensureTripMaps } from './phoneSync.js';
interface PlayerState {
  sessionId: string; offsetMs: number; instanceId?: string; started?: boolean;
  checkedAt?: string; status?: PlayerStatus;
}
export function playerState(trip: DrivingTrip): PlayerState | undefined {
  return JSON.parse(trip.phoneSyncJson || '{}').player;
}
async function store(trip: DrivingTrip, player: PlayerState) {
  const sync = JSON.parse(trip.phoneSyncJson || '{}');
  sync.player = player;
  const saved = await prisma.drivingTrip.updateMany({ where: { id: trip.id, revision: trip.revision }, data: { phoneSyncJson: JSON.stringify(sync) } });
  if (saved.count !== 1) throw new HttpError(409, 'Trip changed while checking the player');
  trip.phoneSyncJson = JSON.stringify(sync);
}
function matched(s: PlayerStatus, p: PlayerState) {
  if (s.session_id !== p.sessionId || (p.instanceId && s.instance_id !== p.instanceId)) {
    throw new HttpError(409, 'Player restarted or session changed. No automatic replay was attempted.');
  }
}
export async function stopPlayerTrip(trip: DrivingTrip): Promise<void> {
  const p = playerState(trip);
  if (!p) return;
  const status = await withPlayer(async c => {
    const current = await c.request({ op: 'status' });
    // A fresh instance with successful recovery has no active providers or session.
    if (current.state === 'IDLE' && current.session_id === '' && current.cleanup_ok) return current;
    matched(current, p);
    return terminal(current) ? current : c.request({ op: 'cancel', session_id: p.sessionId });
  }).catch(() => { throw new HttpError(409, 'Player stop could not be confirmed. Ownership is retained; retry Cancel after reconnecting. The phone lease expires without heartbeats.'); });
  if (!status.cleanup_ok || (!terminal(status) && status.state !== 'IDLE')) throw new HttpError(409, 'Player provider cleanup is unconfirmed. Ownership is retained.');
  if (status.session_id === p.sessionId) await recordProgress(trip, { ...p, status, checkedAt: new Date().toISOString() });
  else await store(trip, { ...p, status, checkedAt: new Date().toISOString() });
}
export async function preparePlayerStart(trip: DrivingTrip): Promise<void> {
  if (!usesPlayer(trip.imageId)) return;
  if (config.dryRun) throw new HttpError(409, 'Player driving is disabled in dry-run mode');
  if (JSON.parse(trip.arrivalWifiJson).enabled) throw new HttpError(409, 'Disable arrival Wi-Fi for device-side playback.');
  // Physical-image scope prevents two workspace rows from driving the same phone.
  if (await prisma.device.count({ where: { imageId: trip.imageId, id: { not: trip.deviceId }, activeTripId: { not: null } } })) {
    throw new HttpError(409, 'Another workspace trip owns this physical phone. Cancel it first.');
  }
  const status = await withPlayer(c => c.request({ op: 'status' })).catch(() => { throw new HttpError(409, 'DuoMove Player is unreachable. Open the app on the phone and check ADB.'); });
  if (!status.cleanup_ok || !(status.state === 'IDLE' || terminal(status))) throw new HttpError(409, 'DuoMove Player already has a session or needs provider cleanup.');
}
async function recordProgress(trip: DrivingTrip, p: PlayerState) {
  const status = p.status!;
  const plan = buildPlayerPlan(JSON.parse(trip.routeJson), JSON.parse(trip.optionsJson), p.offsetMs);
  if (status.applied_seq < -1 || status.applied_seq >= plan.samples.length) throw new Error('Invalid player sequence');
  const sample = plan.samples[status.applied_seq];
  const sync = { ...JSON.parse(trip.phoneSyncJson || '{}'), player: p };
  await prisma.$transaction(async tx => {
    const result = await tx.drivingTrip.updateMany({ where: { id: trip.id, revision: trip.revision }, data: {
      phoneSyncJson: JSON.stringify(sync), ...(sample ? { elapsedMs: Math.round(sample.model_ms), progressM: sample.distance_m,
        acceptedLat: sample.lat, acceptedLng: sample.lon, lastStepAt: new Date() } : {}),
    } });
    if (result.count !== 1) throw new Error('Trip changed');
    if (sample) await tx.device.updateMany({ where: { id: trip.deviceId, activeTripId: trip.id }, data: {
      currentLat: sample.lat, currentLng: sample.lon, lastSpeedMps: terminal(status) ? 0 : sample.speed_mps,
      lastBearing: sample.bearing_deg, lastAccuracyM: sample.accuracy_m, lastTickAt: new Date(), routeProgressM: sample.distance_m,
    } });
  });
  trip.phoneSyncJson = JSON.stringify(sync);
  if (sample) { trip.elapsedMs = Math.round(sample.model_ms); trip.progressM = sample.distance_m; }
}
export async function stepPlayerTrip(trip: DrivingTrip, lease: TripLease): Promise<void> {
  const requireOwner = async () => {
    await lease.assertOwned();
    if (!await prisma.drivingTrip.count({ where: { id: trip.id, revision: trip.revision, status: 'RUNNING',
      device: { activeTripId: trip.id, active: true, campaignEnd: { gt: new Date() } } } })) throw new Error('Trip ownership changed');
  };
  try {
    await requireOwner();
    let p = playerState(trip);
    if (!p || p.status && terminal(p.status) && p.status.cleanup_ok) {
      // A stopped trip may resume only through the explicit service action, which clears player state.
      if (p) throw new Error('Player session ended');
      await ensureTripMaps(trip, JSON.parse(trip.routeJson).destination, requireOwner);
      p = { sessionId: randomUUID(), offsetMs: trip.elapsedMs };
      await store(trip, p); // Persist identity BEFORE sending any command.
    }
    const player = p;
    const plan = buildPlayerPlan(JSON.parse(trip.routeJson), JSON.parse(trip.optionsJson), player.offsetMs);
    const bytes = Buffer.from(JSON.stringify(plan));
    if (bytes.length > 8_000_000) throw new Error('Player plan exceeds upload limit');
    const status = await withPlayer(async c => {
      let s = await c.request({ op: 'status' });
      if (player.instanceId && s.instance_id !== player.instanceId) throw new Error('Player restarted');
      if (!player.instanceId) { player.instanceId = s.instance_id; await store(trip, player); }
      if (!player.started) {
        await requireOwner();
        s = await c.request({ op: 'prepare', session_id: player.sessionId, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        matched(s, player);
        if (s.state === 'UPLOADING') {
          for (let offset = s.received_bytes; offset < bytes.length; offset += 48000) {
            if (!Number.isInteger(offset) || offset < 0 || offset > bytes.length) throw new Error('Invalid upload offset');
            await requireOwner();
            const chunk = bytes.subarray(offset, offset + 48000);
            s = await c.request({ op: 'append', session_id: player.sessionId, offset, data: chunk.toString('base64') });
            if (s.received_bytes !== offset + chunk.length) throw new Error('Player upload acknowledgment mismatch');
          }
          s = await c.request({ op: 'commit', session_id: player.sessionId });
        }
        if (s.state === 'READY') {
          await requireOwner();
          player.started = true; await store(trip, player);
          s = await c.request({ op: 'start', session_id: player.sessionId });
        }
      } else {
        matched(s, player);
        await requireOwner();
        s = await c.request({ op: 'heartbeat', session_id: player.sessionId });
      }
      matched(s, player); return s;
    });
    player.status = status; player.checkedAt = new Date().toISOString();
    await recordProgress(trip, player);
    if (status.state === 'COMPLETED' && status.cleanup_ok) {
      await prisma.$transaction(async tx => {
        await tx.drivingTrip.update({ where: { id: trip.id }, data: { status: 'ARRIVED', arrivedAt: new Date(), finishedAt: new Date(), nextTickAt: null, pauseReason: null, error: null } });
        await tx.device.updateMany({ where: { id: trip.deviceId, activeTripId: trip.id }, data: { activeTripId: null, active: false, phase: 'STATIONARY', transitMode: null, lastSpeedMps: 0 } });
      });
    } else if (terminal(status)) throw new Error(`Player stopped: ${status.error || status.state}`);
    else await prisma.drivingTrip.updateMany({ where: { id: trip.id, revision: trip.revision, status: 'RUNNING' }, data: {
      nextTickAt: new Date(Date.now() + 1500), pauseReason: null, error: null,
    } });
    logger.info({ event: 'duomove_progress', tripId: trip.id, imageId: trip.imageId, state: status.state,
      appliedSeq: status.applied_seq, frameworkSeq: status.framework_observed_seq, fusedSeq: status.fused_observed_seq,
      skipped: status.skipped_samples, latenessMs: status.max_lateness_ms, cleanupOk: status.cleanup_ok }, 'Player acknowledgment');
  } catch (error) {
    // No further heartbeats after failure. Cancel if reachable; retain ownership either way.
    let cleanup = false;
    try { await stopPlayerTrip(trip); cleanup = true; } catch { /* 15-second device lease remains the fallback. */ }
    const reason = cleanup ? 'Player stopped. Review the phone and Resume explicitly.' : 'Player connection lost. Stop is unconfirmed; ownership retained. Retry Cancel after reconnecting.';
    await prisma.drivingTrip.updateMany({ where: { id: trip.id, revision: trip.revision, status: 'RUNNING' }, data: {
      status: 'PAUSED', nextTickAt: null, lastStepAt: null, pauseReason: reason, error: reason,
    } });
    await prisma.device.updateMany({ where: { id: trip.deviceId, activeTripId: trip.id }, data: { active: false } });
    logger.warn({ event: 'duomove_failure', tripId: trip.id, reason: error instanceof Error ? error.message : 'Player failed', cleanup }, 'Player trip paused');
  }
}
