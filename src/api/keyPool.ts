import { createHash } from "node:crypto";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { KeyDeadError, RateLimitError } from "../types.js";

export interface PooledKey {
  id: string;
  key: string;
  label: string;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export class ApiKeyPool {
  private keys: PooledKey[];
  private cursor = 0;
  private congestedUntil = new Map<string, number>();
  private backoffMs = new Map<string, number>();

  constructor(rawKeys: string[] = config.apiKeys) {
    this.keys = rawKeys.map((key, i) => ({
      id: hashKey(key),
      key,
      label: `key-${i + 1}`,
    }));
  }

  size(): number {
    return this.keys.length;
  }

  async acquire(): Promise<PooledKey> {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.cursor + i) % this.keys.length;
      const candidate = this.keys[idx]!;
      const until = this.congestedUntil.get(candidate.id) ?? 0;
      const row = await prisma.apiKeyStat.findUnique({ where: { id: candidate.id } });
      if (row?.dead) continue;
      if (until > now) continue;
      this.cursor = (idx + 1) % this.keys.length;
      return candidate;
    }

    let soonest = Infinity;
    for (const k of this.keys) {
      soonest = Math.min(soonest, this.congestedUntil.get(k.id) ?? now);
    }
    const wait = Number.isFinite(soonest) ? Math.max(50, soonest - now) : 1000;
    throw new RateLimitError("All API keys congested", wait);
  }

  async markSuccess(key: PooledKey): Promise<void> {
    this.backoffMs.set(key.id, 1000);
    this.congestedUntil.delete(key.id);
    await prisma.apiKeyStat.upsert({
      where: { id: key.id },
      create: {
        id: key.id,
        label: key.label,
        successCount: 1,
        lastUsedAt: new Date(),
      },
      update: {
        successCount: { increment: 1 },
        lastUsedAt: new Date(),
        lastError: null,
      },
    });
  }

  async mark429(key: PooledKey, retryAfterMs?: number): Promise<number> {
    const prev = this.backoffMs.get(key.id) ?? 1000;
    const next = Math.min(prev * 2, 60_000);
    const pause = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : next;
    this.backoffMs.set(key.id, next);
    this.congestedUntil.set(key.id, Date.now() + pause);
    logger.warn({ key: key.label, pause }, "API key 429 — congested");
    await prisma.apiKeyStat.upsert({
      where: { id: key.id },
      create: {
        id: key.id,
        label: key.label,
        failCount: 1,
        congestedUntil: new Date(Date.now() + pause),
        lastUsedAt: new Date(),
        lastError: "429",
      },
      update: {
        failCount: { increment: 1 },
        congestedUntil: new Date(Date.now() + pause),
        lastUsedAt: new Date(),
        lastError: "429",
      },
    });
    return pause;
  }

  async markDead(key: PooledKey, reason: string): Promise<void> {
    logger.error({ key: key.label, reason }, "API key marked dead");
    await prisma.apiKeyStat.upsert({
      where: { id: key.id },
      create: {
        id: key.id,
        label: key.label,
        dead: true,
        failCount: 1,
        lastError: reason,
        lastUsedAt: new Date(),
      },
      update: {
        dead: true,
        failCount: { increment: 1 },
        lastError: reason,
        lastUsedAt: new Date(),
      },
    });
  }

  async ensureRows(): Promise<void> {
    for (const key of this.keys) {
      await prisma.apiKeyStat.upsert({
        where: { id: key.id },
        create: { id: key.id, label: key.label },
        update: { label: key.label },
      });
    }
  }
}

export const keyPool = new ApiKeyPool();

export async function withKey<T>(fn: (key: PooledKey) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < Math.max(2, keyPool.size() + 1); attempt++) {
    try {
      const key = await keyPool.acquire();
      try {
        const result = await fn(key);
        await keyPool.markSuccess(key);
        return result;
      } catch (err) {
        if (err instanceof RateLimitError) {
          await keyPool.mark429(key, err.retryAfterMs);
          lastErr = err;
          continue;
        }
        if (err instanceof KeyDeadError) {
          await keyPool.markDead(key, err.message);
          lastErr = err;
          continue;
        }
        throw err;
      }
    } catch (err) {
      lastErr = err;
      if (err instanceof RateLimitError) {
        await new Promise((r) => setTimeout(r, Math.min(err.retryAfterMs, 2000)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Key pool exhausted");
}
