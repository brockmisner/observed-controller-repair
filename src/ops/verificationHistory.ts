import { z } from 'zod';
import { HttpError } from '../http/errors.js';
import { PLAYER_PACKAGE, UPLOADED_PLAYER_SHA256 } from './playerVerification.js';

export const VERIFICATION_EVENT = 'PHONE_VERIFICATION';
const number = z.number().finite().nonnegative();
const time = z.string().datetime();
const observation = z.object({
  source: z.literal('RUNTIME_COMMAND'), state: z.enum(['OBSERVED', 'UNKNOWN']),
  point: z.object({ lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) }).nullable(),
  provider: z.enum(['gps', 'fused']).nullable(), ageMs: number.nullable(),
  fixElapsedRealtimeMs: number.nullable(), deviceElapsedRealtimeMs: number.nullable(),
  accuracyMeters: number.nullable(), mock: z.boolean().nullable(), checkedAt: time, reason: z.string().max(500),
});
const installed = z.object({
  packageName: z.literal(PLAYER_PACKAGE), versionCode: z.number().int().nonnegative(), versionName: z.string().max(80),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), matchesUploadedApk: z.boolean(),
}).refine(value => value.matchesUploadedApk === (value.sha256 === UPLOADED_PLAYER_SHA256));
export const verificationRecordSchema = z.object({
  version: z.literal(1), tenantId: z.string().min(1).max(200), deviceId: z.string().min(1).max(200), imageId: z.string().min(1).max(200),
  outcome: z.enum(['CHECKED', 'FAILED']), checkedAt: time, readOnly: z.literal(true),
  verificationSource: z.enum(['ADB', 'DUOPLUS_WORKSPACE_COMMAND']).nullable().default(null),
  installed: installed.nullable().default(null), installedError: z.string().max(500).nullable().default(null),
  observation: observation.nullable().default(null), locationError: z.string().max(500).nullable().default(null),
  player: z.object({ connected: z.literal(true), state: z.string().max(50), cleanupOk: z.boolean(),
    appliedSequence: z.number().int().min(-1).nullable(), frameworkObservedSequence: z.number().int().min(-1).nullable(),
    fusedObservedSequence: z.number().int().min(-1).nullable(), synthetic: z.boolean().nullable(),
    observationScope: z.enum(['player_app', 'UNKNOWN']),
  }).nullable().default(null),
  radios: z.object({ wifi: z.literal('NOT_OBSERVED'), cell: z.literal('NOT_OBSERVED'), bluetooth: z.literal('NOT_OBSERVED') }),
  error: z.string().max(500).nullable().default(null),
});
export type VerificationRecord = z.infer<typeof verificationRecordSchema>;
export interface VerificationIdentity { id: string; tenantId: string; imageId: string }
const radios = { wifi: 'NOT_OBSERVED', cell: 'NOT_OBSERVED', bluetooth: 'NOT_OBSERVED' } as const;

export function readVerificationRecord(detail: string | null | undefined, device: VerificationIdentity): VerificationRecord | null {
  if (!detail || detail.length > 12000) return null;
  try {
    const record = verificationRecordSchema.parse(JSON.parse(detail));
    return record.deviceId === device.id && record.imageId === device.imageId && record.tenantId === device.tenantId ? record : null;
  } catch { return null; }
}

/** Audit success and failure without persisting raw shell output or credentials. */
export async function recordVerification(device: VerificationIdentity, inspect: () => Promise<unknown>,
  save: (record: VerificationRecord) => Promise<void>, now = () => new Date()) {
  const identity = { version: 1, tenantId: device.tenantId, deviceId: device.id, imageId: device.imageId, readOnly: true };
  let record: VerificationRecord;
  try {
    const value = await inspect();
    if (!value || typeof value !== 'object') throw new Error('Invalid verification response');
    const result = value as Record<string, unknown>;
    if (result.deviceId !== device.id || result.imageId !== device.imageId) throw new HttpError(409, 'Phone assignment changed during verification');
    if (result.readOnly !== true) throw new Error('Invalid verification response');
    record = verificationRecordSchema.parse({ ...result, ...identity, outcome: 'CHECKED', error: null, radios });
  } catch (error) {
    const message = error instanceof HttpError ? error.message.slice(0, 500) : 'Phone verification failed. Check connectivity and retry.';
    await save(verificationRecordSchema.parse({ ...identity, outcome: 'FAILED', checkedAt: now().toISOString(), error: message, radios }));
    throw error;
  }
  await save(record);
  return record;
}

/** Coalesce repeat clicks per workspace/phone, never across identities. */
export class VerificationJobs {
  private pending = new Map<string, Promise<VerificationRecord>>();
  constructor(private readonly capacity = 16) {}
  run(device: VerificationIdentity, work: () => Promise<VerificationRecord>) {
    const key = JSON.stringify([device.tenantId, device.id, device.imageId]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.pending.size >= this.capacity) throw new HttpError(429, 'Phone verification is busy. Try again shortly.');
    const promise = Promise.resolve().then(work).finally(() => { this.pending.delete(key); });
    this.pending.set(key, promise);
    return promise;
  }
}
