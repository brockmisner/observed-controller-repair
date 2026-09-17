import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { decryptSecret, encryptSecret, fingerprintKey, last4 } from "../security/crypto.js";
import { KeyDeadError, RateLimitError } from "../types.js";
import type { PooledKey } from "./keyPool.js";
import { duoPlusRateLimiter } from "./rateLimit.js";
import { HttpError } from "../http/errors.js";

const congestedUntil = new Map<string, number>();
const backoffMs = new Map<string, number>();

export async function addTenantKey(tenantId: string, rawKey: string, label?: string): Promise<{ id: string; last4: string; label: string }> {
  const key = rawKey.trim();
  if (key.length < 8) throw new Error("API key looks too short");
  const sealed = encryptSecret(key);
  const row = await prisma.tenantKey.create({
    data: {
      id: randomUUID(),
      tenantId,
      label: label?.trim() || `key-${last4(key)}`,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      tag: sealed.tag,
      last4: last4(key),
      keyHash: fingerprintKey(key),
    },
  });
  return { id: row.id, last4: row.last4, label: row.label };
}

export async function listTenantKeys(tenantId: string) {
  const rows = await prisma.tenantKey.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((k) => ({
    id: k.id,
    label: k.label,
    last4: k.last4,
    dead: k.dead,
    failCount: k.failCount,
    successCount: k.successCount,
    lastUsedAt: k.lastUsedAt,
    lastError: k.lastError,
    congested: Boolean(k.congestedUntil && k.congestedUntil > new Date()),
  }));
}

export async function deleteTenantKey(tenantId: string, id: string): Promise<void> {
  await prisma.tenantKey.deleteMany({ where: { id, tenantId } });
}

export async function tenantKeyCount(tenantId: string): Promise<number> {
  return prisma.tenantKey.count({ where: { tenantId, dead: false } });
}

export async function withTenantKey<T>(tenantId: string, fn: (key: PooledKey) => Promise<T>): Promise<T> {
  const rows = await prisma.tenantKey.findMany({ where: { tenantId, dead: false } });
  if (rows.length === 0) throw new HttpError(400, "No active DuoPlus API keys on this workspace. Add a key first.");

  let lastErr: unknown;
  const cooldown = (row: typeof rows[number]) => Math.max(
    congestedUntil.get(row.keyHash) ?? 0,
    row.congestedUntil?.getTime() ?? 0,
  );
  const ordered = [...rows].sort((a, b) =>
    Number(cooldown(a) > Date.now()) - Number(cooldown(b) > Date.now()) ||
    duoPlusRateLimiter.pending(a.keyHash) - duoPlusRateLimiter.pending(b.keyHash) ||
    (a.lastUsedAt?.getTime() ?? 0) - (b.lastUsedAt?.getTime() ?? 0),
  );

  for (const row of ordered) {
    if (cooldown(row) > Date.now()) continue;
    try {
      return await duoPlusRateLimiter.run(row.keyHash, async () => {
        const current = await prisma.tenantKey.findFirst({ where: { id: row.id, tenantId, dead: false } });
        if (!current) throw new KeyDeadError("DuoPlus key is no longer available");
        const remaining = cooldown(current) - Date.now();
        if (remaining > 0) throw new RateLimitError("DuoPlus key is cooling down", remaining);
        const pooled: PooledKey = { id: current.id, key: decryptSecret(current), label: current.label };

        try {
          const result = await fn(pooled);
          await prisma.tenantKey.updateMany({
            where: { id: current.id, tenantId },
            data: { successCount: { increment: 1 }, lastUsedAt: new Date(), lastError: null, congestedUntil: null },
          });
          backoffMs.set(current.keyHash, 1000);
          congestedUntil.delete(current.keyHash);
          return result;
        } catch (err) {
          if (err instanceof RateLimitError) {
            const next = Math.min((backoffMs.get(current.keyHash) ?? 1000) * 2, 60_000);
            const pause = err.retryAfterMs > 0 ? err.retryAfterMs : next;
            backoffMs.set(current.keyHash, next);
            congestedUntil.set(current.keyHash, Date.now() + pause);
            await prisma.tenantKey.updateMany({
              where: { id: current.id, tenantId },
              data: {
                failCount: { increment: 1 }, congestedUntil: new Date(Date.now() + pause),
                lastError: "429", lastUsedAt: new Date(),
              },
            });
            logger.warn({ tenantId, keyId: current.id, pause }, "tenant key 429");
          } else if (err instanceof KeyDeadError) {
            await prisma.tenantKey.updateMany({
              where: { id: current.id, tenantId },
              data: { dead: true, lastError: "DuoPlus authentication failed", failCount: { increment: 1 } },
            });
          }
          throw err;
        }
      });
    } catch (err) {
      lastErr = err;
      if (err instanceof RateLimitError || err instanceof KeyDeadError) continue;
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new RateLimitError("All workspace keys congested", 1000);
}
