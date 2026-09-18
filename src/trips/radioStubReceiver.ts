import { createServer, type Server, type Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { RADIO_WIRE_VERSION } from './radioWire.js';

/**
 * Stub radio receiver.
 *
 * The real radio APK (A01) has not been delivered, so nothing on a phone can accept these frames
 * yet. This stand-in speaks the same wire format and enforces the same rules the controller relies
 * on — credential binding to one image, ownership epoch fencing and frame ordering — so the
 * delivery adapter and its failure states can be exercised. It is never started automatically and
 * must not be presented as evidence of on-phone behavior.
 */
export type StubBehavior = 'APPLIED' | 'RECEIVED' | 'REJECTED' | 'UNSUPPORTED' | 'SILENT';

export interface StubAppliedFrame {
  imageId: string;
  sessionId: string;
  epoch: number;
  sequence: number;
  elapsedMs: number;
  frame: unknown;
}

export interface StubReceiverOptions {
  imageId: string;
  token: string;
  instanceId: string;
  bootId: string;
  maxPayloadBytes?: number;
  behavior?(request: Record<string, unknown>): StubBehavior;
}

export interface StubRadioReceiver {
  readonly port: number;
  readonly applied: StubAppliedFrame[];
  readonly rejections: { reason: string; sequence: number; epoch: number }[];
  readonly authFailures: number;
  close(): Promise<void>;
}

const equalSecret = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export async function startStubRadioReceiver(options: StubReceiverOptions): Promise<StubRadioReceiver> {
  const maxPayloadBytes = options.maxPayloadBytes ?? 32768;
  const applied: StubAppliedFrame[] = [];
  const rejections: { reason: string; sequence: number; epoch: number }[] = [];
  const sockets = new Set<Socket>();
  let authFailures = 0;
  let appliedEpoch = 0;
  let sessionId = '';
  let lastSequence = -1;

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let authenticated = false;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > maxPayloadBytes * 2) { socket.destroy(); return; }
      let end = buffer.indexOf('\n');
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf('\n');
        let request: Record<string, unknown>;
        try { request = JSON.parse(line) as Record<string, unknown>; }
        catch { socket.destroy(); return; }
        const requestId = typeof request.requestId === 'string' ? request.requestId : '';
        const answer = (status: string, extra: Record<string, unknown> = {}) => {
          socket.write(`${JSON.stringify({ v: RADIO_WIRE_VERSION, type: 'radio.ack', requestId,
            imageId: options.imageId, instanceId: options.instanceId, bootId: options.bootId,
            sessionId: typeof request.sessionId === 'string' ? request.sessionId : '',
            epoch: typeof request.epoch === 'number' ? request.epoch : 0,
            sequence: typeof request.sequence === 'number' ? request.sequence : 0,
            status, received: true, validated: status !== 'REJECTED', reason: null, unsupportedFields: [], appliedAt: null,
            ...extra })}\n`);
        };
        const reject = (reason: string) => {
          rejections.push({ reason, sequence: Number(request.sequence ?? -1), epoch: Number(request.epoch ?? 0) });
          answer('REJECTED', { reason, validated: false });
        };

        if (request.v !== RADIO_WIRE_VERSION) { reject('UNSUPPORTED_VERSION'); continue; }
        if (request.type === 'radio.auth') {
          if (request.imageId !== options.imageId || typeof request.token !== 'string' || !equalSecret(request.token, options.token)) {
            authFailures += 1;
            answer('REJECTED', { reason: 'AUTH', validated: false });
            socket.destroy();
            return;
          }
          authenticated = true;
          answer('RECEIVED');
          continue;
        }
        if (!authenticated) { authFailures += 1; answer('REJECTED', { reason: 'UNAUTHENTICATED', validated: false }); socket.destroy(); return; }
        if (request.type !== 'radio.apply') { reject('UNSUPPORTED_TYPE'); continue; }
        if (Buffer.byteLength(line, 'utf8') > maxPayloadBytes) { reject('OVERSIZED'); continue; }
        if (request.imageId !== options.imageId) { reject('WRONG_IMAGE'); continue; }

        const epoch = Number(request.epoch);
        const sequence = Number(request.sequence);
        const session = String(request.sessionId ?? '');
        if (!Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(sequence) || sequence < 0) { reject('INVALID_IDENTITY'); continue; }
        // A worker whose lease expired keeps its old epoch; the newer owner's work is never overwritten.
        if (epoch < appliedEpoch) { reject('STALE_EPOCH'); continue; }
        if (epoch === appliedEpoch && session === sessionId && sequence <= lastSequence) { reject('LATE_FRAME'); continue; }

        const behavior = options.behavior?.(request) ?? 'APPLIED';
        if (behavior === 'SILENT') continue;
        if (behavior === 'REJECTED') { reject('DEVICE_REJECTED'); continue; }
        if (behavior === 'RECEIVED') { answer('RECEIVED'); continue; }
        if (behavior === 'UNSUPPORTED') { answer('UNSUPPORTED', { reason: 'UNSUPPORTED_FIELD', unsupportedFields: ['bluetooth'] }); continue; }

        appliedEpoch = epoch;
        sessionId = session;
        lastSequence = sequence;
        applied.push({ imageId: options.imageId, sessionId: session, epoch, sequence,
          elapsedMs: Number(request.elapsedMs ?? 0), frame: request.frame });
        answer('APPLIED', { appliedAt: new Date().toISOString() });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Stub radio receiver did not bind a port');
  return {
    port: address.port,
    applied,
    rejections,
    get authFailures() { return authFailures; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
