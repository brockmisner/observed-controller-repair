import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { PrismaRadioEvidenceStore } from './evidenceStore.js';
import { injectionScopeFingerprint, tripRadios, type GpsRadioProgress } from './runtime.js';
import { radioScheduleMode } from './scheduling.js';
import { destinationPolicy } from './destinationPolicy.js';
import { tripArrivals, type ArrivalLifecycleTick, type IdentifiedGpsFix } from './lifecycle.js';
import type { RadioDeliveryAdapter } from '../trips/radioDelivery.js';
import type { DrivingTrip } from '@prisma/client';

const evidence = new PrismaRadioEvidenceStore();

export interface RadioDataset {
  records: unknown;
  datasetRevision: string;
  mcc: string;
  mnc: string;
}

export async function radioDatasetForTrip(trip: Pick<DrivingTrip, 'tenantId' | 'deviceId' | 'imageId'>): Promise<RadioDataset | null> {
  const device = await prisma.device.findFirst({
    where: { id: trip.deviceId, tenantId: trip.tenantId, imageId: trip.imageId },
    select: { mcc: true, mnc: true },
  });
  if (!device || !/^\d{3}$/.test(device.mcc) || !/^\d{2,3}$/.test(device.mnc)) return null;
  const campaign = await prisma.warmupCampaign.findFirst({
    where: { tenantId: trip.tenantId, deviceId: trip.deviceId, imageId: trip.imageId },
    include: { city: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!campaign) return null;
  return {
    records: JSON.parse(campaign.city.recordsJson),
    datasetRevision: `${campaign.city.id}:${campaign.city.revision}`,
    mcc: device.mcc,
    mnc: device.mnc,
  };
}

function destinationOf(trip: Pick<DrivingTrip, 'routeJson'>): { lat: number; lng: number } {
  const route = JSON.parse(trip.routeJson) as { destination?: { lat: number; lng: number } };
  if (!route.destination) throw new Error('Trip route is missing a destination');
  return route.destination;
}

export async function feedIdentifiedTripGps(options: {
  trip: Pick<DrivingTrip, 'id' | 'tenantId' | 'deviceId' | 'imageId' | 'routeJson'>;
  fix: IdentifiedGpsFix & { instanceId: string };
  playerGpsCleaned?: boolean;
  dataset?: RadioDataset | null;
  delivery?: RadioDeliveryAdapter;
  packages?: readonly string[];
}): Promise<ArrivalLifecycleTick | null> {
  try {
    const device = await prisma.device.findFirst({
      where: { id: options.trip.deviceId, tenantId: options.trip.tenantId },
      select: { anchorLat: true, anchorLng: true },
    });
    const destination = destinationOf(options.trip);
    const anchor = device ? { lat: device.anchorLat, lng: device.anchorLng } : destination;
    const dataset = options.dataset === undefined ? await radioDatasetForTrip(options.trip) : options.dataset;
    const packages = options.packages ?? ['net.stakeout.duomove.player'];
    const fingerprint = injectionScopeFingerprint(packages);
    const existing = tripArrivals.get(options.trip.id);
    if (existing && (existing.bootId !== options.fix.bootId || (tripRadios.get(options.trip.id)?.sessionId && tripRadios.get(options.trip.id)!.sessionId !== existing.sessionId))) {
      await existing.continuityBreak('New radio session or boot; previous arrival frames are obsolete', options.fix.wallMs);
      tripArrivals.close(options.trip.id);
    }
    const runtime = dataset ? tripRadios.open({
      records: dataset.records,
      tenantId: options.trip.tenantId,
      imageId: options.trip.imageId,
      tripId: options.trip.id,
      deviceId: options.trip.deviceId,
      datasetRevision: dataset.datasetRevision,
      mcc: dataset.mcc,
      mnc: dataset.mnc,
      bootId: options.fix.bootId,
      instanceId: options.fix.instanceId,
      scopeFingerprint: fingerprint,
      capabilitiesScopeFingerprint: fingerprint,
      cellApplication: 'HOLD',
      scheduleMode: radioScheduleMode(),
      source: options.delivery ? 'STUB_RECEIVER' : 'LOCAL_PREPARE',
      evidence,
      delivery: options.delivery,
    }) : null;
    const lifecycle = tripArrivals.open(options.trip.id, {
      runtime, evidence, tenantId: options.trip.tenantId, tripId: options.trip.id,
      deviceId: options.trip.deviceId, imageId: options.trip.imageId,
      sessionId: runtime?.sessionId ?? '11111111-1111-4111-8111-111111111111',
      bootId: options.fix.bootId, instanceId: options.fix.instanceId,
      destination, anchor, destinationPolicy: destinationPolicy(),
    });
    const tick = await lifecycle.onIdentifiedFix(options.fix);
    if (options.playerGpsCleaned) return lifecycle.notePlayerGpsCleaned(options.fix.wallMs);
    return tick;
  } catch (error) {
    logger.warn({
      event: 'radio_feed_failed', tripId: options.trip.id, imageId: options.trip.imageId,
      reason: error instanceof Error ? error.message : 'Radio feed failed',
    }, 'GPS progress was kept; radio evidence recorded a failure rather than assumed application');
    return null;
  }
}

/** @deprecated GPS progress must go through the arrival lifecycle. Kept for callers that still pass a raw phase. */
export async function feedTripRadio(options: {
  trip: Pick<DrivingTrip, 'id' | 'tenantId' | 'deviceId' | 'imageId'>;
  progress: Omit<GpsRadioProgress, 'tripId' | 'deviceId' | 'tenantId' | 'imageId'>;
  bootId: string;
  instanceId: string;
  dataset?: RadioDataset | null;
  delivery?: RadioDeliveryAdapter;
  packages?: readonly string[];
}): Promise<void> {
  await feedIdentifiedTripGps({
    trip: { ...options.trip, routeJson: JSON.stringify({ destination: options.progress.position }) },
    fix: {
      lat: options.progress.position.lat, lng: options.progress.position.lng,
      accuracyM: 8, speedMps: options.progress.phase === 'MOVING' ? 8 : 0,
      elapsedMs: options.progress.elapsedMs, nowElapsedMs: options.progress.elapsedMs,
      sequence: options.progress.sequence, wallMs: options.progress.wallMs, bootId: options.bootId,
      instanceId: options.instanceId,
    },
    dataset: options.dataset, delivery: options.delivery, packages: options.packages,
    playerGpsCleaned: options.progress.phase === 'CLEANUP',
  });
}

export async function pauseTripRadio(tripId: string, reason: string, wallMs = Date.now()): Promise<void> {
  const lifecycle = tripArrivals.get(tripId);
  if (lifecycle) await lifecycle.pause(reason, wallMs);
}

export async function cancelTripRadio(tripId: string, reason: string, uncertain = false, wallMs = Date.now()): Promise<void> {
  const lifecycle = tripArrivals.get(tripId);
  if (lifecycle) await lifecycle.cancel(reason, wallMs, uncertain);
}

export async function expireTripRadio(tripId: string, reason: string, wallMs = Date.now()): Promise<void> {
  const lifecycle = tripArrivals.get(tripId);
  if (lifecycle) await lifecycle.expire(reason, wallMs);
}

export function closeTripRadio(tripId: string): void {
  tripArrivals.close(tripId);
}

export function tripArrivalSnapshot(tripId: string): ArrivalLifecycleTick | undefined {
  return tripArrivals.get(tripId)?.snapshot();
}
