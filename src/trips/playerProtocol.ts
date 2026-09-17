import { randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

export interface PlayerStatus {
  ok: boolean; id: string; instance_id: string; session_id: string; state: string;
  applied_seq: number; received_bytes: number; cleanup_ok: boolean; error: string;
  framework_observed_seq: number; fused_observed_seq: number;
  skipped_samples: number; max_lateness_ms: number; observer_mismatches: number;
  [key: string]: unknown;
}
export const terminal = (s: PlayerStatus) => ['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(s.state);
export class PlayerSocket {
  private buffer = Buffer.alloc(0);
  private pending?: { id: string; resolve(s: PlayerStatus): void; reject(e: Error): void; timer: NodeJS.Timeout };
  private instance?: string;
  private constructor(private socket: Socket) {
    socket.setNoDelay(true);
    socket.on('data', data => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > 131072) return this.fail('Player response exceeded size limit');
      const end = this.buffer.indexOf(10);
      if (end < 0) return;
      try {
        const s = JSON.parse(this.buffer.subarray(0, end).toString('utf8')) as PlayerStatus;
        this.buffer = this.buffer.subarray(end + 1);
        const p = this.pending;
        if (!p || s.id !== p.id || s.ok !== true || typeof s.instance_id !== 'string' ||
            typeof s.state !== 'string' || typeof s.session_id !== 'string' ||
            !Number.isInteger(s.applied_seq) || typeof s.cleanup_ok !== 'boolean') throw new Error();
        if (this.instance && this.instance !== s.instance_id) throw new Error();
        this.instance = s.instance_id;
        clearTimeout(p.timer); this.pending = undefined; p.resolve(s);
      } catch { this.fail('Player rejected the command or returned an invalid response'); }
    });
    socket.on('error', () => this.fail('Player connection failed'));
    socket.on('close', () => this.fail('Player connection closed'));
  }
  private fail(message: string) {
    const p = this.pending; this.pending = undefined;
    if (p) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.socket.destroy();
  }
  static async connect(port: number, token: string): Promise<PlayerSocket> {
    const socket = createConnection({ host: '127.0.0.1', port });
    const client = new PlayerSocket(socket);
    try {
      await client.request({ op: 'auth', token, version: 1 });
      return client;
    } catch (error) { client.close(); throw error; }
  }
  request(body: Record<string, unknown>): Promise<PlayerStatus> {
    if (this.pending || this.socket.destroyed) return Promise.reject(new Error('Player connection unavailable'));
    const id = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('Player command timed out'), 7000);
      this.pending = { id, resolve, reject, timer };
      this.socket.write(JSON.stringify({ ...body, id }) + '\n');
    });
  }
  close() { this.fail('Player connection closed'); }
}
