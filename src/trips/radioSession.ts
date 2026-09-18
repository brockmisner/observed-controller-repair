import { RadioDeliveryAdapter } from './radioDelivery.js';
import { previewRadioCodec, type RadioIdentity, type RadioWireCodec } from './radioWire.js';
import type { RadioTransport } from './radioTransport.js';
import { players, type PlayerGateway } from './playerConnection.js';
import {
  authorizeImageWriter, defaultLeaseClient, prismaImageOwnershipStore, withPhysicalImageLease,
  type ImageOwnership, type ImageOwnershipStore,
} from './imageOwnership.js';

/**
 * Radio delivery sessions bound to one owned physical image (B03 + B08).
 *
 * Opening a session requires workspace authorization for the image and the physical-image lease
 * that GPS work already uses, so radio state can never be written by a second competing job.
 */
export interface RadioSessionIdentity {
  tenantId: string;
  imageId: string;
  sessionId: string;
  instanceId: string;
  bootId: string;
  datasetRevision: string;
}

export interface OpenRadioDeliveryOptions {
  identity: RadioSessionIdentity;
  ownership: ImageOwnership;
  store?: ImageOwnershipStore;
  gateway?: PlayerGateway;
  codec?: RadioWireCodec;
  /** Supplied by tests and dev harnesses that stand in for the undelivered radio APK. */
  transport?: RadioTransport;
  timeoutMs?: number;
  maxPayloadBytes?: number;
}

export interface RadioDeliverySession {
  adapter: RadioDeliveryAdapter;
  identity: RadioIdentity;
  close(): Promise<void>;
}

export async function openRadioDelivery(options: OpenRadioDeliveryOptions): Promise<RadioDeliverySession> {
  const { identity, ownership } = options;
  if (identity.imageId !== ownership.imageId) throw new Error('Radio delivery identity does not match the owned image');
  await authorizeImageWriter(identity.tenantId, identity.imageId, options.store ?? prismaImageOwnershipStore);
  await ownership.assertOwned();
  const codec = options.codec ?? previewRadioCodec;
  const opened = options.transport
    ? { transport: options.transport, close: async () => { options.transport!.close(); } }
    : await (options.gateway ?? players).openRadioTransport(identity.imageId, codec);
  const adapter = new RadioDeliveryAdapter({
    identity: { ...identity },
    ownership,
    transport: opened.transport,
    codec,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: options.maxPayloadBytes }),
  });
  return {
    adapter,
    identity: { ...identity },
    async close() { adapter.close('Radio session closed'); await opened.close(); },
  };
}

/**
 * Standalone radio lifecycle work that is not already running inside a trip lease. Callers that
 * hold `withTripLease` must pass that ownership to `openRadioDelivery` instead: the physical-image
 * lease is not reentrant, by design.
 */
export async function withOwnedRadioDelivery<T>(
  options: Omit<OpenRadioDeliveryOptions, 'ownership'> & { leaseWaitMs?: number },
  work: (session: RadioDeliverySession) => Promise<T>,
): Promise<T> {
  const client = await defaultLeaseClient();
  return withPhysicalImageLease(options.identity.imageId, client, async (ownership) => {
    const session = await openRadioDelivery({ ...options, ownership });
    try { return await work(session); }
    finally { await session.close(); }
  }, options.leaseWaitMs === undefined ? {} : { waitMs: options.leaseWaitMs });
}
