import { ArrivalGate, type ArrivalState } from './arrival.js';
import { compareReadback, LATENCY_BUDGET_MS, type ComparisonResult } from './policy.js';
import { evidenceClassFor, recordedApplied, type RadioEvidenceStore } from './evidence.js';
import { durableLocationAfterTrip, type DestinationPolicy } from './destinationPolicy.js';
import { tripRadios, type RadioTickResult, type TripRadioRuntime } from './runtime.js';
import { EVIDENCE_CLASS, readbackSchema, type ApplyRequest, type Readback } from './contract.js';

export type ArrivalStage =
  | 'TRAVELING'
  | 'SETTLING'
  | 'READY'
  | 'APPLYING_ARRIVAL'
  | 'AWAITING_OBSERVATION'
  | 'OBSERVATION_TIMED_OUT'
  | 'BLOCKED'
  | 'CLEANING_RADIO'
  | 'COMPLETE'
  | 'PAUSED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'UNCERTAIN_CANCEL';

export type BluetoothIntent = 'HOLD' | 'REPLACE' | 'CLEAR';
export type RadioOwnedInterface = 'WIFI' | 'CELLS' | 'BLUETOOTH';

export interface IdentifiedGpsFix {
  lat: number;
  lng: number;
  accuracyM: number;
  speedMps: number;
  elapsedMs: number;
  nowElapsedMs: number;
  sequence: number;
  wallMs: number;
  bootId: string;
}

export interface RadioOwnershipEntry {
  atWallMs: number;
  sessionId: string;
  bootId: string;
  instanceId: string;
  event: string;
  bluetoothIntent: BluetoothIntent;
  owned: RadioOwnedInterface[];
  residual: RadioOwnedInterface[];
  released: boolean;
  uncertain: boolean;
  applied: boolean;
  detail: string;
}

export interface ArrivalLifecycleTick {
  stage: ArrivalStage;
  gateState: ArrivalState;
  gateReason: string | null;
  bluetoothIntent: BluetoothIntent;
  bluetoothEntries: unknown[] | null;
  radioPhase: 'MOVING' | 'ARRIVED' | 'CLEANUP' | null;
  delivered: boolean;
  applied: boolean;
  uncertain: boolean;
  radioCleanupAllowed: boolean;
  providerCleanupAllowed: boolean;
  gpsProvidersCleanedEarly: boolean;
  canReleasePhone: boolean;
  destinationPolicy: DestinationPolicy;
  durableLocation: { lat: number; lng: number; source: 'DESTINATION' | 'ANCHOR'; restoreProviders: boolean };
  journal: RadioOwnershipEntry[];
  radio?: RadioTickResult;
  comparison?: ComparisonResult;
  detail: string;
}

export interface TripArrivalOpen {
  runtime: TripRadioRuntime | null;
  evidence: RadioEvidenceStore;
  tenantId: string;
  tripId: string;
  deviceId: string;
  imageId: string;
  sessionId: string;
  bootId: string;
  instanceId: string;
  destination: { lat: number; lng: number };
  anchor: { lat: number; lng: number };
  destinationPolicy: DestinationPolicy;
  dwellMs?: number;
  radiusM?: number;
  observationTimeoutMs?: number;
}

function stageFromGate(state: ArrivalState): ArrivalStage {
  if (state === 'MOVING') return 'TRAVELING';
  if (state === 'SETTLING') return 'SETTLING';
  if (state === 'READY_TO_APPLY') return 'READY';
  if (state === 'AWAITING_READBACK') return 'AWAITING_OBSERVATION';
  if (state === 'VERIFIED') return 'COMPLETE';
  return 'BLOCKED';
}

/**
 * D01–D08. Identified GPS fixes drive the arrival gate. Bluetooth REPLACE is intended only after
 * the gate is ready. Cleanup waits for that sequence. Stub results never become applied evidence.
 */
