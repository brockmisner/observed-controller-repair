import { createHash } from 'node:crypto';
import { createTrip, getTrip, pauseTrip, startTrip } from '../trips/service.js';
import { campaignDriveEvidence, type LatLng, type WarmupTripOwner } from './movement.js';

export async function startCampaignDrive(input: {
  tenantId: string; imageId: string; campaignId: string; runId: string; origin: LatLng; destination: LatLng;
}) {
  const owner: WarmupTripOwner = { campaignId: input.campaignId, runId: input.runId };
  const requestHash = createHash('sha256')
    .update(`warmup:${input.runId}:${input.origin.lat},${input.origin.lng}:${input.destination.lat},${input.destination.lng}`)
    .digest('hex');
  const trip = await createTrip(input.tenantId, {
    imageId: input.imageId, origin: input.origin, destination: input.destination, arrivalWifi: false, openMaps: false,
  }, { idempotencyKey: `warmup-run-${input.runId}`, requestHash }, owner, true);
  if (trip.status === 'PREVIEW') return startTrip(input.tenantId, trip.id, trip.revision, true);
  return trip;
}

export async function pauseCampaignDrive(tenantId: string, tripId: string, revision: string) {
  return pauseTrip(tenantId, tripId, revision);
}

export async function readCampaignDrive(tenantId: string, tripId: string) {
  return getTrip(tenantId, tripId);
}

export { campaignDriveEvidence };
