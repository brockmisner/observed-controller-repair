import { createHash, randomUUID } from 'node:crypto';
import { applyRequestFromFrame, applyRequestSchema, timedOutVerdict, type ApplyRequest, type ClockAnchor } from './contract.js';
import { RadioEngine, type RadioFrame } from './engine.js';
import { hashFrame } from './arrival.js';
import { SCAN_CADENCE } from './policy.js';
import { DELIVERED_TIMEOUT_MS, radioScheduleMode, requiresBoundedDelivery, type RadioScheduleMode } from './scheduling.js';
import {
  evidenceClassFor, recordedApplied, type RadioEvidenceRecord, type RadioEvidenceSource, type RadioEvidenceStore,
} from './evidence.js';
import type { RadioDeliveryAdapter, RadioDeliveryResult } from '../trips/radioDelivery.js';

export interface GpsRadioProgress {
  tripId: string;
  deviceId: string;
  tenantId: string;
  imageId: string;
  position: { lat: number; lng: number };
  elapsedMs: number;
  sequence: number;
  phase: 'MOVING' | 'ARRIVED' | 'CLEANUP';
  wallMs: number;
}

export interface TripRadioOpen {
  records: unknown;
  tenantId: string;
  imageId: string;
  tripId: string;
  deviceId: string;
  datasetRevision: string;
  mcc: string;
  mnc: string;
  bootId: string;
  instanceId: string;
  scopeFingerprint: string;
  scheduleMode?: RadioScheduleMode;
  source?: RadioEvidenceSource;
  evidence: RadioEvidenceStore;
  delivery?: RadioDeliveryAdapter;
  clockAnchor?: ClockAnchor | null;
  sessionId?: string;
  /**
   * Cellular is unsupported for this service area unless a funded LTE/NR dataset exists.
   * Default HOLD so arrival can complete on Wi-Fi + Bluetooth.
   */
  cellApplication?: 'HOLD' | 'REPLACE';
  /** Plugin-declared scope; a frame computed for a different fingerprint cannot apply. */
  capabilitiesScopeFingerprint?: string;
}

export interface RadioTickResult {
  sessionId: string;
  sequence: number;
  phase: 'MOVING' | 'ARRIVED' | 'CLEANUP';
  frame: RadioFrame | null;
  apply: ApplyRequest | null;
  delivered: boolean;
  late: boolean;
  duplicate: boolean;
  applied: boolean;
  uncertain: boolean;
  evidence: RadioEvidenceRecord;
  delivery?: RadioDeliveryResult;
}

const serving = (frame: RadioFrame | null) => frame?.cells.find((cell) => cell.registered)?.identifier ?? null;

function cleanupRequest(frame: RadioFrame, context: { messageId: string; bootId: string; instanceId: string; scopeFingerprint: string; sentAtWallMs: number; frameHash: string }): ApplyRequest {
  return applyRequestSchema.parse({
    protocol: 'duoplus.radio', protocolVersion: 1, messageType: 'radio.apply',
    messageId: context.messageId, sentAtWallMs: context.sentAtWallMs,
    identity: {
      tenantId: frame.tenantId, imageId: frame.imageId, sessionId: frame.sessionId,
      bootId: context.bootId, instanceId: context.instanceId, datasetRevision: frame.datasetRevision,
    },
    sequence: frame.sequence, simElapsedMs: frame.elapsedMs, validForMs: 5000,
    scopeFingerprint: context.scopeFingerprint, phase: 'CLEANUP', position: frame.position,
    frameHash: context.frameHash,
    wifi: { directive: 'CLEAR', entries: null },
    cells: { directive: 'CLEAR', entries: null },
    bluetooth: { directive: 'CLEAR', entries: null },
    warnings: frame.warnings,
  });
}

/**
 * One radio engine for one owning trip. GPS progress is the only live clock; cache and serving
 * cell continuity belong to this instance. Scheduling is selectable (B06). Stub results never
 * become applied evidence (F04).
 */
export class TripRadioRuntime {
  readonly sessionId: string;
  readonly scheduleMode: RadioScheduleMode;
  readonly source: RadioEvidenceSource;
  private lastSequence = -1;
  private lastElapsedMs = -1;
  private lastTick: RadioTickResult | null = null;
  private readonly ticks = new Map<number, RadioTickResult>();
  private readonly engine: RadioEngine;

