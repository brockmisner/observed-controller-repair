import type { DrivingTrip } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db.js';
import { HttpError } from '../http/errors.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { withPlayer, usesPlayer, observePlayerPhone } from './playerConnection.js';
import { terminal, type PlayerStatus } from './playerProtocol.js';
import { PlayerPlanCache } from './playerPlan.js';
import type { TripLease } from './lease.js';
import { authorizeImageWriter, prismaImageOwnershipStore } from './imageOwnership.js';
import { playerLifecycle, type PhonePowerState } from './playerReadiness.js';
import { ensureTripMaps } from './phoneSync.js';
import { closeTripRadio, feedTripRadio } from '../radio/tripFeed.js';
const planCache = new PlayerPlanCache();
interface PlayerState {
  sessionId: string; offsetMs: number; instanceId?: string; started?: boolean;
  checkedAt?: string; status?: PlayerStatus; observedSeq?: number; phoneObservation?: Awaited<ReturnType<typeof observePlayerPhone>>;
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
  // Other deployments drive these phones over ADB without seeing this controller's lease. A live
  // session we did not open is named as such instead of being reported as our own restart.
  if (s.session_id && s.session_id !== p.sessionId && (!p.instanceId || s.instance_id === p.instanceId)) {
    throw new HttpError(409, 'Another writer owns this player session. This controller did not open it and did not replay anything.');
  }
  if (s.session_id !== p.sessionId || (p.instanceId && s.instance_id !== p.instanceId)) {
    throw new HttpError(409, 'Player restarted or session changed. No automatic replay was attempted.');
  }
}
export async function stopPlayerTrip(trip: DrivingTrip): Promise<void> {
  try {
    const p = playerState(trip);
    if (!p) return;
    const status = await withPlayer(trip.imageId, async c => {
      const current = await c.request({ op: 'status' });
      // A fresh instance with successful recovery has no active providers or session.
      if (current.state === 'IDLE' && current.session_id === '' && current.cleanup_ok) return current;
      matched(current, p);
      return terminal(current) ? current : c.request({ op: 'cancel', session_id: p.sessionId });
    }).catch(() => { throw new HttpError(409, 'Player stop could not be confirmed. Ownership is retained; retry Cancel after reconnecting. The phone lease expires without heartbeats.'); });
    if (!status.cleanup_ok || (!terminal(status) && status.state !== 'IDLE')) throw new HttpError(409, 'Player provider cleanup is unconfirmed. Ownership is retained.');
    if (status.session_id === p.sessionId) await recordProgress(trip, { ...p, status, checkedAt: new Date().toISOString() });
    else await store(trip, { ...p, status, checkedAt: new Date().toISOString() });
    playerLifecycle.release(trip.imageId, p.sessionId);
  } finally { planCache.delete(trip.id); closeTripRadio(trip.id); }
}
/** Cached provider power state. The trip start path still confirms power with the provider. */
async function lastKnownPower(deviceId: string): Promise<PhonePowerState> {
  const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { poweredOn: true, duoPlusStatus: true } });
  if (!device) return 'UNKNOWN';
  if (device.poweredOn && device.duoPlusStatus === 1) return 'ON';
  if (device.duoPlusStatus === 10 || device.duoPlusStatus === 11) return 'STARTING';
  return device.poweredOn ? 'UNKNOWN' : 'OFF';
}
export async function preparePlayerStart(trip: DrivingTrip): Promise<void> {
  if (!usesPlayer(trip.imageId)) return;
  if (config.dryRun) throw new HttpError(409, 'Player driving is disabled in dry-run mode');
  if (JSON.parse(trip.arrivalWifiJson).enabled) throw new HttpError(409, 'Disable arrival Wi-Fi for device-side playback.');
  // Physical-image scope prevents two workspace rows or a campaign reservation from driving the same phone.
  await authorizeImageWriter(trip.tenantId, trip.imageId, prismaImageOwnershipStore);
  const power = await lastKnownPower(trip.deviceId);
  let readiness = await playerLifecycle.check(trip.imageId, { power });
  // A restart is recorded on the first check; the phone may still be ready for a new session.
  if (readiness.code === 'RESTARTED') readiness = await playerLifecycle.check(trip.imageId);
  if (!readiness.ready) throw new HttpError(409, `${readiness.detail} (${readiness.code}).`);
}
async function recordProgress(trip: DrivingTrip, p: PlayerState) {
  const status = p.status!;
  const { plan } = planCache.get(trip, p);
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
  if (sample) {
    trip.elapsedMs = Math.round(sample.model_ms); trip.progressM = sample.distance_m;
    const instanceId = p.instanceId ?? p.sessionId;
    const completed = terminal(status) && status.state === 'COMPLETED';
    const phase = sample.phase === 'dwell' || completed ? 'ARRIVED' : 'MOVING';
    await feedTripRadio({
      trip, bootId: `unanchored:${instanceId}`, instanceId,
      progress: {
        position: { lat: sample.lat, lng: sample.lon },
        elapsedMs: Math.round(sample.model_ms),
        sequence: status.applied_seq,
        phase,
        wallMs: Date.now(),
      },
    });
    if (completed) {
      await feedTripRadio({
        trip, bootId: `unanchored:${instanceId}`, instanceId,
        progress: {
          position: { lat: sample.lat, lng: sample.lon },
          elapsedMs: Math.round(sample.model_ms) + 1000,
          sequence: status.applied_seq + 1,
          phase: 'CLEANUP',
          wallMs: Date.now(),
        },
      });
    }
  }
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
      playerLifecycle.authorize(trip.imageId, p.sessionId);
    }
    const player = p;
    const { bytes, sha256 } = planCache.get(trip, player);
    const status = await withPlayer(trip.imageId, async c => {
      let s = await c.request({ op: 'status' });
      if (player.instanceId && s.instance_id !== player.instanceId) throw new Error('Player restarted');
      if (!player.instanceId) { player.instanceId = s.instance_id; await store(trip, player); }
      if (!player.started) {
        await requireOwner();
        s = await c.request({ op: 'prepare', session_id: player.sessionId, size: bytes.length, sha256 });
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
    if (status.applied_seq >= 2 && status.applied_seq - (player.observedSeq ?? -100) >= 10) {
      try { player.phoneObservation = await observePlayerPhone(trip.imageId); player.observedSeq = status.applied_seq; } catch { /* Player acknowledgments remain distinct from readback. */ }
    }
    await recordProgress(trip, player);
    if (status.state === 'COMPLETED' && status.cleanup_ok) {
      await prisma.$transaction(async tx => {
        await tx.drivingTrip.update({ where: { id: trip.id }, data: { status: 'ARRIVED', arrivedAt: new Date(), finishedAt: new Date(), nextTickAt: null, pauseReason: null, error: null } });
        await tx.device.updateMany({ where: { id: trip.deviceId, activeTripId: trip.id }, data: { activeTripId: null, active: false, phase: 'STATIONARY', transitMode: null, lastSpeedMps: 0 } });
      });
      planCache.delete(trip.id);
    } else if (terminal(status)) throw new Error(`Player stopped: ${status.error || status.state}`);
    else await prisma.drivingTrip.updateMany({ where: { id: trip.id, revision: trip.revision, status: 'RUNNING' }, data: {
      nextTickAt: new Date(Date.now() + 1500), pauseReason: null, error: null,
    } });
    logger.info({ event: 'duomove_progress', tripId: trip.id, imageId: trip.imageId, state: status.state,
      appliedSeq: status.applied_seq, frameworkSeq: status.framework_observed_seq, fusedSeq: status.fused_observed_seq,
      delivery: status.delivery, mismatches: status.observer_mismatches, phoneObservation: player.phoneObservation,
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
