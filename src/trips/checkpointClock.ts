/** REST checkpoints stop while waiting for the phone; they are not a streaming clock. */
export function checkpointAdvanceMs(now: number, previous: number | undefined, intervalMs: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(intervalMs) || intervalMs <= 0 ||
      (previous !== undefined && !Number.isFinite(previous))) throw new Error("Invalid checkpoint clock");
  if (previous === undefined) return 0;
  return Math.min(intervalMs, Math.max(0, now - previous));
}
