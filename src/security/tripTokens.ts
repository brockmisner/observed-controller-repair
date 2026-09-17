import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError } from "../http/errors.js";
import { redisConnection } from "../queue/connection.js";
import { hashToken } from "./crypto.js";

const tokenPrefix = "obs_trip_";
const tokenLength = tokenPrefix.length + 64;
const controls = /[\x00-\x1f\x7f-\x9f]/;
const identifier = z.string().min(1).max(200).refine((value) => value.trim() === value && !controls.test(value));
const scopeSchema = z.object({ deviceId: identifier, tenantId: identifier }).strict();
const createSchema = z.object({
  label: z.string().refine((value) => !controls.test(value)).pipe(z.string().trim().min(1).max(80)),
  expiresInDays: z.number().int().min(1).max(90).default(30),
}).strict();
const secretSchema = z.string().length(tokenLength).regex(/^obs_trip_[a-f0-9]{64}$/);
const publicFields = { id: true, label: true, last4: true, expiresAt: true, createdAt: true, lastUsedAt: true } as const;

export interface TripTokenContext {
  id: string;
  tenantId: string;
  deviceId: string;
  imageId: string;
}

function validate<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "Invalid trip token input");
  return parsed.data;
}

async function tokenTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try { return await prisma.$transaction(work); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "Trip token service is unavailable. Try again shortly.");
  }
}

async function requireDevice(tx: Prisma.TransactionClient, scope: { deviceId: string; tenantId: string }): Promise<void> {
  if (!await tx.device.findFirst({ where: { id: scope.deviceId, tenantId: scope.tenantId }, select: { id: true } })) {
    throw new HttpError(404, "Device not found");
  }
}

export async function createTripToken(deviceId: string, tenantId: string, input: { label: string; expiresInDays?: number }) {
  const scope = validate(scopeSchema, { deviceId, tenantId });
  const options = validate(createSchema, input);
  return tokenTransaction(async (tx) => {
    await requireDevice(tx, scope);
    const now = new Date();
    if (await tx.tripToken.count({ where: { deviceId: scope.deviceId, expiresAt: { gt: now } } }) >= 10) {
      throw new HttpError(409, "This device already has ten active trip tokens. Revoke a token before creating another.");
    }
    const token = tokenPrefix + randomBytes(32).toString("hex");
    const row = await tx.tripToken.create({ data: {
      id: randomUUID(), ...scope, tokenHash: hashToken(token), last4: token.slice(-4), label: options.label,
      expiresAt: new Date(now.getTime() + options.expiresInDays * 86_400_000),
    }, select: { id: true, label: true, last4: true, expiresAt: true } });
    return { ...row, token };
  });
}

export async function listTripTokens(deviceId: string, tenantId: string) {
  const scope = validate(scopeSchema, { deviceId, tenantId });
  return tokenTransaction(async (tx) => {
    await requireDevice(tx, scope);
    return tx.tripToken.findMany({ where: { ...scope, device: { tenantId: scope.tenantId } }, select: publicFields,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  });
}

export async function revokeTripToken(deviceId: string, tenantId: string, tokenId: string): Promise<void> {
  const scope = validate(scopeSchema, { deviceId, tenantId });
  const id = validate(identifier, tokenId);
  await tokenTransaction(async (tx) => {
    await requireDevice(tx, scope);
    const deleted = await tx.tripToken.deleteMany({ where: { id, ...scope, device: { tenantId: scope.tenantId } } });
    if (deleted.count !== 1) throw new HttpError(404, "Trip token not found");
  });
}

export async function readTripToken(req: IncomingMessage): Promise<TripTokenContext | null> {
  const header = req.headers.authorization;
  if (typeof header !== "string" || header.length !== tokenLength + 7) return null;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  const parsed = secretSchema.safeParse(parts[1]);
  if (!parsed.success) return null;
  if ((req.rawHeaders?.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "authorization").length ?? 0) > 1) return null;
  const tokenHash = hashToken(parsed.data);
  return tokenTransaction(async (tx) => {
    const row = await tx.tripToken.findUnique({ where: { tokenHash }, select: {
      id: true, tenantId: true, deviceId: true, expiresAt: true,
      device: { select: { tenantId: true, imageId: true } },
    } });
    const now = new Date();
    if (!row || row.expiresAt <= now || row.tenantId !== row.device.tenantId) return null;
    const used = await tx.tripToken.updateMany({ where: {
      id: row.id, tokenHash, tenantId: row.tenantId, deviceId: row.deviceId, expiresAt: { gt: now },
      device: { tenantId: row.tenantId },
    }, data: { lastUsedAt: now } });
    if (used.count !== 1) return null;
    return { id: row.id, tenantId: row.tenantId, deviceId: row.deviceId, imageId: row.device.imageId };
  });
}

// Set expiry in the same Redis operation so a crash cannot leave a permanent counter.
const triggerLimitScript = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], 60) end
return count
`;

export async function rateLimitTripTrigger(tokenId: string): Promise<void> {
  const id = validate(identifier, tokenId);
  let count: unknown;
  let timer: NodeJS.Timeout | undefined;
  try {
    count = await Promise.race([
      redisConnection.eval(triggerLimitScript, 1, `observatory:trip-trigger:${id}`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Trip trigger rate limit timed out")), 3000);
      }),
    ]);
  }
  catch { throw new HttpError(503, "Trip trigger rate limit is unavailable. Try again shortly."); }
  finally { if (timer !== undefined) clearTimeout(timer); }
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
    throw new HttpError(503, "Trip trigger rate limit is unavailable. Try again shortly.");
  }
  if (count > 10) throw new HttpError(429, "Too many trip triggers. Try again in one minute.");
}
