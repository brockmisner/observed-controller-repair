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

/**
 * Identity carried on every radio write, so a frame can only apply to the phone, the code and the
 * run it was built for.
 *
 * The radio side is three artifacts. The `dplus` module does the injecting and has no process of
 * its own; the agent APK owns this control channel and the current frame; the GPS player is
 * untouched. Module, agent, boot and session are therefore four separate identities, and a change
 * in any of them means something different: new injecting code, a restarted receiver, a rebooted
 * phone, or a different run.
 */
export interface RadioIdentity {
  tenantId: string;
  imageId: string;
  /** `dplus` module that applies the frame, as `dplus dump` names it. */
  moduleName: string;
  moduleVersion: string;
  /** Agent APK that owns this control channel. */
  agentPackage: string;
  /** Agent process instance; a restarted agent invalidates the session. */
  agentInstanceId: string;
  /** Android boot identity, derived on the phone and distinct from the agent instance. */
  bootId: string;
  /** Run identity chosen by the controller. */
  sessionId: string;
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
  moduleName: string;
  moduleVersion: string;
  agentPackage: string;
  agentInstanceId: string;
  bootId: string;
  sessionId: string;
  epoch: number;
  sequence: number;
  status: RadioAckStatus;
  received: boolean;
  validated: boolean;
  /** Closed lowercase vocabulary, matching the player's control channel. */
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

/** The player's control channel uses 32 hex request ids and a closed `[a-z_]{1,80}` error set. */
export const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;
export const REASON_PATTERN = /^[a-z_]{1,80}$/;

/** An unrecognized reason is flattened rather than surfaced as free text, as the player does. */
const readReason = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && REASON_PATTERN.test(value) ? value : 'invalid_request';
};

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
    tenantId: request.identity.tenantId, imageId: request.identity.imageId,
    moduleName: request.identity.moduleName, moduleVersion: request.identity.moduleVersion,
    agentPackage: request.identity.agentPackage, agentInstanceId: request.identity.agentInstanceId,
    bootId: request.identity.bootId, sessionId: request.identity.sessionId,
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
    const requestId = string(value.requestId, 'requestId');
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new RadioWireError('Radio acknowledgment field requestId is invalid');
    const reported = (field: string) => typeof value[field] === 'string' ? (value[field] as string).slice(0, 200) : '';
    return {
      version: RADIO_WIRE_VERSION,
      requestId,
      imageId: string(value.imageId, 'imageId'),
      moduleName: reported('moduleName'),
      moduleVersion: reported('moduleVersion'),
      agentPackage: reported('agentPackage'),
      agentInstanceId: reported('agentInstanceId'),
      bootId: reported('bootId'),
      sessionId: reported('sessionId'),
      epoch: integer(value.epoch ?? 0, 'epoch'),
      sequence: integer(value.sequence ?? 0, 'sequence'),
      status,
      received: value.received === true,
      validated: value.validated === true,
      reason: readReason(value.reason),
      unsupportedFields: unsupported,
      appliedAt: typeof value.appliedAt === 'string' ? value.appliedAt.slice(0, 40) : null,
    };
  },
};
