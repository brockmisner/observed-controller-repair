import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { PrismaRadioEvidenceStore } from './evidenceStore.js';
import { injectionScopeFingerprint, tripRadios, type GpsRadioProgress } from './runtime.js';
import { radioScheduleMode } from './scheduling.js';
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

export async function feedTripRadio(options: {
  trip: Pick<DrivingTrip, 'id' | 'tenantId' | 'deviceId' | 'imageId'>;
  progress: Omit<GpsRadioProgress, 'tripId' | 'deviceId' | 'tenantId' | 'imageId'>;
  bootId: string;
  instanceId: string;
  dataset?: RadioDataset | null;
  delivery?: RadioDeliveryAdapter;
  packages?: readonly string[];
}): Promise<void> {
  try {
    const dataset = options.dataset === undefined ? await radioDatasetForTrip(options.trip) : options.dataset;
    if (!dataset) return;
    const runtime = tripRadios.open({
      records: dataset.records,
      tenantId: options.trip.tenantId,
      imageId: options.trip.imageId,
      tripId: options.trip.id,
      deviceId: options.trip.deviceId,
      datasetRevision: dataset.datasetRevision,
      mcc: dataset.mcc,
      mnc: dataset.mnc,
      bootId: options.bootId,
      instanceId: options.instanceId,
      scopeFingerprint: injectionScopeFingerprint(options.packages ?? ['net.stakeout.duomove.player']),
      scheduleMode: radioScheduleMode(),
      source: options.delivery ? 'STUB_RECEIVER' : 'LOCAL_PREPARE',
      evidence,
      delivery: options.delivery,
    });
    await runtime.ingest({
      tripId: options.trip.id,
      deviceId: options.trip.deviceId,
      tenantId: options.trip.tenantId,
      imageId: options.trip.imageId,
      ...options.progress,
    });
  } catch (error) {
    logger.warn({
      event: 'radio_feed_failed', tripId: options.trip.id, imageId: options.trip.imageId,
      reason: error instanceof Error ? error.message : 'Radio feed failed',
    }, 'GPS progress was kept; radio evidence recorded a failure rather than assumed application');
  }
}

export function closeTripRadio(tripId: string): void {
  tripRadios.close(tripId);
}