export class TripArrivalLifecycle {
  stage: ArrivalStage = 'TRAVELING';
  readonly gate: ArrivalGate;
  readonly journal: RadioOwnershipEntry[] = [];
  private arrivalDelivered = false;
  private radioCleaned = false;
  private gpsProvidersCleanedEarly = false;
  private awaitingObservationSince: number | null = null;
  private lastBluetoothEntries: unknown[] | null = null;
  private lastArrivalApply: ApplyRequest | null = null;
  private lastTick: ArrivalLifecycleTick | null = null;
  private owned: RadioOwnedInterface[] = [];
  private uncertainOutstanding = false;
  readonly observationTimeoutMs: number;

  constructor(private readonly options: TripArrivalOpen) {
    this.gate = new ArrivalGate(options.imageId, options.sessionId, options.destination, options.dwellMs ?? 30_000, options.radiusM ?? 30);
    this.observationTimeoutMs = options.observationTimeoutMs ?? LATENCY_BUDGET_MS.arrivalApplyToVerify;
  }

  get sessionId() { return this.options.sessionId; }
  get bootId() { return this.options.bootId; }

  snapshot(): ArrivalLifecycleTick {
    const previous = this.lastTick;
    return this.tick({
      bluetoothIntent: previous?.bluetoothIntent ?? 'HOLD',
      radioPhase: previous?.radioPhase ?? null,
      delivered: previous?.delivered ?? false,
      applied: false,
      uncertain: previous?.uncertain ?? this.uncertainOutstanding,
      detail: previous?.detail ?? 'No identified GPS has been observed yet',
      radio: previous?.radio,
    });
  }

  async onIdentifiedFix(fix: IdentifiedGpsFix): Promise<ArrivalLifecycleTick> {
    if (this.terminal()) return this.snapshot();
    if (this.stage === 'PAUSED') {
      return this.record('HOLD', 'Paused; identified GPS is not advancing arrival or Bluetooth', { radioPhase: null });
    }

    const gateState = this.gate.observeFix({
      lat: fix.lat, lng: fix.lng, bootId: fix.bootId, elapsedMs: fix.elapsedMs,
      accuracyM: fix.accuracyM, speedMps: fix.speedMps,
    }, fix.nowElapsedMs);

    if (gateState === 'BLOCKED') {
      this.stage = 'BLOCKED';
      return this.record('HOLD', `Arrival blocked: ${this.gate.reason ?? 'BLOCKED'}`, { radioPhase: 'MOVING', sequence: fix.sequence, elapsedMs: fix.elapsedMs, wallMs: fix.wallMs, position: fix });
    }

    this.stage = stageFromGate(gateState);
    const runtime = this.options.runtime;
    if (!runtime) {
      return this.withoutRadio(fix, 'No radio dataset; arrival gate advanced from identified GPS only');
    }

    if (this.stage === 'READY' && !this.arrivalDelivered) {
      this.stage = 'APPLYING_ARRIVAL';
      const radio = await runtime.ingest(this.progress(fix, 'ARRIVED'));
      this.noteDelivery(radio);
      this.arrivalDelivered = true;
      this.lastBluetoothEntries = radio.apply?.bluetooth.directive === 'REPLACE' ? radio.apply.bluetooth.entries : null;
      if (radio.apply) this.lastArrivalApply = radio.apply;
      const intent: BluetoothIntent = radio.apply?.bluetooth.directive === 'REPLACE' ? 'REPLACE' : 'HOLD';
      if (intent === 'REPLACE') this.own(['BLUETOOTH']);
      if (radio.apply?.wifi.directive === 'REPLACE') this.own(['WIFI']);
      if (radio.apply?.cells.directive === 'REPLACE') this.own(['CELLS']);
      if (radio.frame) {
        const prepared = structuredClone(radio.frame);
        prepared.warnings = prepared.warnings.filter((warning) => !/^(NO_ELIGIBLE_CELL|CELL_|SECTOR_UNKNOWN)/.test(warning));
        try { this.gate.prepare(prepared, fix.nowElapsedMs); }
        catch (error) {
          this.awaitingObservationSince = fix.wallMs;
          this.stage = 'AWAITING_OBSERVATION';
          return this.finishTick(radio, intent, `Arrival Bluetooth intended; readback not armed (${error instanceof Error ? error.message : 'prepare failed'})`);
        }
      }
      this.awaitingObservationSince = fix.wallMs;
      this.stage = 'AWAITING_OBSERVATION';
      return this.finishTick(radio, intent, intent === 'REPLACE'
        ? `Arrival Bluetooth REPLACE intended (${this.lastBluetoothEntries?.length ?? 0} entries); stub/plugin result is not observed application`
        : 'Arrival frame held Bluetooth; REPLACE was not issued');
    }

    if (this.stage === 'AWAITING_OBSERVATION' || this.stage === 'APPLYING_ARRIVAL') {
      return this.maybeTimeout(fix.wallMs, fix);
    }

    const radio = await runtime.ingest(this.progress(fix, 'MOVING'));
    this.noteDelivery(radio);
    if (radio.apply?.bluetooth.directive === 'REPLACE') {
      throw new Error('Bluetooth REPLACE during movement was refused by the arrival lifecycle');
    }
    if (radio.apply?.wifi.directive === 'REPLACE') this.own(['WIFI']);
    if (radio.apply?.cells.directive === 'REPLACE') this.own(['CELLS']);
    return this.finishTick(radio, 'HOLD', `Moving frame ${fix.sequence}; Bluetooth HOLD`);
  }