  constructor(private readonly options: TripRadioOpen) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.scheduleMode = options.scheduleMode ?? radioScheduleMode();
    this.source = options.source ?? 'STUB_RECEIVER';
    this.engine = new RadioEngine(options.records, {
      tenantId: options.tenantId, imageId: options.imageId, sessionId: this.sessionId,
      datasetRevision: options.datasetRevision, mcc: options.mcc, mnc: options.mnc,
    });
  }

  summary() {
    return {
      sessionId: this.sessionId, imageId: this.options.imageId, tripId: this.options.tripId,
      scheduleMode: this.scheduleMode, lastSequence: this.lastSequence, source: this.source,
      lastServing: serving(this.lastTick?.frame ?? null),
    };
  }

  identity() {
    return {
      tenantId: this.options.tenantId, imageId: this.options.imageId, tripId: this.options.tripId,
      deviceId: this.options.deviceId, sessionId: this.sessionId, bootId: this.options.bootId,
      instanceId: this.options.instanceId, datasetRevision: this.options.datasetRevision, source: this.source,
    };
  }

  lastAccepted() { return this.lastTick; }

  async ingest(progress: GpsRadioProgress): Promise<RadioTickResult> {
    if (progress.tenantId !== this.options.tenantId || progress.imageId !== this.options.imageId || progress.tripId !== this.options.tripId) {
      throw new Error('GPS progress does not belong to this radio session');
    }
    if (this.options.capabilitiesScopeFingerprint && this.options.capabilitiesScopeFingerprint !== this.options.scopeFingerprint) {
      throw new Error('Wrong-scope frame cannot apply: capabilities scopeFingerprint does not match the session');
    }
    if (!Number.isSafeInteger(progress.sequence) || progress.sequence < 0 || !Number.isSafeInteger(progress.elapsedMs) || progress.elapsedMs < 0) {
      throw new Error('Invalid GPS progress clock');
    }

    const prior = this.ticks.get(progress.sequence);
    if (prior && prior.frame && JSON.stringify(prior.frame.position) === JSON.stringify(progress.position)
        && prior.phase === progress.phase && prior.frame.elapsedMs === progress.elapsedMs) {
      const evidence = await this.options.evidence.append(this.event(prior, {
        kind: 'RESULT', lifecycle: prior.evidence.lifecycle, applied: false, uncertain: prior.uncertain,
        duplicate: true, detail: `Duplicate acknowledgment for sequence ${progress.sequence}; phone state was not re-applied`,
        payload: { duplicate: true, sequence: progress.sequence },
      }));
      const duplicate: RadioTickResult = { ...prior, duplicate: true, applied: false, evidence };
      this.ticks.set(progress.sequence, duplicate);
      return duplicate;
    }

    if (progress.sequence < this.lastSequence || (this.lastSequence >= 0 && progress.elapsedMs < this.lastElapsedMs)) {
      const evidence = await this.options.evidence.append({
        tenantId: this.options.tenantId, imageId: this.options.imageId, tripId: this.options.tripId,
        deviceId: this.options.deviceId, sessionId: this.sessionId, bootId: this.options.bootId,
        instanceId: this.options.instanceId, datasetRevision: this.options.datasetRevision,
        sequence: progress.sequence, simElapsedMs: progress.elapsedMs, phase: progress.phase,
        kind: 'FAILURE', lifecycle: 'REJECTED', applied: false, uncertain: false, duplicate: false,
        evidenceClass: evidenceClassFor(this.source), source: this.source, clockDomain: 'SIM',
        frameHash: null, servingCell: serving(this.lastTick?.frame ?? null),
        handoverFrom: null, handoverTo: null,
        detail: `Late frame ${progress.sequence} rejected; last accepted sequence is ${this.lastSequence}`,
        payload: { lastSequence: this.lastSequence, lastElapsedMs: this.lastElapsedMs },
      });
      return {
        sessionId: this.sessionId, sequence: progress.sequence, phase: progress.phase, frame: this.lastTick?.frame ?? null,
        apply: null, delivered: false, late: true, duplicate: false, applied: false, uncertain: false, evidence,
      };
    }

    const enginePhase = progress.phase === 'CLEANUP' ? 'MOVING' : progress.phase;
    const frame = this.engine.frame(progress.position, progress.elapsedMs, progress.sequence, enginePhase);
    const apply = this.toApply(frame, progress);
    const deliverThis = requiresBoundedDelivery(progress.phase, this.scheduleMode);
    const preparedKind = deliverThis ? 'REQUESTED' : 'SCHEDULED';
    const prepared = await this.options.evidence.append({
      tenantId: this.options.tenantId, imageId: this.options.imageId, tripId: this.options.tripId,
      deviceId: this.options.deviceId, sessionId: this.sessionId, bootId: this.options.bootId,
      instanceId: this.options.instanceId, datasetRevision: this.options.datasetRevision,
      sequence: progress.sequence, simElapsedMs: progress.elapsedMs, phase: progress.phase,
      kind: preparedKind, lifecycle: deliverThis ? 'REQUESTED' : 'VALIDATED',
      applied: false, uncertain: false, duplicate: false,
      evidenceClass: deliverThis ? evidenceClassFor(this.source) : 'PREPARED_NOT_APPLIED',
      source: deliverThis ? this.source : 'LOCAL_PREPARE', clockDomain: 'SIM',
      frameHash: apply.frameHash, servingCell: serving(frame),
      handoverFrom: frame.handover?.from ?? null, handoverTo: frame.handover?.to ?? null,
      detail: deliverThis
        ? `Delivering ${progress.phase} frame ${progress.sequence} under the ${DELIVERED_TIMEOUT_MS} ms budget`
        : `Scheduled radio frame ${progress.sequence} locally with GPS tick ${progress.elapsedMs} ms`,
      payload: { sequence: apply.sequence, simElapsedMs: apply.simElapsedMs, phase: apply.phase, identity: apply.identity },
    });

    let delivery: RadioDeliveryResult | undefined;
    let uncertain = false;
    let lifecycle = prepared.lifecycle;
    let detail = prepared.detail;
    if (deliverThis && this.options.delivery) {
      delivery = await this.options.delivery.deliver(apply, { sequence: progress.sequence, elapsedMs: progress.elapsedMs });
      const verdict = delivery.state === 'TIMED_OUT'
        ? timedOutVerdict(progress.sequence)
        : delivery.state === 'APPLIED'
          ? { applied: true, uncertain: false, state: 'APPLIED' as const }
          : { applied: false, uncertain: delivery.uncertain, state: delivery.state };
      uncertain = verdict.uncertain;
      lifecycle = verdict.state;
      detail = delivery.state === 'APPLIED' && this.source !== 'PLUGIN'
        ? `${delivery.detail}. Stub result recorded; not evidence of real application`
        : delivery.detail;
    } else if (deliverThis) {
      lifecycle = 'UNREACHABLE';
      detail = 'No radio receiver is configured; the frame was not applied';
    }

    const result = await this.options.evidence.append({
      tenantId: this.options.tenantId, imageId: this.options.imageId, tripId: this.options.tripId,
      deviceId: this.options.deviceId, sessionId: this.sessionId, bootId: this.options.bootId,
      instanceId: this.options.instanceId, datasetRevision: this.options.datasetRevision,
      sequence: progress.sequence, simElapsedMs: progress.elapsedMs, phase: progress.phase,
      kind: uncertain ? 'STATUS' : 'RESULT', lifecycle, applied: recordedApplied(this.source, delivery?.applied === true),
      uncertain, duplicate: false, evidenceClass: evidenceClassFor(deliverThis ? this.source : 'LOCAL_PREPARE'),
      source: deliverThis ? this.source : 'LOCAL_PREPARE', clockDomain: 'SIM',
      frameHash: apply.frameHash, servingCell: serving(frame),
      handoverFrom: frame.handover?.from ?? null, handoverTo: frame.handover?.to ?? null,
      detail, payload: { delivery: delivery ? { state: delivery.state, applied: delivery.applied, uncertain: delivery.uncertain, sent: delivery.sent } : null },
    });

    const tick: RadioTickResult = {
      sessionId: this.sessionId, sequence: progress.sequence, phase: progress.phase, frame, apply,
      delivered: Boolean(delivery?.sent), late: false, duplicate: false,
      applied: result.applied, uncertain, evidence: result, delivery,
    };
    this.lastSequence = progress.sequence;
    this.lastElapsedMs = progress.elapsedMs;
    this.lastTick = tick;
    this.ticks.set(progress.sequence, tick);
    return tick;
  }

  /**
   * A lost response is not treated as application. Reconcile through a stored result or an
   * explicit unknown; never invent a success.
   */
  async reconcile(sequence: number): Promise<RadioTickResult | null> {
    const tick = this.ticks.get(sequence);
    if (!tick) {
      await this.options.evidence.append({
        tenantId: this.options.tenantId, imageId: this.options.imageId, tripId: this.options.tripId,
        deviceId: this.options.deviceId, sessionId: this.sessionId, bootId: this.options.bootId,
        instanceId: this.options.instanceId, datasetRevision: this.options.datasetRevision,
        sequence, simElapsedMs: Math.max(0, this.lastElapsedMs), phase: 'MOVING',
        kind: 'STATUS', lifecycle: 'UNKNOWN', applied: false, uncertain: true, duplicate: false,
        evidenceClass: evidenceClassFor(this.source), source: this.source, clockDomain: 'SIM',
        frameHash: null, servingCell: serving(this.lastTick?.frame ?? null), handoverFrom: null, handoverTo: null,
        detail: `Sequence ${sequence} is unknown; application is not assumed`,
        payload: { known: false, sequence },
      });
      return null;
    }
    if (!tick.uncertain) return tick;
    const evidence = await this.options.evidence.append({
      tenantId: this.options.tenantId, imageId: this.options.imageId, tripId: this.options.tripId,
      deviceId: this.options.deviceId, sessionId: this.sessionId, bootId: this.options.bootId,
      instanceId: this.options.instanceId, datasetRevision: this.options.datasetRevision,
      sequence: tick.sequence, simElapsedMs: tick.frame?.elapsedMs ?? 0, phase: tick.phase,
      kind: 'STATUS', lifecycle: 'TIMED_OUT', applied: false, uncertain: true, duplicate: false,
      evidenceClass: evidenceClassFor(this.source), source: this.source, clockDomain: 'SIM',
      frameHash: tick.apply?.frameHash ?? null, servingCell: serving(tick.frame),
      handoverFrom: tick.frame?.handover?.from ?? null, handoverTo: tick.frame?.handover?.to ?? null,
      detail: 'Uncertain result remains unknown after status query; application is not assumed',
      payload: { known: tick.delivery?.received === true, sequence },
    });
    const next = { ...tick, applied: false, uncertain: true, evidence };
    this.ticks.set(sequence, next);
    return next;
  }

  private toApply(frame: RadioFrame, progress: GpsRadioProgress): ApplyRequest {
    const context = {
      messageId: randomUUID(),
      bootId: this.options.bootId,
      instanceId: this.options.instanceId,
      scopeFingerprint: this.options.scopeFingerprint,
      sentAtWallMs: progress.wallMs,
      frameHash: hashFrame(frame),
      wifiCacheIntervalMs: SCAN_CADENCE.wifi.defaultIntervalMs,
      bluetoothCacheIntervalMs: SCAN_CADENCE.bluetooth.defaultIntervalMs,
      wifiSampledSimElapsedMs: frame.wifi[0]?.sampleElapsedMs ?? frame.elapsedMs,
      bluetoothSampledSimElapsedMs: frame.bluetooth?.[0]?.sampleElapsedMs ?? null,
    };
    if (progress.phase === 'CLEANUP') return cleanupRequest(frame, context);
    const apply = applyRequestFromFrame(frame, context);
    if ((this.options.cellApplication ?? 'HOLD') === 'HOLD' && apply.cells.directive === 'REPLACE') {
      return applyRequestSchema.parse({
        ...apply,
        cells: { directive: 'HOLD', entries: null },
        warnings: apply.warnings.filter((warning) => !/^(NO_ELIGIBLE_CELL|CELL_|SECTOR_UNKNOWN)/.test(warning)),
      });
    }
    return apply;
  }

  private event(tick: RadioTickResult, patch: Partial<{
    kind: RadioTickResult['evidence']['kind']; lifecycle: string | null; applied: boolean; uncertain: boolean;
    duplicate: boolean; detail: string; payload: unknown;
  }>) {
    return {
      tenantId: this.options.tenantId, imageId: this.options.imageId, tripId: this.options.tripId,
      deviceId: this.options.deviceId, sessionId: this.sessionId, bootId: this.options.bootId,
      instanceId: this.options.instanceId, datasetRevision: this.options.datasetRevision,
      sequence: tick.sequence, simElapsedMs: tick.frame?.elapsedMs ?? 0, phase: tick.phase,
      kind: patch.kind ?? 'RESULT', lifecycle: patch.lifecycle ?? tick.evidence.lifecycle,
      applied: patch.applied ?? false, uncertain: patch.uncertain ?? false, duplicate: patch.duplicate ?? false,
      evidenceClass: evidenceClassFor(this.source), source: this.source, clockDomain: 'SIM' as const,
      frameHash: tick.apply?.frameHash ?? null, servingCell: serving(tick.frame),
      handoverFrom: tick.frame?.handover?.from ?? null, handoverTo: tick.frame?.handover?.to ?? null,
      detail: patch.detail ?? tick.evidence.detail, payload: patch.payload ?? null,
    };
  }
}

export class RadioRuntimeRegistry {
  private readonly runtimes = new Map<string, TripRadioRuntime>();
  get(tripId: string) { return this.runtimes.get(tripId); }
  open(options: TripRadioOpen) {
    const existing = this.runtimes.get(options.tripId);
    if (existing) return existing;
    const runtime = new TripRadioRuntime(options);
    this.runtimes.set(options.tripId, runtime);
    return runtime;
  }
  close(tripId: string) { this.runtimes.delete(tripId); }
}

export const tripRadios = new RadioRuntimeRegistry();

export function injectionScopeFingerprint(packages: readonly string[]): string {
  const normalized = [...new Set(packages.map((value) => value.trim().toLowerCase()))].sort();
  if (!normalized.length) throw new Error('Injected scope must name at least one package');
  return createHash('sha256').update(normalized.join('\n')).digest('hex');
}
