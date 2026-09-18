import { haversineMeters } from '../geo/haversine.js';
import { driveSlotSchema, isDriveSlot, taskSchema, type DriveSlot, type ScheduleItem } from './model.js';

export const HOME_SLEEP_RADIUS_M = 80;
export const PROVIDER_GPS_MATCH_M = 10;
export const GPS_COHERENCE_M = 200;

export type LatLng = { lat: number; lng: number };
export type WarmupTripOwner = { campaignId: string; runId: string };

export function atHome(current: LatLng, home: LatLng, radiusM = HOME_SLEEP_RADIUS_M): boolean {
  return haversineMeters(current.lat, current.lng, home.lat, home.lng) <= radiusM;
}

export function gpsPreflight(input: {
  durable: LatLng;
  provider: LatLng | null;
  home: LatLng;
  movementIncomplete: boolean;
}): { action: 'MATCH' | 'ALIGN_PROVIDER' | 'NEEDS_ATTENTION'; meters?: number } {
  if (!input.provider) return { action: 'ALIGN_PROVIDER' };
  const meters = haversineMeters(input.durable.lat, input.durable.lng, input.provider.lat, input.provider.lng);
  if (meters <= PROVIDER_GPS_MATCH_M) return { action: 'MATCH', meters };
  if (meters > GPS_COHERENCE_M && input.movementIncomplete) return { action: 'NEEDS_ATTENTION', meters };
  return { action: 'ALIGN_PROVIDER', meters };
}

export function mayReleasePower(input: {
  atHome: boolean;
  activeTrip: boolean;
  busyRuns: boolean;
  upcomingWork: boolean;
  phase: string;
}): { ok: boolean; reason?: string } {
  if (!input.atHome) return { ok: false, reason: 'Durable position is not at home' };
  if (input.activeTrip) return { ok: false, reason: 'A campaign drive still owns the phone' };
  if (input.busyRuns) return { ok: false, reason: 'A campaign task is in flight' };
  if (input.upcomingWork) return { ok: false, reason: 'Work remains in today’s window' };
  if (['NAVIGATING', 'DRIVING', 'DWELL'].includes(input.phase)) return { ok: false, reason: 'Phone is still moving or dwelling' };
  return { ok: true };
}

export function movementWindowOutcome(input: { now: Date; deadlineAt: Date; tripStatus: string }):
  { action: 'CONTINUE' } | { action: 'SUSPEND_IN_PLACE'; status: 'SUSPENDED_IN_PLACE'; code: 'WINDOW_EXCEEDED' } {
  if (input.now < input.deadlineAt) return { action: 'CONTINUE' };
  if (['RUNNING', 'ARRIVING', 'PREVIEW', 'PAUSED', 'PREPARING'].includes(input.tripStatus)) {
    return { action: 'SUSPEND_IN_PLACE', status: 'SUSPENDED_IN_PLACE', code: 'WINDOW_EXCEEDED' };
  }
  return { action: 'CONTINUE' };
}

export function dependentDispatch(input: { dependsOnStatus: string | null; now: Date; deadlineAt: Date }):
  { action: 'START' | 'WAIT' | 'MISS' } {
  const status = input.dependsOnStatus;
  if (status === 'SUCCEEDED') return input.now < input.deadlineAt ? { action: 'START' } : { action: 'MISS' };
  if (!status || ['MISSED', 'SUSPENDED_IN_PLACE', 'FAILED', 'CANCELLED'].includes(status)) return { action: 'MISS' };
  return { action: 'WAIT' };
}

export function resolveDriveDestination(slot: DriveSlot, home: LatLng): LatLng {
  return slot.destination === 'HOME' ? home : slot.destination;
}

export { isDriveSlot };

export function encodeCampaignSchedule(schedule: ScheduleItem[], movement: DriveSlot[] = []): string {
  return JSON.stringify([...movement, ...schedule]);
}

export function parseScheduleItems(json: string): ScheduleItem[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error('Invalid campaign schedule');
  return raw.map((item) => {
    const kind = item && typeof item === 'object' && 'kind' in item ? (item as { kind?: string }).kind : undefined;
    return kind === 'DRIVE' ? driveSlotSchema.parse(item) : taskSchema.parse(item);
  });
}

export function warmupOwnerFromSync(phoneSyncJson: string | null | undefined): WarmupTripOwner | null {
  if (!phoneSyncJson) return null;
  try {
    const value: unknown = JSON.parse(phoneSyncJson);
    const warmup = value && typeof value === 'object' ? (value as { warmup?: unknown }).warmup : null;
    if (warmup && typeof warmup === 'object' && typeof (warmup as WarmupTripOwner).campaignId === 'string' &&
        typeof (warmup as WarmupTripOwner).runId === 'string') {
      return { campaignId: (warmup as WarmupTripOwner).campaignId, runId: (warmup as WarmupTripOwner).runId };
    }
  } catch { /* ignore malformed sync json */ }
  return null;
}

export function campaignDriveEvidence(trip: { id: string; status: string }, extra: Record<string, unknown> = {}) {
  return {
    source: 'CAMPAIGN_DRIVE',
    kind: 'MOVEMENT',
    tripId: trip.id,
    tripStatus: trip.status,
    observedApplication: false,
    stub: false,
    ...extra,
  };
}

export function expandWarmupText(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(day|city|latitude|longitude|imageId)\}\}/g, (_, key: string) => values[key] ?? '');
}