  async onObservationTimeout(wallMs: number): Promise<ArrivalLifecycleTick> {
    if (this.stage !== 'AWAITING_OBSERVATION' && this.stage !== 'APPLYING_ARRIVAL') return this.snapshot();
    this.stage = 'OBSERVATION_TIMED_OUT';
    await this.appendStatus('OBSERVATION_TIMED_OUT', 'Independent readback did not arrive; the phone is not held indefinitely', wallMs, true);
    return this.cleanupRadio(wallMs, 'Observation timed out; radio cleanup proceeds with unverified observation');
  }

  async onReadback(report: Readback, wallMs: number): Promise<ArrivalLifecycleTick> {
    const apply = this.lastArrivalApply;
    if (!apply || (this.stage !== 'AWAITING_OBSERVATION' && this.stage !== 'APPLYING_ARRIVAL')) {
      return this.record('HOLD', 'No arrival frame is waiting for readback', { radioPhase: 'ARRIVED', wallMs });
    }
    const parsed = readbackSchema.parse(report);
    if (parsed.evidenceClass !== EVIDENCE_CLASS) {
      throw new Error('Readback evidence class must be INJECTION_FIDELITY; physical RF is not a supported claim');
    }
    if (apply.identity.datasetRevision !== parsed.identity.datasetRevision) {
      await this.appendStatus('DATASET_REVISION_MISMATCH', 'Readback datasetRevision does not match the pinned session; it cannot be compared', wallMs, false);
      return this.record('REPLACE', 'Wrong dataset revision cannot compare', { radioPhase: 'ARRIVED', wallMs });
    }
    let comparison: ComparisonResult;
    try {
      comparison = compareReadback(apply, parsed);
    } catch (error) {
      await this.appendStatus('READBACK_REJECTED', error instanceof Error ? error.message : 'Readback rejected', wallMs, false);
      return this.record('REPLACE', error instanceof Error ? error.message : 'Readback rejected', { radioPhase: 'ARRIVED', wallMs });
    }
    const methods = (['wifi', 'cells', 'bluetooth'] as const)
      .map((name) => parsed[name].availability === 'MEASURED' ? `${name}:${parsed[name].collectionMethod}` : `${name}:${parsed[name].availability}`);
    const scanMethods = (['wifi', 'cells', 'bluetooth'] as const)
      .filter((name) => parsed[name].availability === 'MEASURED' && (parsed[name].collectionMethod === 'LIVE_SCAN' || parsed[name].collectionMethod === 'PLATFORM_CACHE'));
    const detail = comparison.role === 'OUT_OF_SCOPE_CONTROL'
      ? `Out-of-scope observer ${comparison.overall}; this cannot be a phone MISMATCH`
      : comparison.warnings.blocking.includes('IMAGE_PREREQUISITE_MISSING:WIFI_SCAN_THROTTLE')
        ? 'Wi-Fi throttle on: INCONCLUSIVE SCAN_THROTTLED_PRE_APPLICATION_ONLY, not a phone mismatch'
        : scanMethods.length
          ? `In-scope comparison ${comparison.overall} (${methods.join(', ')}); LIVE_SCAN/PLATFORM_CACHE speak to scanning`
          : `In-scope comparison ${comparison.overall} (${methods.join(', ')}); INJECTED_HOOK timestamps prove the hook re-ran, not that a radio scanned`;
    await this.options.evidence.append({
      ...this.evidenceIdentity(),
      sequence: apply.sequence, simElapsedMs: apply.simElapsedMs, phase: 'ARRIVED',
      kind: 'READBACK', lifecycle: comparison.overall, applied: false, uncertain: comparison.overall === 'INCONCLUSIVE',
      duplicate: false, evidenceClass: this.options.runtime?.source === 'PLUGIN' ? EVIDENCE_CLASS : evidenceClassFor(this.options.runtime?.source ?? 'CONTROLLER'),
      source: this.options.runtime?.source === 'PLUGIN' ? 'PLUGIN' : (this.options.runtime?.source ?? 'CONTROLLER'),
      clockDomain: 'PHONE_BOOT', frameHash: apply.frameHash, servingCell: null, handoverFrom: null, handoverTo: null,
      detail, payload: { overall: comparison.overall, role: comparison.role, claim: comparison.claim, verdicts: comparison.verdicts, scopeMembership: parsed.scopeMembership },
    });
    if (comparison.role !== 'IN_SCOPE_VERIFICATION') {
      this.lastTick = this.tick({
        bluetoothIntent: 'REPLACE', radioPhase: 'ARRIVED', delivered: true, applied: false,
        uncertain: false, detail, radio: this.lastTick?.radio, comparison,
      });
      return this.lastTick;
    }
    if (comparison.overall === 'MISMATCH') {
      this.stage = 'BLOCKED';
      this.lastTick = this.tick({
        bluetoothIntent: 'REPLACE', radioPhase: 'ARRIVED', delivered: true, applied: false,
        uncertain: false, detail, radio: this.lastTick?.radio, comparison,
      });
      return this.lastTick;
    }
    const throttleOnly = comparison.overall === 'BLOCKED'
      && comparison.warnings.blocking.every((warning) => warning.startsWith('IMAGE_PREREQUISITE_MISSING'));
    if (comparison.overall === 'VERIFIED' || comparison.overall === 'INCONCLUSIVE' || throttleOnly) {
      this.stage = comparison.overall === 'VERIFIED' ? 'COMPLETE' : 'OBSERVATION_TIMED_OUT';
      const cleaned = await this.cleanupRadio(wallMs, detail);
      return { ...cleaned, comparison, detail };
    }
    this.lastTick = this.tick({
      bluetoothIntent: 'REPLACE', radioPhase: 'ARRIVED', delivered: true, applied: false,
      uncertain: true, detail, radio: this.lastTick?.radio, comparison,
    });
    return this.lastTick;
  }

