import { prisma } from "../db.js";
import { randomUUID } from "node:crypto";
import { redisConnection } from "../queue/connection.js";
import { HttpError } from "../http/errors.js";

const ttlMs = 60_000;
const ownsScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";
const releaseScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HttpError(503, "Trip coordination is unavailable")), 3000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export interface TripLease { assertOwned(): Promise<void> }

// Compare-and-delete prevents an expired worker from releasing a newer worker's lease.
export async function withTripLease<T>(deviceId: string, tenantId: string, work: (lease: TripLease) => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  const device = await prisma.device.findFirst({ where: { id: deviceId, tenantId }, select: { imageId: true } });
  if (!device) throw new HttpError(404, "Device not found");
  const key = `observatory:trip:physical:${encodeURIComponent(device.imageId)}`;
  const token = randomUUID();
  let lost = false;
  const acquire = async () => {
    const pending = redisConnection.set(key, token, "PX", ttlMs, "NX");
    try { return await bounded(pending); }
    catch (error) {
      // A queued SET can succeed after the timeout when Redis reconnects.
      void pending.then((result) => result === "OK" ? bounded(redisConnection.eval(releaseScript, 1, key, token)) : undefined)
        .catch(() => undefined);
      throw error;
    }
  };
  const deadline = performance.now() + (options.waitMs ?? 30_000);
  let acquired = await acquire();
  while (acquired !== "OK" && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    acquired = await acquire();
  }
  if (acquired !== "OK") throw new HttpError(409, "Another trip operation is in progress for this device");
  const lease: TripLease = { async assertOwned() {
    if (lost || await bounded(redisConnection.eval(ownsScript, 1, key, token, ttlMs)) !== 1) {
      lost = true;
      throw new HttpError(409, "Trip ownership expired; no further updates will be sent");
    }
  } };
  const renewal = setInterval(() => { void lease.assertOwned().catch(() => { lost = true; }); }, ttlMs / 4);
  renewal.unref();
  try { return await work(lease); }
  finally {
    clearInterval(renewal);
    await bounded(redisConnection.eval(releaseScript, 1, key, token)).catch(() => undefined);
  }
}
