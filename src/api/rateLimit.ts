interface KeyQueue {
  tail: Promise<void>;
  nextStartAt: number;
  pending: number;
  cleanup?: ReturnType<typeof setTimeout>;
}

export class KeyRateLimiter {
  private readonly queues = new Map<string, KeyQueue>();

  constructor(private readonly intervalMs = 1000) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("Rate limit interval must be positive");
    }
  }

  pending(keyFingerprint: string): number {
    return this.queues.get(keyFingerprint)?.pending ?? 0;
  }

  async run<T>(keyFingerprint: string, fn: () => Promise<T>): Promise<T> {
    const queue = this.queues.get(keyFingerprint) ?? { tail: Promise.resolve(), nextStartAt: 0, pending: 0 };
    this.queues.set(keyFingerprint, queue);
    clearTimeout(queue.cleanup);
    queue.pending += 1;
    const previous = queue.tail;
    let release!: () => void;
    queue.tail = new Promise<void>((resolve) => { release = resolve; });

    // Reserve the next turn synchronously so callers cannot race for a key.
    await previous;
    try {
      while (queue.nextStartAt > Date.now()) {
        await new Promise((resolve) => setTimeout(resolve, queue.nextStartAt - Date.now()));
      }
      queue.nextStartAt = Date.now() + this.intervalMs;
      return await fn();
    } finally {
      // Callbacks can perform asynchronous credential checks before the request.
      // A cooldown after completion preserves the provider limit in that case.
      queue.nextStartAt = Date.now() + this.intervalMs;
      queue.pending -= 1;
      release();
      if (queue.pending === 0) {
        queue.cleanup = setTimeout(() => {
          if (queue.pending === 0 && this.queues.get(keyFingerprint) === queue) {
            this.queues.delete(keyFingerprint);
          }
        }, Math.max(0, queue.nextStartAt - Date.now()));
        queue.cleanup.unref();
      }
    }
  }
}

// Shared across workspaces and key validation. Callers pass a fingerprint only.
export const duoPlusRateLimiter = new KeyRateLimiter(1100);