  async notePlayerGpsCleaned(wallMs: number): Promise<ArrivalLifecycleTick> {
    this.gpsProvidersCleanedEarly = true;
    await this.appendStatus('GPS_PROVIDERS_CLEANED', 'Player released mock GPS providers; durable controller location is unchanged until destination policy applies', wallMs, false);
    if (this.stage === 'AWAITING_OBSERVATION' && this.awaitingObservationSince !== null && wallMs - this.awaitingObservationSince >= this.observationTimeoutMs) {
      return this.onObservationTimeout(wallMs);
    }
    if (this.radioCleaned || this.stage === 'TRAVELING' || this.stage === 'SETTLING' || this.stage === 'READY') {
      if (!this.arrivalDelivered && (this.stage === 'TRAVELING' || this.stage === 'SETTLING')) {
        return this.record('HOLD', 'GPS providers cleaned before arrival evidence; waiting on observation timeout rather than holding forever', { radioPhase: null, wallMs });
      }
    }
    return this.snapshot();
  }

  async pause(reason: string, wallMs: number): Promise<ArrivalLifecycleTick> {
    if (this.terminal() && this.stage !== 'PAUSED') return this.snapshot();
    this.stage = 'PAUSED';
    this.awaitingObservationSince = null;
    this.journal.push(this.entry(wallMs, 'PAUSED', 'HOLD', false, false, reason));
    await this.appendStatus('PAUSED', reason, wallMs, this.uncertainOutstanding);
    return this.record('HOLD', reason, { radioPhase: null, wallMs });
  }

