import { randomUUID } from 'node:crypto';
import { previewRadioCodec, RadioWireError, type RadioIdentity, type RadioWireCodec } from './radioWire.js';
import { RadioTransportError, type RadioTransport } from './radioTransport.js';
import type { ImageOwnership } from './imageOwnership.js';

/**
 * Authenticated radio delivery adapter (B03, B08).
 *
 * A frame reaches only the phone and session it was built for, under the physical-image lease that
 * owns that phone. Receipt is never treated as application: every delivery returns one explicit
 * state, and an uncertain outcome stays uncertain instead of being reported as success.
 */
export type RadioDeliveryState =
  | 'APPLIED'
  | 'RECEIVED'
  | 'REJECTED'
  | 'UNSUPPORTED'
  | 'TIMED_OUT'
  | 'UNREACHABLE'
  | 'PAYLOAD_TOO_LARGE'
  | 'REPLAY_REJECTED'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ACK'
  | 'OWNERSHIP_LOST'
  | 'CLOSED';

export interface RadioDeliveryResult {
  state: RadioDeliveryState;
  requestId: string;
  sequence: number;
  epoch: number;
  imageId: string;
  sessionId: string;
  /** True once bytes left the controller. A frame that was never sent cannot have been applied. */
  sent: boolean;
  received: boolean;
  validated: boolean;
  applied: boolean;
  /** True when the controller cannot tell whether the phone applied the frame. */
  uncertain: boolean;
  detail: string;
  unsupportedFields: string[];
  requestedAt: string;
  completedAt: string;
  appliedAt: string | null;
}

export interface RadioDeliveryOptions {
  identity: RadioIdentity;
  ownership: ImageOwnership;
  transport: RadioTransport;
  codec?: RadioWireCodec;
  timeoutMs?: number;
  maxPayloadBytes?: number;
  clock?: () => Date;
  requestId?: () => string;
}

export interface RadioDeliverySummary {
  imageId: string;
  sessionId: string;
  epoch: number;
  lastSequence: number;
  lastAppliedSequence: number;
  applied: number;
  failed: number;
  uncertain: number;
  closedReason: string | null;
  lastResult: RadioDeliveryResult | null;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PAYLOAD_BYTES = 32768;

export class RadioDeliveryAdapter {
  private readonly codec: RadioWireCodec;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly clock: () => Date;
  private readonly nextRequestId: () => string;
  private lastSequence = -1;
  private lastAppliedSequence = -1;
  private applied = 0;
  private failed = 0;
  private uncertain = 0;
  private closedReason: string | null = null;
  private lastResult: RadioDeliveryResult | null = null;

  constructor(private readonly options: RadioDeliveryOptions) {
    this.codec = options.codec ?? previewRadioCodec;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.clock = options.clock ?? (() => new Date());
    this.nextRequestId = options.requestId ?? (() => randomUUID());
  }

  get summary(): RadioDeliverySummary {
    return {
      imageId: this.options.identity.imageId, sessionId: this.options.identity.sessionId, epoch: this.options.ownership.epoch,
      lastSequence: this.lastSequence, lastAppliedSequence: this.lastAppliedSequence,
      applied: this.applied, failed: this.failed, uncertain: this.uncertain,
      closedReason: this.closedReason, lastResult: this.lastResult,
    };
  }

  /** Stops this writer for good. A closed adapter never sends again; a new session must be opened. */
  close(reason = 'Radio delivery closed'): void {
    if (!this.closedReason) this.closedReason = reason;
    this.options.transport.close();
  }

  async deliver(frame: unknown, input: { sequence: number; elapsedMs: number }): Promise<RadioDeliveryResult> {
    const requestedAt = this.clock().toISOString();
    const { identity, ownership } = this.options;
    const requestId = this.nextRequestId();
    const base = {
      requestId, sequence: input.sequence, epoch: ownership.epoch, imageId: identity.imageId, sessionId: identity.sessionId,
      sent: false, received: false, validated: false, applied: false, uncertain: false,
      unsupportedFields: [] as string[], requestedAt, appliedAt: null as string | null,
    };
    const finish = (state: RadioDeliveryState, detail: string, patch: Partial<RadioDeliveryResult> = {}): RadioDeliveryResult => {
      const result: RadioDeliveryResult = { ...base, state, detail, completedAt: this.clock().toISOString(), ...patch };
      if (result.applied) { this.applied += 1; this.lastAppliedSequence = result.sequence; }
      else this.failed += 1;
      if (result.uncertain) this.uncertain += 1;
      this.lastResult = result;
      return result;
    };

    if (this.closedReason) return finish('CLOSED', this.closedReason);
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0 || !Number.isSafeInteger(input.elapsedMs) || input.elapsedMs < 0) {
      return finish('REPLAY_REJECTED', 'Radio frame sequence or elapsed time is invalid');
    }
    if (input.sequence <= this.lastSequence) {
      return finish('REPLAY_REJECTED', `Frame ${input.sequence} is not newer than delivered frame ${this.lastSequence}`);
    }

