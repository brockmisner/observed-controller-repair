import { prisma } from "../db.js";
import { redisConnection } from "../queue/connection.js";
import { HttpError } from "../http/errors.js";
import { withPhysicalImageLease, type ImageLeaseClient, type ImageOwnership } from "./imageOwnership.js";

export type TripLease = ImageOwnership;

/**
 * Trip operations run under the physical-image lease, so duplicate image rows in different
 * workspaces cannot drive the same phone at once. Player lifecycle and radio writes use the same
 * lease through `withPhysicalImageLease`.
 */
export async function withTripLease<T>(deviceId: string, tenantId: string, work: (lease: TripLease) => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  const device = await prisma.device.findFirst({ where: { id: deviceId, tenantId }, select: { imageId: true } });
  if (!device) throw new HttpError(404, "Device not found");
  return withPhysicalImageLease(device.imageId, redisConnection as unknown as ImageLeaseClient, work, options);
}