  async cancel(reason: string, wallMs: number, uncertain = false): Promise<ArrivalLifecycleTick> {
    this.uncertainOutstanding = this.uncertainOutstanding || uncertain;
    this.stage = uncertain ? 'UNCERTAIN_CANCEL' : 'CANCELLED';
    this.journal.push(this.entry(wallMs, uncertain ? 'UNCERTAIN_CANCEL' : 'CANCELLED', this.owned.length ? 'CLEAR' : 'HOLD', uncertain, false, reason));
    await this.appendStatus(uncertain ? 'UNCERTAIN_CANCEL' : 'CANCELLED', reason, wallMs, uncertain);
    if (!uncertain && this.options.runtime && !this.radioCleaned) {
      return this.cleanupRadio(wallMs, reason);
    }
    return this.record(this.owned.length && !uncertain ? 'CLEAR' : 'HOLD', reason, { radioPhase: null, wallMs, uncertain });
  }

  async expire(reason: string, wallMs: number): Promise<ArrivalLifecycleTick> {
    this.stage = 'EXPIRED';
    this.journal.push(this.entry(wallMs, 'EXPIRED', 'HOLD', true, false, reason));
    await this.appendStatus('EXPIRED', reason, wallMs, true);
    return this.record('HOLD', reason, { radioPhase: null, wallMs, uncertain: true });
  }

  async continuityBreak(reason: string, wallMs: number): Promise<ArrivalLifecycleTick> {
    this.journal.push(this.entry(wallMs, 'CONTINUITY_BREAK', 'HOLD', true, false, reason));
    await this.appendStatus('CONTINUITY_BREAK', reason, wallMs, false);
    this.stage = 'EXPIRED';
    return this.record('HOLD', reason, { radioPhase: null, wallMs });
  }

  private async maybeTimeout(wallMs: number, fix: IdentifiedGpsFix): Promise<ArrivalLifecycleTick> {
    if (this.awaitingObservationSince !== null && wallMs - this.awaitingObservationSince >= this.observationTimeoutMs) {
      return this.onObservationTimeout(wallMs);
    }
    return this.record('REPLACE', 'Waiting for independent radio readback; Bluetooth REPLACE already intended', {
      radioPhase: 'ARRIVED', sequence: fix.sequence, elapsedMs: fix.elapsedMs, wallMs, position: fix,
    });
  }

