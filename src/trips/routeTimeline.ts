import { bearing } from "@turf/bearing";
import { destination } from "@turf/destination";
import { z } from "zod";
import { routeSegmentDistance, validateDrivingRoute, type DrivingRoute, type LatLng, type TrafficCategory } from "./routes.js";

const optionsSchema = z.object({
  timeScale: z.number().finite().min(1).max(2).default(1),
  maxSpeedMps: z.number().finite().min(1).max(40).default(31.3),
  accelerationMps2: z.number().finite().min(0.1).max(5).default(1.5),
  decelerationMps2: z.number().finite().min(0.1).max(8).default(2.5),
}).strict();
export type DrivingTimelineOptions = z.input<typeof optionsSchema>;
export interface DrivingTimelineSample extends LatLng {
  bearing: number;
  speedMps: number;
  distanceM: number;
  remainingM: number;
  progress: number;
  finished: boolean;
  stopped: boolean;
  routeIndex: number;
  trafficCategory: TrafficCategory;
  timingSource: "ESTIMATED";
}
export interface DrivingTimeline {
  durationMs: number;
  distanceM: number;
  options: z.output<typeof optionsSchema>;
  sample(elapsedMs: number): DrivingTimelineSample;
}
interface Segment {
  from: LatLng;
  to: LatLng;
  length: number;
  offset: number;
  bearing: number;
  routeIndex: number;
  estimatedSeconds: number;
}
interface Motion {
  segment: Segment;
  offset: number;
  duration: number;
  speed: number;
  acceleration: number;
}
interface Phase extends Motion {
  start: number;
  end: number;
  scale: number;
  stopped: boolean;
}

