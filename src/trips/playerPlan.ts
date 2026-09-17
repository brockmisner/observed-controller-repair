import { createRouteTimeline, type DrivingTimelineOptions } from './routeTimeline.js';
import type { DrivingRoute } from './routes.js';
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