  private async cleanupRadio(wallMs: number, detail: string): Promise<ArrivalLifecycleTick> {
    const runtime = this.options.runtime;
    this.stage = 'CLEANING_RADIO';
    if (!runtime || this.radioCleaned) {
      this.radioCleaned = true;
      this.stage = 'COMPLETE';
      return this.record('CLEAR', detail, { radioPhase: 'CLEANUP', wallMs });
    }
    const last = runtime.lastAccepted();
    const radio = await runtime.ingest({
      ...this.progress({
        lat: this.options.destination.lat, lng: this.options.destination.lng,
        accuracyM: 8, speedMps: 0, elapsedMs: (last?.frame?.elapsedMs ?? 0) + 1000,
        nowElapsedMs: (last?.frame?.elapsedMs ?? 0) + 1000, sequence: (last?.sequence ?? 0) + 1,
        wallMs, bootId: runtime.identity().bootId,
      }, 'CLEANUP'),
    });
    this.noteDelivery(radio);
    this.radioCleaned = true;
    this.owned = [];
    this.stage = 'COMPLETE';
    this.journal.push(this.entry(wallMs, 'CLEANUP_REQUESTED', 'CLEAR', radio.uncertain, recordedApplied(runtime.source, radio.applied), detail));
    return this.finishTick(radio, 'CLEAR', detail);
  }

  private async withoutRadio(fix: IdentifiedGpsFix, detail: string): Promise<ArrivalLifecycleTick> {
    if (this.stage === 'READY') {
      this.stage = 'AWAITING_OBSERVATION';
      this.awaitingObservationSince = fix.wallMs;
    }
    if (this.awaitingObservationSince !== null && fix.wallMs - this.awaitingObservationSince >= this.observationTimeoutMs) {
      this.radioCleaned = true;
      this.stage = 'COMPLETE';
      return this.record('HOLD', 'No radio session; observation window closed without holding the phone', { radioPhase: null, wallMs: fix.wallMs });
    }
    return this.record('HOLD', detail, { radioPhase: null, wallMs: fix.wallMs });
  }

  private progress(fix: IdentifiedGpsFix, phase: 'MOVING' | 'ARRIVED' | 'CLEANUP') {
    const id = this.options.runtime!.identity();
    return {
      tripId: id.tripId, deviceId: id.deviceId, tenantId: id.tenantId, imageId: id.imageId,
      position: { lat: fix.lat, lng: fix.lng }, elapsedMs: fix.elapsedMs, sequence: fix.sequence,
      phase, wallMs: fix.wallMs,
    };
  }

  private noteDelivery(radio: RadioTickResult): void {
    this.uncertainOutstanding = this.uncertainOutstanding || radio.uncertain;
  }

  private own(interfaces: RadioOwnedInterface[]): void {
    this.owned = [...new Set([...this.owned, ...interfaces])];
  }

  private terminal(): boolean {
    return ['COMPLETE', 'EXPIRED', 'CANCELLED', 'UNCERTAIN_CANCEL', 'BLOCKED'].includes(this.stage);
  }

  private entry(wallMs: number, event: string, bluetoothIntent: BluetoothIntent, uncertain: boolean, applied: boolean, detail: string): RadioOwnershipEntry {
    const id = this.options.runtime?.identity();
    return {
      atWallMs: wallMs, sessionId: this.options.sessionId, bootId: id?.bootId ?? this.options.bootId,
      instanceId: id?.instanceId ?? this.options.instanceId, event, bluetoothIntent, owned: [...this.owned],
      residual: applied ? [] : [...this.owned], released: applied && this.owned.length === 0,
      uncertain, applied: false, detail,
    };
  }

  private evidenceIdentity() {
    const runtime = this.options.runtime;
    const id = runtime?.identity() ?? {
      tenantId: this.options.tenantId, imageId: this.options.imageId, tripId: this.options.tripId,
      deviceId: this.options.deviceId, sessionId: this.options.sessionId, bootId: this.options.bootId,
      instanceId: this.options.instanceId, datasetRevision: 'none', source: 'CONTROLLER' as const,
    };
    return id;
  }

