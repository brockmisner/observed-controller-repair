import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EVIDENCE_CLASS } from './contract.js';

/**
 * F04. Durable, bounded radio evidence. Requested, received, applied and observed stay separate,
 * and a stub receiver can never be recorded as proof that a phone applied radio state.
 */

export const RADIO_EVIDENCE_KINDS = ['SCHEDULED', 'REQUESTED', 'RESULT', 'FAILURE', 'STATUS', 'READBACK'] as const;
export type RadioEvidenceKind = (typeof RADIO_EVIDENCE_KINDS)[number];

export const RADIO_EVIDENCE_SOURCES = ['PLUGIN', 'STUB_RECEIVER', 'LOCAL_PREPARE', 'CONTROLLER'] as const;
export type RadioEvidenceSource = (typeof RADIO_EVIDENCE_SOURCES)[number];

export const RADIO_EVIDENCE_CLASSES = [EVIDENCE_CLASS, 'STUB_NOT_APPLICATION', 'PREPARED_NOT_APPLIED'] as const;
export type RadioEvidenceClass = (typeof RADIO_EVIDENCE_CLASSES)[number];

export const MAX_EVIDENCE_PAYLOAD_BYTES = 8192;
export const MAX_EVIDENCE_PER_SESSION = 512;

const identityFields = {
  tenantId: z.string().min(1).max(200),
  imageId: z.string().min(1).max(200),
  tripId: z.string().min(1).max(200),
  deviceId: z.string().min(1).max(200),
  sessionId: z.string().uuid(),
  bootId: z.string().min(1).max(200),
  instanceId: z.string().min(1).max(200),
  datasetRevision: z.string().min(1).max(200),
};

export const radioEvidenceInputSchema = z.object({
  ...identityFields,
  sequence: z.number().int().min(0),
  simElapsedMs: z.number().int().min(0),
  phase: z.enum(['MOVING', 'ARRIVED', 'CLEANUP']),
  kind: z.enum(RADIO_EVIDENCE_KINDS),
  lifecycle: z.string().min(1).max(40).nullable().default(null),
  applied: z.boolean(),
  uncertain: z.boolean(),
  duplicate: z.boolean().default(false),
  evidenceClass: z.enum(RADIO_EVIDENCE_CLASSES),
  source: z.enum(RADIO_EVIDENCE_SOURCES),
  clockDomain: z.enum(['SIM', 'PHONE_BOOT', 'WALL']).default('SIM'),
  frameHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  servingCell: z.string().max(200).nullable().default(null),
  handoverFrom: z.string().max(200).nullable().default(null),
  handoverTo: z.string().max(200).nullable().default(null),
  detail: z.string().min(1).max(500),
  payload: z.unknown(),
}).strict().superRefine((row, ctx) => {
  if (row.source === 'STUB_RECEIVER' && row.applied) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['applied'], message: 'A stub receiver is not evidence of real application' });
  }
  if (row.source === 'LOCAL_PREPARE' && row.applied) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['applied'], message: 'Prepared frames are not evidence of application' });
  }
  if (row.evidenceClass === 'STUB_NOT_APPLICATION' && row.applied) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['applied'], message: 'Stub evidence cannot claim application' });
  }
  if (row.kind === 'READBACK' && row.applied) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['applied'], message: 'Readback never implies application' });
  }
});

export type RadioEvidenceInput = z.input<typeof radioEvidenceInputSchema>;

export interface RadioEvidenceRecord {
  id: string;
  tenantId: string;
  imageId: string;
  tripId: string;
  deviceId: string;
  sessionId: string;
  bootId: string;
  instanceId: string;
  datasetRevision: string;
  sequence: number;
  simElapsedMs: number;
  phase: string;
  kind: RadioEvidenceKind;
  lifecycle: string | null;
  applied: boolean;
  uncertain: boolean;
  duplicate: boolean;
  current: boolean;
  evidenceClass: RadioEvidenceClass;
  source: RadioEvidenceSource;
  clockDomain: string;
  frameHash: string | null;
  servingCell: string | null;
  handoverFrom: string | null;
  handoverTo: string | null;
  detail: string;
  payloadJson: string;
  createdAt: Date;
}

