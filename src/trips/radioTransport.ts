import { createConnection, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { RadioWireCodec } from './radioWire.js';

/**
 * Radio transport (B03). Newline-framed JSON over a loopback socket that ADB forwards to one
 * image's own radio port. It is deliberately dumb: identity, ownership and result meaning belong
 * to the delivery adapter, and the payload shape belongs to the wire codec.
 */
export type RadioTransportFailure = 'TIMEOUT' | 'UNREACHABLE' | 'CLOSED' | 'OVERSIZED_RESPONSE';

export class RadioTransportError extends Error {
  /** Whether the frame reached the socket. A frame that was never written cannot have applied. */
  constructor(readonly failure: RadioTransportFailure, message: string, readonly wrote = false) { super(message); }
}

export interface RadioTransport {
  send(payload: string, timeoutMs: number): Promise<string>;
  close(): void;
}

export interface LineRadioTransportOptions {
  connect(): Promise<Socket>;
  /** Runs once per connection, before any frame is sent. Used for the credential handshake. */
  handshake?(send: (payload: string, timeoutMs: number) => Promise<string>): Promise<void>;
  maxResponseBytes?: number;
}

export class LineRadioTransport implements RadioTransport {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private pending?: { resolve(line: string): void; reject(error: Error): void; timer: NodeJS.Timeout; wrote: boolean };
  private opening?: Promise<Socket>;
  private closed = false;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: LineRadioTransportOptions) {
    this.maxResponseBytes = options.maxResponseBytes ?? 131072;
  }

  private fail(failure: RadioTransportFailure, message: string): void {
    const pending = this.pending;
    this.pending = undefined;
    this.buffer = Buffer.alloc(0);
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    if (pending) { clearTimeout(pending.timer); pending.reject(new RadioTransportError(failure, message, pending.wrote)); }
  }

  private attach(socket: Socket): void {
    socket.setNoDelay(true);
    socket.on('data', (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > this.maxResponseBytes) return this.fail('OVERSIZED_RESPONSE', 'Radio response exceeded its size limit');
      const end = this.buffer.indexOf(10);
      if (end < 0) return;
      const line = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      const pending = this.pending;
      this.pending = undefined;
      if (pending) { clearTimeout(pending.timer); pending.resolve(line); }
    });
    socket.on('error', () => this.fail('UNREACHABLE', 'Radio receiver connection failed'));
    socket.on('close', () => this.fail('CLOSED', 'Radio receiver closed the connection'));
  }

  private async ensure(): Promise<Socket> {
    if (this.closed) throw new RadioTransportError('CLOSED', 'Radio transport is closed');
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (!this.opening) {
      this.opening = (async () => {
        const socket = await this.options.connect();
        this.attach(socket);
        this.socket = socket;
        if (this.options.handshake) await this.options.handshake((payload, timeoutMs) => this.write(socket, payload, timeoutMs));
        return socket;
      })().catch((error) => {
        this.socket = undefined;
        throw error instanceof RadioTransportError ? error : new RadioTransportError('UNREACHABLE', 'Radio receiver is unreachable');
      }).finally(() => { this.opening = undefined; });
    }
    return this.opening;
  }

  private write(socket: Socket, payload: string, timeoutMs: number): Promise<string> {
    if (this.pending) return Promise.reject(new RadioTransportError('CLOSED', 'Radio transport is already waiting for a response'));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.fail('TIMEOUT', 'Radio receiver did not answer in time'), timeoutMs);
      const pending = { resolve, reject, timer, wrote: false };
      this.pending = pending;
      socket.write(`${payload}\n`, (error) => {
        if (error) this.fail('UNREACHABLE', 'Radio frame could not be written');
        else pending.wrote = true;
      });
    });
  }

  async send(payload: string, timeoutMs: number): Promise<string> {
    const socket = await this.ensure();
    return this.write(socket, payload, timeoutMs);
  }

  close(): void {
    this.closed = true;
    this.fail('CLOSED', 'Radio transport closed');
  }
}

export interface AuthenticatedRadioTransportOptions {
  imageId: string;
  codec: RadioWireCodec;
  connect(): Promise<Socket>;
  credential(): Promise<string>;
  requestId?(): string;
  handshakeTimeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * Binds the connection to one image's credential before any frame can be sent, so a radio write
 * cannot reach a phone this controller is not authorized to drive.
 */
export function createAuthenticatedRadioTransport(options: AuthenticatedRadioTransportOptions): RadioTransport {
  const nextRequestId = options.requestId ?? (() => randomBytes(16).toString('hex'));
  const timeoutMs = options.handshakeTimeoutMs ?? 5000;
  return new LineRadioTransport({
    connect: options.connect,
    maxResponseBytes: options.maxResponseBytes,
    async handshake(send) {
      const requestId = nextRequestId();
      const token = await options.credential();
      const raw = await send(options.codec.encodeAuth({ requestId, imageId: options.imageId, token }), timeoutMs);
      let ack;
      try { ack = options.codec.decodeAck(raw); }
      catch { throw new RadioTransportError('CLOSED', 'The radio receiver returned an unreadable authentication response'); }
      if (ack.requestId !== requestId || ack.imageId !== options.imageId || ack.status === 'REJECTED') {
        throw new RadioTransportError('CLOSED', 'The phone rejected this radio credential');
      }
    },
  });
}

export function connectLoopback(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = (error?: Error) => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
      if (error) { socket.destroy(); reject(new RadioTransportError('UNREACHABLE', 'Radio receiver is unreachable')); }
      else resolve(socket);
    };
    const onConnect = () => settle();
    const onError = () => settle(new Error('connect failed'));
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}
