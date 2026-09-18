import { randomUUID } from 'node:crypto';
import { HttpError } from '../http/errors.js';

/**
 * Single-writer ownership for one physical image (B08).
 *
 * The Redis physical-image lease already guarded GPS trip operations. Player lifecycle work and
 * radio writes now run under the same lease, and every write also carries a fencing epoch so an
 * expired worker cannot overwrite a newer owner's work even if its payload arrives late.
 */
export const LEASE_TTL_MS = 60_000;
const ownsScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";
const releaseScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

export const leaseKeyFor = (imageId: string) => `observatory:trip:physical:${encodeURIComponent(imageId)}`;
export const epochKeyFor = (imageId: string) => `observatory:trip:epoch:${encodeURIComponent(imageId)}`;

export interface ImageLeaseClient {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  incr(key: string): Promise<number>;
}

/** The capability a writer must hold. `epoch` fences late payloads from a previous owner. */
export interface ImageOwnership {
  readonly imageId: string;
  readonly epoch: number;
  assertOwned(): Promise<void>;
  isLost(): boolean;
}

export interface LeaseOptions {
  waitMs?: number;
  ttlMs?: number;
  boundMs?: number;
}

async function bounded<T>(work: Promise<T>, boundMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HttpError(503, 'Trip coordination is unavailable')), boundMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Acquires the physical-image lease, raises the fencing epoch and runs `work` under it.
 * Compare-and-delete release prevents an expired worker from releasing a newer worker's lease.
 */
export async function withPhysicalImageLease<T>(
  imageId: string,
  client: ImageLeaseClient,
  work: (ownership: ImageOwnership) => Promise<T>,
  options: LeaseOptions = {},
): Promise<T> {
  if (!imageId) throw new HttpError(400, 'Physical image is required');
  const ttlMs = options.ttlMs ?? LEASE_TTL_MS;
  const boundMs = options.boundMs ?? 3000;
  const key = leaseKeyFor(imageId);
  const token = randomUUID();
  let lost = false;
  const acquire = async () => {
    const pending = client.set(key, token, 'PX', ttlMs, 'NX');
    try { return await bounded(pending, boundMs); }
    catch (error) {
      // A queued SET can succeed after the timeout when Redis reconnects.
      void pending.then((result) => result === 'OK' ? bounded(client.eval(releaseScript, 1, key, token), boundMs) : undefined)
        .catch(() => undefined);
      throw error;
    }
  };
  const deadline = performance.now() + (options.waitMs ?? 30_000);
  let acquired = await acquire();
  while (acquired !== 'OK' && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    acquired = await acquire();
  }
  if (acquired !== 'OK') throw new HttpError(409, 'Another trip operation is in progress for this device');
  const epoch = await bounded(client.incr(epochKeyFor(imageId)), boundMs);
  const ownership: ImageOwnership = {
    imageId,
    epoch,
    isLost: () => lost,
    async assertOwned() {
      if (lost || await bounded(client.eval(ownsScript, 1, key, token, ttlMs), boundMs) !== 1) {
        lost = true;
        throw new HttpError(409, 'Trip ownership expired; no further updates will be sent');
      }
    },
  };
  const renewal = setInterval(() => { void ownership.assertOwned().catch(() => { lost = true; }); }, ttlMs / 4);
  renewal.unref();
  try { return await work(ownership); }
  finally {
    clearInterval(renewal);
    await bounded(client.eval(releaseScript, 1, key, token), boundMs).catch(() => undefined);
  }
}

export interface ImageDeviceRow { id: string; tenantId: string; imageId: string; activeTripId: string | null }
export interface ImageReservation { imageId: string; tenantId: string; deviceId: string; campaignId: string }

/** The facts ownership needs. Implemented against Prisma at runtime, faked in tests. */
export interface ImageOwnershipStore {
  devicesForImage(imageId: string): Promise<ImageDeviceRow[]>;
  reservationForImage(imageId: string): Promise<ImageReservation | null>;
}

export interface AuthorizedImage { deviceId: string; tenantId: string; imageId: string; reservedBy: string | null }

/**
 * Workspace authorization for one physical image. Duplicate image rows across workspaces are the
 * expected case: the requesting workspace must own a row, and no other workspace may be driving or
 * holding a campaign reservation on the same physical phone.
 */
export async function authorizeImageWriter(tenantId: string, imageId: string, store: ImageOwnershipStore): Promise<AuthorizedImage> {
  if (!tenantId) throw new HttpError(401, 'Workspace required');
  if (!imageId) throw new HttpError(400, 'Physical image is required');
  const rows = await store.devicesForImage(imageId);
  const mine = rows.find((row) => row.tenantId === tenantId);
  if (!mine) throw new HttpError(404, 'This workspace does not own the phone for this image');
  const foreignTrip = rows.find((row) => row.id !== mine.id && row.activeTripId);
  if (foreignTrip) throw new HttpError(409, 'Another workspace trip owns this physical phone. Cancel it first.');
  const reservation = await store.reservationForImage(imageId);
  if (reservation && (reservation.tenantId !== tenantId || reservation.deviceId !== mine.id)) {
    throw new HttpError(409, 'A campaign reservation owns this physical phone.');
  }
  return { deviceId: mine.id, tenantId, imageId, reservedBy: reservation?.campaignId ?? null };
}

/** Prisma-backed store. Imported lazily so pure callers never construct a database client. */
export const prismaImageOwnershipStore: ImageOwnershipStore = {
  async devicesForImage(imageId) {
    const { prisma } = await import('../db.js');
    return prisma.device.findMany({ where: { imageId }, select: { id: true, tenantId: true, imageId: true, activeTripId: true } });
  },
  async reservationForImage(imageId) {
    const { prisma } = await import('../db.js');
    const campaign = await prisma.warmupCampaign.findFirst({ where: { reservedImageId: imageId },
      select: { id: true, tenantId: true, deviceId: true, imageId: true } });
    return campaign ? { imageId: campaign.imageId, tenantId: campaign.tenantId, deviceId: campaign.deviceId, campaignId: campaign.id } : null;
  },
};

/** Redis-backed lease client. Imported lazily for the same reason. */
export async function defaultLeaseClient(): Promise<ImageLeaseClient> {
  const { redisConnection } = await import('../queue/connection.js');
  return redisConnection as unknown as ImageLeaseClient;
}
