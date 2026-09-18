/**
 * Radio wire seam (B03).
 *
 * The real plugin protocol (A03/A04) does not exist yet. Everything the controller sends or reads
 * goes through this codec, so adopting the delivered schema means supplying another codec rather
 * than changing the adapter, the transport or the ownership rules. The frame body is opaque here
 * on purpose: this layer never interprets radio model fields.
 */
export const RADIO_WIRE_VERSION = 1;

export class RadioWireError extends Error {}

/** Identity carried on every radio write, so a frame can only apply to the phone it was built for. */
export interface RadioIdentity {
  tenantId: string;
  imageId: string;
  sessionId: string;
  /** Player instance the session belongs to; a restarted player invalidates it. */
  instanceId: string;
  /** Android boot identity, kept distinct from the simulation session. */
  bootId: string;
  datasetRevision: string;
}

export interface RadioApplyRequest {
  identity: RadioIdentity;
  requestId: string;
  /** Fencing token from the physical-image lease. A lower epoch must never overwrite a higher one. */
  epoch: number;
  sequence: number;
  elapsedMs: number;
  frame: unknown;
}

export interface RadioAuthRequest {
  requestId: string;
  imageId: string;
  token: string;
}

export type RadioAckStatus = 'APPLIED' | 'RECEIVED' | 'REJECTED' | 'UNSUPPORTED';

export interface RadioAck {
  version: number;
  requestId: string;
  imageId: string;
  sessionId: string;
  instanceId: string;
  bootId: string;
  epoch: number;
  sequence: number;
  status: RadioAckStatus;
  received: boolean;
  validated: boolean;
  reason: string | null;
  unsupportedFields: string[];
  appliedAt: string | null;
}

export interface RadioWireCodec {
  readonly name: string;
  encodeAuth(request: RadioAuthRequest): string;
  encodeApply(request: RadioApplyRequest): string;
  decodeAck(raw: string): RadioAck;
}

const string = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value || value.length > 200) throw new RadioWireError(`Radio acknowledgment field ${field} is invalid`);
  return value;
};
const integer = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RadioWireError(`Radio acknowledgment field ${field} is invalid`);
  return value as number;
};

/** Controller-side preview codec. Replaceable the moment the plugin protocol is delivered. */
export const previewRadioCodec: RadioWireCodec = {
  name: 'controller-preview-v1',
  encodeAuth: (request) => JSON.stringify({
    v: RADIO_WIRE_VERSION, type: 'radio.auth', requestId: request.requestId, imageId: request.imageId, token: request.token,
  }),
  encodeApply: (request) => JSON.stringify({
    v: RADIO_WIRE_VERSION, type: 'radio.apply', requestId: request.requestId,
    tenantId: request.identity.tenantId, imageId: request.identity.imageId, sessionId: request.identity.sessionId,
    instanceId: request.identity.instanceId, bootId: request.identity.bootId,
    datasetRevision: request.identity.datasetRevision, epoch: request.epoch,
    sequence: request.sequence, elapsedMs: request.elapsedMs, frame: request.frame,
  }),
  decodeAck(raw) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new RadioWireError('Radio acknowledgment was not valid JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RadioWireError('Radio acknowledgment was not an object');
    if (value.v !== RADIO_WIRE_VERSION) throw new RadioWireError('Radio acknowledgment used an incompatible protocol version');
    const status = value.status;
    if (status !== 'APPLIED' && status !== 'RECEIVED' && status !== 'REJECTED' && status !== 'UNSUPPORTED') {
      throw new RadioWireError('Radio acknowledgment status is not recognized');
    }
    const unsupported = Array.isArray(value.unsupportedFields)
      ? value.unsupportedFields.slice(0, 50).map((field) => string(field, 'unsupportedFields'))
      : [];
    return {
      version: RADIO_WIRE_VERSION,
      requestId: string(value.requestId, 'requestId'),
      imageId: string(value.imageId, 'imageId'),
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : '',
      instanceId: typeof value.instanceId === 'string' ? value.instanceId : '',
      bootId: typeof value.bootId === 'string' ? value.bootId : '',
      epoch: integer(value.epoch ?? 0, 'epoch'),
      sequence: integer(value.sequence ?? 0, 'sequence'),
      status,
      received: value.received === true,
      validated: value.validated === true,
      reason: typeof value.reason === 'string' ? value.reason.slice(0, 200) : null,
      unsupportedFields: unsupported,
      appliedAt: typeof value.appliedAt === 'string' ? value.appliedAt.slice(0, 40) : null,
    };
  },
};