export interface RadioEvidenceStore {
  append(input: RadioEvidenceInput, now?: Date): Promise<RadioEvidenceRecord>;
  list(query: { tenantId: string; imageId: string; tripId: string }): Promise<RadioEvidenceRecord[]>;
  current(query: { tenantId: string; imageId: string; tripId: string; sessionId: string; bootId: string }): Promise<RadioEvidenceRecord[]>;
}

function boundedPayload(payload: unknown): string {
  const json = JSON.stringify(payload ?? null);
  if (Buffer.byteLength(json, 'utf8') > MAX_EVIDENCE_PAYLOAD_BYTES) {
    return JSON.stringify({ truncated: true, preview: json.slice(0, 400) });
  }
  return json;
}

export class MemoryRadioEvidenceStore implements RadioEvidenceStore {
  readonly rows: RadioEvidenceRecord[] = [];

  async append(input: RadioEvidenceInput, now = new Date()): Promise<RadioEvidenceRecord> {
    const parsed = radioEvidenceInputSchema.parse(input);
    const live = { sessionId: parsed.sessionId, bootId: parsed.bootId };
    for (const row of this.rows) {
      if (row.tenantId !== parsed.tenantId || row.imageId !== parsed.imageId || row.tripId !== parsed.tripId) continue;
      if (row.sessionId !== live.sessionId || row.bootId !== live.bootId) row.current = false;
    }
    const sessionRows = this.rows.filter((row) => row.tenantId === parsed.tenantId && row.sessionId === parsed.sessionId);
    if (sessionRows.length >= MAX_EVIDENCE_PER_SESSION) {
      const oldest = sessionRows.reduce((a, b) => a.createdAt <= b.createdAt ? a : b);
      const index = this.rows.indexOf(oldest);
      if (index >= 0) this.rows.splice(index, 1);
    }
    const record: RadioEvidenceRecord = {
      id: randomUUID(),
      tenantId: parsed.tenantId, imageId: parsed.imageId, tripId: parsed.tripId, deviceId: parsed.deviceId,
      sessionId: parsed.sessionId, bootId: parsed.bootId, instanceId: parsed.instanceId,
      datasetRevision: parsed.datasetRevision, sequence: parsed.sequence, simElapsedMs: parsed.simElapsedMs,
      phase: parsed.phase, kind: parsed.kind, lifecycle: parsed.lifecycle, applied: parsed.applied,
      uncertain: parsed.uncertain, duplicate: parsed.duplicate, current: true,
      evidenceClass: parsed.evidenceClass, source: parsed.source, clockDomain: parsed.clockDomain,
      frameHash: parsed.frameHash, servingCell: parsed.servingCell, handoverFrom: parsed.handoverFrom,
      handoverTo: parsed.handoverTo, detail: parsed.detail, payloadJson: boundedPayload(parsed.payload),
      createdAt: now,
    };
    this.rows.push(record);
    return record;
  }

  async list(query: { tenantId: string; imageId: string; tripId: string }): Promise<RadioEvidenceRecord[]> {
    return this.rows
      .filter((row) => row.tenantId === query.tenantId && row.imageId === query.imageId && row.tripId === query.tripId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.sequence - b.sequence);
  }

  async current(query: { tenantId: string; imageId: string; tripId: string; sessionId: string; bootId: string }): Promise<RadioEvidenceRecord[]> {
    return (await this.list(query)).filter((row) => row.current && row.sessionId === query.sessionId && row.bootId === query.bootId);
  }
}

export function evidenceClassFor(source: RadioEvidenceSource): RadioEvidenceClass {
  if (source === 'STUB_RECEIVER') return 'STUB_NOT_APPLICATION';
  if (source === 'LOCAL_PREPARE') return 'PREPARED_NOT_APPLIED';
  return EVIDENCE_CLASS;
}

/** Stub and prepared paths can confirm receipt or scheduling, never phone application. */
export function recordedApplied(source: RadioEvidenceSource, claimedApplied: boolean): boolean {
  if (source === 'STUB_RECEIVER' || source === 'LOCAL_PREPARE' || source === 'CONTROLLER') return false;
  return claimedApplied;
}