export function createRouteTimeline(value: DrivingRoute, input: DrivingTimelineOptions = {}): DrivingTimeline {
  const route = validateDrivingRoute(value);
  const parsed = optionsSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid driving timeline options.");
  const options = parsed.data;
  const segments: Segment[] = [];
  const nodeMap = [0];
  let totalDistance = 0;
  for (let i = 1; i < route.points.length; i++) {
    const from = route.points[i - 1]!;
    const to = route.points[i]!;
    const length = routeSegmentDistance(from, to);
    if (length > 0) {
      segments.push({ from, to, length, offset: totalDistance,
        bearing: (bearing([from.lng, from.lat], [to.lng, to.lat]) + 360) % 360,
        routeIndex: i - 1, estimatedSeconds: (route.segmentDurationMs?.[i - 1] ?? 0) / 1000 });
      totalDistance += length;
    }
    nodeMap.push(segments.length);
  }
  const dwellAtNode = new Map<number, number>();
  for (const stop of route.stops ?? []) {
    const node = nodeMap[stop.pointIndex]!;
    dwellAtNode.set(node, (dwellAtNode.get(node) ?? 0) + stop.durationMs / 1000);
  }

  // OSRM segment durations are estimates. Preserve their relative speeds, then enforce physical bounds.
  const estimatedSpeeds = segments.map((segment) => segment.estimatedSeconds > 0
    ? Math.max(0.01, Math.min(options.maxSpeedMps, segment.length / segment.estimatedSeconds)) : options.maxSpeedMps);
  const largestEstimate = estimatedSpeeds.reduce((largest, speed) => Math.max(largest, speed), 0);
  const caps = estimatedSpeeds.map((speed) => Math.max(0.01, Math.min(options.maxSpeedMps, options.maxSpeedMps * speed / largestEstimate)));
  const nodeSpeeds = Array<number>(segments.length + 1).fill(options.maxSpeedMps);
  nodeSpeeds[0] = 0;
  nodeSpeeds[segments.length] = 0;
  for (let node = 1; node < segments.length; node++) {
    const previous = segments[node - 1]!;
    const next = segments[node]!;
    const difference = Math.abs(previous.bearing - next.bearing);
    const angle = Math.min(difference, 360 - difference) * Math.PI / 180;
    const turnRadius = Math.min(20, previous.length, next.length) / Math.max(0.001, 2 * Math.sin(angle / 2));
    const cornerCap = angle < 0.02 ? options.maxSpeedMps : Math.sqrt(1.5 * turnRadius);
    nodeSpeeds[node] = Math.min(caps[node - 1]!, caps[node]!, cornerCap);
  }
  for (const node of dwellAtNode.keys()) nodeSpeeds[node] = 0;
  for (let i = 0; i < segments.length; i++) {
    nodeSpeeds[i + 1] = Math.min(nodeSpeeds[i + 1]!, caps[i]!, Math.sqrt(nodeSpeeds[i]! ** 2 + 2 * options.accelerationMps2 * segments[i]!.length));
  }
  for (let i = segments.length - 1; i >= 0; i--) {
    nodeSpeeds[i] = Math.min(nodeSpeeds[i]!, caps[i]!, Math.sqrt(nodeSpeeds[i + 1]! ** 2 + 2 * options.decelerationMps2 * segments[i]!.length));
  }

  const motions: Motion[][] = [];
  let fastestSeconds = 0;
  for (const [index, segment] of segments.entries()) {
    const startSpeed = nodeSpeeds[index]!;
    const endSpeed = nodeSpeeds[index + 1]!;
    const acceleration = options.accelerationMps2;
    const deceleration = options.decelerationMps2;
    const peak = Math.min(caps[index]!, Math.sqrt((2 * acceleration * deceleration * segment.length +
      deceleration * startSpeed ** 2 + acceleration * endSpeed ** 2) / (acceleration + deceleration)));
    const acceleratingDistance = Math.max(0, (peak ** 2 - startSpeed ** 2) / (2 * acceleration));
    const deceleratingDistance = Math.max(0, (peak ** 2 - endSpeed ** 2) / (2 * deceleration));
    const cruisingDistance = Math.max(0, segment.length - acceleratingDistance - deceleratingDistance);
    const parts: Motion[] = [
      { segment, offset: 0, duration: Math.max(0, (peak - startSpeed) / acceleration), speed: startSpeed, acceleration },
      { segment, offset: acceleratingDistance, duration: cruisingDistance / peak, speed: peak, acceleration: 0 },
      { segment, offset: acceleratingDistance + cruisingDistance, duration: Math.max(0, (peak - endSpeed) / deceleration), speed: peak, acceleration: -deceleration },
    ].filter((part) => part.duration > 0);
    fastestSeconds += parts.reduce((sum, part) => sum + part.duration, 0);
    motions.push(parts);
  }
  if (!Number.isFinite(fastestSeconds) || fastestSeconds <= 0) throw new Error("Invalid driving timeline geometry.");
  const drivingSeconds = Math.max(fastestSeconds, route.durationMs / 1000 / options.timeScale);
  const scale = drivingSeconds / fastestSeconds;
  const phases: Phase[] = [];
  let elapsed = 0;
  const addDwell = (node: number) => {
    const duration = dwellAtNode.get(node) ?? 0;
    if (duration <= 0) return;
    const segment = segments[Math.max(0, node - 1)]!;
    phases.push({ segment, offset: node === 0 ? 0 : segment.length, duration,
      speed: 0, acceleration: 0, start: elapsed, end: elapsed + duration, scale: 1, stopped: true });
    elapsed += duration;
  };
  addDwell(0);
  for (const [index, parts] of motions.entries()) {
    for (const part of parts) {
      const duration = part.duration * scale;
      phases.push({ ...part, start: elapsed, end: elapsed + duration, scale, stopped: false });
      elapsed += duration;
    }
    addDwell(index + 1);
  }
  const dwellSeconds = [...dwellAtNode.values()].reduce((sum, seconds) => sum + seconds, 0);
  const totalDurationMs = (drivingSeconds + dwellSeconds) * 1000;

  return {
    durationMs: totalDurationMs, distanceM: totalDistance, options: { ...options },
    sample(elapsedMs: number): DrivingTimelineSample {
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("Elapsed driving time must be finite and nonnegative.");
      const finished = elapsedMs >= totalDurationMs;
      if (finished) return { ...route.destination, bearing: segments.at(-1)!.bearing, speedMps: 0,
        distanceM: totalDistance, remainingM: 0, progress: 1, finished: true, stopped: true,
        routeIndex: segments.at(-1)!.routeIndex, trafficCategory: "UNKNOWN", timingSource: "ESTIMATED" };
      const seconds = elapsedMs / 1000;
      let low = 0;
      let high = phases.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (phases[middle]!.end <= seconds) low = middle + 1;
        else high = middle;
      }
      const phase = phases[low]!;
      const t = Math.max(0, Math.min(phase.duration, (seconds - phase.start) / phase.scale));
      const along = Math.max(0, Math.min(phase.segment.length, phase.offset + phase.speed * t + phase.acceleration * t * t / 2));
      const distanceM = Math.min(totalDistance, phase.segment.offset + along);
      let point: LatLng;
      if (along === 0) point = phase.segment.from;
      else if (along === phase.segment.length) point = phase.segment.to;
      else {
        const [lng, lat] = destination([phase.segment.from.lng, phase.segment.from.lat], along, phase.segment.bearing, { units: "meters" }).geometry.coordinates;
        point = { lat: lat!, lng: ((lng! + 180) % 360 + 360) % 360 - 180 };
      }
      return { ...point, bearing: phase.segment.bearing,
        speedMps: Math.max(0, (phase.speed + phase.acceleration * t) / phase.scale),
        distanceM, remainingM: totalDistance - distanceM, progress: distanceM / totalDistance,
        finished: false, stopped: phase.stopped, routeIndex: phase.segment.routeIndex,
        trafficCategory: "UNKNOWN", timingSource: "ESTIMATED" };
    },
  };
}