  private async appendStatus(lifecycle: string, detail: string, wallMs: number, uncertain: boolean): Promise<void> {
    const id = this.evidenceIdentity();
    const last = this.options.runtime?.lastAccepted();
    await this.options.evidence.append({
      tenantId: id.tenantId, imageId: id.imageId, tripId: id.tripId, deviceId: id.deviceId,
      sessionId: id.sessionId, bootId: id.bootId, instanceId: id.instanceId, datasetRevision: id.datasetRevision,
      sequence: last?.sequence ?? 0, simElapsedMs: last?.frame?.elapsedMs ?? 0,
      phase: last?.phase ?? 'MOVING', kind: 'STATUS', lifecycle, applied: false, uncertain,
      duplicate: false, evidenceClass: evidenceClassFor(id.source), source: id.source, clockDomain: 'WALL',
      frameHash: last?.apply?.frameHash ?? null, servingCell: null, handoverFrom: null, handoverTo: null,
      detail, payload: { stage: this.stage, journal: this.journal.at(-1) ?? null, wallMs },
    });
  }

  private finishTick(radio: RadioTickResult, bluetoothIntent: BluetoothIntent, detail: string, comparison?: ComparisonResult): ArrivalLifecycleTick {
    const tick = this.tick({
      bluetoothIntent, radioPhase: radio.phase, delivered: radio.delivered, applied: radio.applied,
      uncertain: radio.uncertain, detail, radio, comparison,
    });
    this.lastTick = tick;
    return tick;
  }

  private record(bluetoothIntent: BluetoothIntent, detail: string, extra: {
    radioPhase: ArrivalLifecycleTick['radioPhase']; sequence?: number; elapsedMs?: number; wallMs?: number;
    position?: { lat: number; lng: number }; uncertain?: boolean; radio?: RadioTickResult;
  }): ArrivalLifecycleTick {
    const tick = this.tick({
      bluetoothIntent, radioPhase: extra.radioPhase, delivered: extra.radio?.delivered ?? false, applied: false,
      uncertain: extra.uncertain ?? this.uncertainOutstanding, detail, radio: extra.radio ?? this.lastTick?.radio,
    });
    this.lastTick = tick;
    return tick;
  }

  private tick(partial: Pick<ArrivalLifecycleTick, 'bluetoothIntent' | 'radioPhase' | 'delivered' | 'applied' | 'uncertain' | 'detail'> & { radio?: RadioTickResult; comparison?: ComparisonResult }): ArrivalLifecycleTick {
    const radioCleanupAllowed = this.radioCleaned;
    const observationClosed = this.radioCleaned || this.stage === 'OBSERVATION_TIMED_OUT' || this.stage === 'BLOCKED'
      || this.stage === 'CANCELLED' || this.stage === 'EXPIRED' || this.stage === 'COMPLETE';
    const providerCleanupAllowed = radioCleanupAllowed || (!this.arrivalDelivered && observationClosed);
    const canReleasePhone = !this.uncertainOutstanding && providerCleanupAllowed;
    return {
      stage: this.stage, gateState: this.gate.state, gateReason: this.gate.reason,
      bluetoothIntent: partial.bluetoothIntent, bluetoothEntries: this.lastBluetoothEntries,
      radioPhase: partial.radioPhase, delivered: partial.delivered, applied: false, uncertain: partial.uncertain,
      radioCleanupAllowed, providerCleanupAllowed,
      gpsProvidersCleanedEarly: this.gpsProvidersCleanedEarly,
      canReleasePhone,
      destinationPolicy: this.options.destinationPolicy,
      durableLocation: durableLocationAfterTrip(this.options.destinationPolicy, this.options.destination, this.options.anchor),
      journal: [...this.journal], radio: partial.radio, comparison: partial.comparison, detail: partial.detail,
    };
  }
}

export class ArrivalLifecycleRegistry {
  private readonly items = new Map<string, TripArrivalLifecycle>();
  get(tripId: string) { return this.items.get(tripId); }
  open(tripId: string, options: TripArrivalOpen) {
    const existing = this.items.get(tripId);
    if (existing) return existing;
    const lifecycle = new TripArrivalLifecycle(options);
    this.items.set(tripId, lifecycle);
    return lifecycle;
  }
  close(tripId: string) {
    this.items.delete(tripId);
    tripRadios.close(tripId);
  }
}

export const tripArrivals = new ArrivalLifecycleRegistry();
