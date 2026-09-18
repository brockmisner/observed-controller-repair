/**
 * Build the G02 acceptance route plan using the controller's own plan builder, so the bytes
 * uploaded by the harness are produced by the same code path a real trip uses.
 *
 * The route deliberately contains all four behaviours G02 requires: acceleration from rest, a
 * sharp turn, a mid-route stop with a dwell, and arrival followed by the destination dwell.
 *
 *   node --import tsx scripts/duomove-acceptance-plan.ts --origin 37.7749,-122.4194 --out plan.json
 */
import { writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { destination } from '@turf/destination';
import { buildPlayerPlan } from '../src/trips/playerPlan.js';
import type { DrivingRoute, LatLng } from '../src/trips/routes.js';
import { routeSegmentDistance } from '../src/trips/routes.js';

const STEP_M = 25;

interface Leg { bearingDeg: number; lengthM: number; stopSeconds?: number }

/** Straight legs joined at hard corners; the timeline's corner speed cap does the rest. */
const ACCEPTANCE_LEGS: Leg[] = [
  { bearingDeg: 0, lengthM: 600 },
  { bearingDeg: 90, lengthM: 400, stopSeconds: 20 },
  { bearingDeg: 90, lengthM: 300 },
];

function advance(from: LatLng, bearingDeg: number, metres: number): LatLng {
  const moved = destination([from.lng, from.lat], metres / 1000, bearingDeg, { units: 'kilometers' });
  const [lng, lat] = moved.geometry.coordinates as [number, number];
  return { lat, lng };
}

export function acceptanceRoute(origin: LatLng, legs: Leg[] = ACCEPTANCE_LEGS): DrivingRoute {
  const points: LatLng[] = [origin];
  const stops: NonNullable<DrivingRoute['stops']> = [];
  let cursor = origin;
  for (const leg of legs) {
    const steps = Math.max(1, Math.round(leg.lengthM / STEP_M));
    for (let step = 0; step < steps; step++) {
      cursor = advance(cursor, leg.bearingDeg, leg.lengthM / steps);
      points.push(cursor);
    }
    if (leg.stopSeconds) stops.push({ pointIndex: points.length - 1, durationMs: leg.stopSeconds * 1000 });
  }
  let distanceM = 0;
  for (let index = 1; index < points.length; index++) distanceM += routeSegmentDistance(points[index - 1]!, points[index]!);
  const fetchedAt = new Date();
  return {
    provider: 'OSRM',
    points,
    distanceM,
    // Synthetic geometry carries no provider timing; the timeline falls back to the speed options.
    durationMs: Math.max(1000, Math.round(distanceM / 13.4) * 1000),
    staticDurationMs: Math.max(1000, Math.round(distanceM / 13.4) * 1000),
    traffic: [{ startIndex: 0, endIndex: points.length - 1, category: 'UNKNOWN' }],
    fetchedAt: fetchedAt.toISOString(),
    expiresAt: new Date(fetchedAt.getTime() + 3_600_000).toISOString(),
    origin,
    destination: points.at(-1)!,
    description: 'DuoMove G02 acceptance route: accelerate, turn, stop, dwell',
    stops,
  };
}

/** Index ranges the cadence report uses to break lateness down per behaviour. */
export function planPhases(plan: ReturnType<typeof buildPlayerPlan>) {
  const samples = plan.samples;
  const cruiseSeq = samples.findIndex(sample => sample.speed_mps > 12);
  const stopStart = samples.findIndex((sample, index) => index > 0 && sample.phase === 'dwell');
  const stopEnd = samples.findIndex((sample, index) => index > stopStart && stopStart >= 0 && sample.phase === 'drive');
  const arrivalSeq = samples.findLastIndex(sample => sample.phase === 'drive');
  // The corner shows up as the first speed dip after reaching cruise, from the corner speed cap.
  const turnStart = samples.findIndex((sample, index) => cruiseSeq > 0 && index > cruiseSeq && sample.speed_mps < 12);
  const turnEnd = samples.findIndex((sample, index) => turnStart > 0 && index > turnStart && sample.speed_mps >= 13.4);
  const phases = [
    { name: 'acceleration', fromSeq: 0, toSeq: cruiseSeq > 0 ? cruiseSeq : 10 },
    { name: 'cruise', fromSeq: (cruiseSeq > 0 ? cruiseSeq : 10) + 1, toSeq: turnStart - 1 },
    { name: 'turn', fromSeq: turnStart, toSeq: turnEnd > 0 ? turnEnd : turnStart },
    { name: 'cruise-to-stop', fromSeq: (turnEnd > 0 ? turnEnd : turnStart) + 1, toSeq: stopStart - 1 },
    { name: 'mid-route-stop', fromSeq: stopStart, toSeq: stopEnd > 0 ? stopEnd - 1 : stopStart },
    { name: 'approach', fromSeq: stopEnd > 0 ? stopEnd : stopStart + 1, toSeq: arrivalSeq },
    { name: 'destination-dwell', fromSeq: arrivalSeq + 1, toSeq: samples.length - 1 },
  ];
  return phases.filter(phase => phase.fromSeq >= 0 && phase.toSeq >= phase.fromSeq);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = Boolean(process.argv[1]) &&
  realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const raw = arg('origin');
  const parts = (raw ?? '').split(',').map(Number);
  if (parts.length !== 2 || !parts.every(Number.isFinite)) {
    console.error('--origin <lat>,<lng> is required so the route starts where the phone already is');
    process.exit(2);
  }
  const route = acceptanceRoute({ lat: parts[0]!, lng: parts[1]! });
  const plan = buildPlayerPlan(route, { maxSpeedMps: 13.4, accelerationMps2: 1.5, decelerationMps2: 2.5 });
  const out = arg('out');
  const payload = JSON.stringify({ plan, phases: planPhases(plan), route: { distanceM: route.distanceM, destination: route.destination } });
  if (out) await writeFile(out, payload);
  else process.stdout.write(payload);
  console.error(`plan: ${plan.samples.length} samples, ${Math.round(route.distanceM)} m, ${plan.duration_ms / 1000} s`);
}
