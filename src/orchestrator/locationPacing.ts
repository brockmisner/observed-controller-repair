type Clock = { monotonic: () => number; wall: () => number };
type Timing = { lastDispatch: number | null; due: number };

// Wall timestamps restore a conservative cooldown; live intervals use a monotonic clock.
export class LocationPacing {
  private readonly timings = new Map<string, Timing>();

  constructor(private readonly intervalMs: number, private readonly clock: Clock = {
    monotonic: () => performance.now(), wall: () => Date.now(),
  }) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("GPS interval must be positive");
  }

  has(deviceId: string): boolean { return this.timings.has(deviceId); }

  restore(deviceId: string, dispatchedAt?: Date | null, completedAt?: Date | null): void {
    if (this.has(deviceId)) return;
    const now = this.clock.monotonic();
    const wall = this.clock.wall();
    const lastTime = dispatchedAt?.getTime();
    const endTime = completedAt?.getTime() ?? lastTime;
    this.timings.set(deviceId, {
      lastDispatch: lastTime === undefined ? null : now - Math.max(0, wall - lastTime),
      due: endTime === undefined ? now : now + Math.max(0, this.intervalMs - Math.max(0, wall - endTime)),
    });
  }

  isDue(deviceId: string): boolean { return (this.timings.get(deviceId)?.due ?? 0) <= this.clock.monotonic(); }

  isDueWithInterval(deviceId: string, intervalMs: number): boolean {
    const timing = this.timings.get(deviceId);
    return !timing || timing.due - this.intervalMs + intervalMs <= this.clock.monotonic();
  }

  intervalSinceDispatch(deviceId: string): number | null {
    const last = this.timings.get(deviceId)?.lastDispatch;
    return last == null ? null : Math.max(0, this.clock.monotonic() - last);
  }

  dispatched(deviceId: string): void {
    const now = this.clock.monotonic();
    this.timings.set(deviceId, { lastDispatch: now, due: now + this.intervalMs });
  }

  completed(deviceId: string): void {
    this.timings.set(deviceId, {
      lastDispatch: this.timings.get(deviceId)?.lastDispatch ?? null,
      due: this.clock.monotonic() + this.intervalMs,
    });
  }
}
