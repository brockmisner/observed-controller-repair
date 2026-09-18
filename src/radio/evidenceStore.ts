import { randomUUID } from 'node:crypto';
import { prisma } from '../db.js';
import {
  MAX_EVIDENCE_PAYLOAD_BYTES, MAX_EVIDENCE_PER_SESSION, radioEvidenceInputSchema,
  type RadioEvidenceInput, type RadioEvidenceRecord, type RadioEvidenceStore,
} from './evidence.js';

function boundedPayload(payload: unknown): string {
  const json = JSON.stringify(payload ?? null);
  if (Buffer.byteLength(json, 'utf8') > MAX_EVIDENCE_PAYLOAD_BYTES) {
    return JSON.stringify({ truncated: true, preview: json.slice(0, 400) });
  }
  return json;
}

function fromRow(row: {
  id: string; tenantId: string; imageId: string; tripId: string; deviceId: string; sessionId: string;
  bootId: string; instanceId: string; datasetRevision: string; sequence: number; simElapsedMs: number;
  phase: string; kind: string; lifecycle: string | null; applied: boolean; uncertain: boolean;
  duplicate: boolean; current: boolean; evidenceClass: string; source: string; clockDomain: string;
  frameHash: string | null; servingCell: string | null; handoverFrom: string | null; handoverTo: string | null;
  detail: string; payloadJson: string; createdAt: Date;
}): RadioEvidenceRecord {
  return row as RadioEvidenceRecord;
}

export class PrismaRadioEvidenceStore implements RadioEvidenceStore {
  async append(input: RadioEvidenceInput, now = new Date()): Promise<RadioEvidenceRecord> {
    const parsed = radioEvidenceInputSchema.parse(input);
    return prisma.$transaction(async (tx) => {
      await tx.radioEvidence.updateMany({
        where: {
          tenantId: parsed.tenantId, imageId: parsed.imageId, tripId: parsed.tripId,
          OR: [{ sessionId: { not: parsed.sessionId } }, { bootId: { not: parsed.bootId } }],
        },
        data: { current: false },
      });
      const sessionCount = await tx.radioEvidence.count({ where: { tenantId: parsed.tenantId, sessionId: parsed.sessionId } });
      if (sessionCount >= MAX_EVIDENCE_PER_SESSION) {
        const oldest = await tx.radioEvidence.findMany({
          where: { tenantId: parsed.tenantId, sessionId: parsed.sessionId },
          orderBy: { createdAt: 'asc' }, take: sessionCount - MAX_EVIDENCE_PER_SESSION + 1, select: { id: true },
        });
        await tx.radioEvidence.deleteMany({ where: { id: { in: oldest.map((row) => row.id) } } });
      }
      const created = await tx.radioEvidence.create({
        data: {
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
        },
      });
      return fromRow(created);
    });
  }

  async list(query: { tenantId: string; imageId: string; tripId: string }): Promise<RadioEvidenceRecord[]> {
    const rows = await prisma.radioEvidence.findMany({
      where: { tenantId: query.tenantId, imageId: query.imageId, tripId: query.tripId },
      orderBy: [{ createdAt: 'asc' }, { sequence: 'asc' }],
    });
    return rows.map(fromRow);
  }

  async current(query: { tenantId: string; imageId: string; tripId: string; sessionId: string; bootId: string }): Promise<RadioEvidenceRecord[]> {
    const rows = await prisma.radioEvidence.findMany({
      where: {
        tenantId: query.tenantId, imageId: query.imageId, tripId: query.tripId,
        sessionId: query.sessionId, bootId: query.bootId, current: true,
      },
      orderBy: [{ createdAt: 'asc' }, { sequence: 'asc' }],
    });
    return rows.map(fromRow);
  }
}