    const payload = this.codec.encodeApply({ identity, requestId, epoch: ownership.epoch, sequence: input.sequence, elapsedMs: input.elapsedMs, frame });
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > this.maxPayloadBytes) {
      return finish('PAYLOAD_TOO_LARGE', `Radio frame is ${bytes} bytes; the supported limit is ${this.maxPayloadBytes}`);
    }

    // Ownership is proved immediately before the write, so an expired worker sends nothing at all.
    try { await ownership.assertOwned(); }
    catch (error) {
      this.close('Physical-phone ownership was lost');
      return finish('OWNERSHIP_LOST', error instanceof Error ? error.message : 'Physical-phone ownership was lost');
    }

    let raw: string;
    try {
      raw = await this.options.transport.send(payload, this.timeoutMs);
      base.sent = true;
      this.lastSequence = input.sequence;
    }
    catch (error) {
      // A frame that never reached the socket is a clean failure; a written frame stays uncertain.
      const wrote = error instanceof RadioTransportError ? error.wrote : true;
      base.sent = wrote;
      if (wrote) this.lastSequence = input.sequence;
      const detail = error instanceof Error ? error.message : 'Radio transport failed';
      if (error instanceof RadioTransportError && error.failure === 'TIMEOUT') {
        return finish('TIMED_OUT', 'The phone did not acknowledge this frame; application is unknown', { uncertain: true });
      }
      return finish('UNREACHABLE', detail, { uncertain: wrote });
    }

    let ack;
    try { ack = this.codec.decodeAck(raw); }
    catch (error) {
      this.close('Radio acknowledgment could not be read');
      return finish('INVALID_ACK', error instanceof RadioWireError ? error.message : 'Radio acknowledgment could not be read', { uncertain: true });
    }

    const mismatch = this.identityMismatch(ack, requestId, input.sequence);
    if (mismatch) {
      this.close('Radio acknowledgment identity did not match this phone or session');
      return finish('IDENTITY_MISMATCH', mismatch, { uncertain: true });
    }

    const observed = { received: ack.received, validated: ack.validated, unsupportedFields: ack.unsupportedFields };
    if (ack.status === 'APPLIED') {
      return finish('APPLIED', 'The phone applied this frame', { ...observed, applied: true, appliedAt: ack.appliedAt });
    }
    if (ack.status === 'RECEIVED') {
      return finish('RECEIVED', 'The phone received the frame but has not reported applying it', observed);
    }
    if (ack.status === 'UNSUPPORTED') {
      return finish('UNSUPPORTED', ack.reason ?? 'The phone does not support part of this frame', observed);
    }
    return finish('REJECTED', ack.reason ?? 'The phone rejected this frame', observed);
  }

  private identityMismatch(ack: { requestId: string; imageId: string; sessionId: string; instanceId: string; bootId: string; epoch: number; sequence: number },
    requestId: string, sequence: number): string | null {
    const { identity, ownership } = this.options;
    if (ack.requestId !== requestId) return 'The acknowledgment answered a different request';
    if (ack.imageId !== identity.imageId) return 'The acknowledgment came from a different phone';
    if (ack.sessionId !== identity.sessionId) return 'The acknowledgment belongs to a different radio session';
    if (ack.instanceId !== identity.instanceId) return 'The acknowledgment came from a different player instance';
    if (ack.bootId !== identity.bootId) return 'The acknowledgment came from a different phone boot';
    if (ack.epoch !== ownership.epoch) return 'The acknowledgment carries a different ownership epoch';
    if (ack.sequence !== sequence) return 'The acknowledgment answered a different frame sequence';
    return null;
  }
}
