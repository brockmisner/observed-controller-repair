import { createRouteTimeline, type DrivingTimelineOptions } from './routeTimeline.js';
import type { DrivingRoute } from './routes.js';
import { createHash } from 'node:crypto';
export function buildPlayerPlan(route: DrivingRoute, options: DrivingTimelineOptions, offsetMs = 0, dwellSeconds = 30) {
  const timeline = createRouteTimeline(route, options);
  if (!Number.isFinite(offsetMs) || offsetMs < 0 || offsetMs > timeline.durationMs) throw new Error('Invalid playback offset');
  // On resume, ease modeled time from rest over eight seconds, preserving position/speed coupling.
  const ramp = offsetMs > 0 ? 8 : 0;
  const samples = [];
  let arrivalSeq = -1;
  for (let seq = 0; seq <= 14400; seq++) {
    const t = seq;
    const advanced = ramp && t < ramp ? t * t / (2 * ramp) : t - ramp / 2;
    const modelMs = Math.min(timeline.durationMs, offsetMs + Math.max(0, advanced) * 1000);
    const p = timeline.sample(modelMs);
    const factor = ramp ? Math.min(1, t / ramp) : 1;
    if (p.finished && arrivalSeq < 0) arrivalSeq = seq;
    samples.push({ seq, t_ms: seq * 1000, lat: p.lat, lon: p.lng,
      speed_mps: seq === 0 ? 0 : p.speedMps * factor, bearing_deg: p.bearing,
      accuracy_m: 8, altitude_m: null, distance_m: p.distanceM, model_ms: modelMs,
      phase: p.stopped ? 'dwell' : 'drive' });
    if (arrivalSeq >= 0 && seq >= arrivalSeq + dwellSeconds && seq >= 1) break;
  }
  if (arrivalSeq < 0 || samples.at(-1)!.speed_mps !== 0) throw new Error('Route exceeds player duration limit');
  return { version: 1, interval_ms: 1000, duration_ms: (samples.length - 1) * 1000,
    total_distance_m: timeline.distanceM, metadata: { synthetic: true, observer_scope: 'player_app' }, samples };
}

interface PlanIdentity {
  id: string; revision: string; routeJson: string; optionsJson: string;
}
interface PlanSession { sessionId: string; offsetMs: number }
interface CachedPlayerPlan {
  readonly plan: ReturnType<typeof buildPlayerPlan>;
  readonly bytes: Buffer;
  readonly sha256: string;
}
interface CacheEntry {
  trip: PlanIdentity; session: PlanSession; value: CachedPlayerPlan; touched: number; weight: number;
}

/** Immutable session plans, bounded by entry count and retained data size. */
export class PlayerPlanCache {
  private readonly entries = new Map<string, CacheEntry>();
  private retainedBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  constructor(options: { maxEntries?: number; maxBytes?: number; idleTtlMs?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? 4;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.idleTtlMs = options.idleTtlMs ?? 300_000;
    this.now = options.now ?? (() => performance.now());
    if (![this.maxEntries, this.maxBytes, this.idleTtlMs].every(v => Number.isSafeInteger(v) && v > 0)) {
      throw new Error('Invalid player plan cache limits');
    }
  }
  get(trip: PlanIdentity, session: PlanSession): CachedPlayerPlan {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (now < entry.touched || now - entry.touched >= this.idleTtlMs) this.delete(id);
    }
    const cached = this.entries.get(trip.id);
    if (cached && cached.trip.revision === trip.revision && cached.trip.routeJson === trip.routeJson &&
        cached.trip.optionsJson === trip.optionsJson && cached.session.sessionId === session.sessionId &&
        cached.session.offsetMs === session.offsetMs) {
      cached.touched = now;
      this.entries.delete(trip.id); this.entries.set(trip.id, cached);
      return cached.value;
    }
    this.delete(trip.id);
    const plan = buildPlayerPlan(JSON.parse(trip.routeJson), JSON.parse(trip.optionsJson), session.offsetMs);
    for (const sample of plan.samples) Object.freeze(sample);
    Object.freeze(plan.samples); Object.freeze(plan.metadata); Object.freeze(plan);
    const bytes = Buffer.from(JSON.stringify(plan));
    if (bytes.length > 8_000_000) throw new Error('Player plan exceeds upload limit');
    const value = Object.freeze({ plan, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
    // Account for encoded data, retained input strings, and sample objects in addition to the hard entry cap.
    const weight = bytes.length + 2 * (trip.routeJson.length + trip.optionsJson.length) + plan.samples.length * 256;
    if (weight <= this.maxBytes) {
      while (this.entries.size >= this.maxEntries || this.retainedBytes + weight > this.maxBytes) {
        this.delete(this.entries.keys().next().value!);
      }
      this.entries.set(trip.id, { trip: { id: trip.id, revision: trip.revision, routeJson: trip.routeJson, optionsJson: trip.optionsJson },
        session: { sessionId: session.sessionId, offsetMs: session.offsetMs }, value, weight, touched: now });
      this.retainedBytes += weight;
    }
    return value;
  }
  delete(tripId: string): void {
    const entry = this.entries.get(tripId);
    if (entry) { this.retainedBytes -= entry.weight; this.entries.delete(tripId); }
  }
}
