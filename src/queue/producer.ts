import { rpaQueue, telemetryQueue } from "./queues.js";
import type { RpaJobData, TelemetryJobData } from "../types.js";
import { producerConnection } from "./connection.js";

export async function enqueueTelemetry(data: TelemetryJobData, delayMs = 0): Promise<string> {
  if (producerConnection.status !== "ready") throw new Error("Queue producer is unavailable");
  const job = await telemetryQueue.add(
    "push-telemetry",
    data,
    {
      delay: delayMs,
      jobId: `tel-${data.deviceId}-${Date.now()}`,
    },
  );
  return job.id ?? "";
}

export async function enqueueRpa(data: RpaJobData, stillPending?: () => Promise<boolean>): Promise<string> {
  if (producerConnection.status !== "ready") throw new Error("Queue producer is unavailable");
  const existing = await rpaQueue.getJob(`rpa-${data.rpaJobId}`);
  if (existing) {
    const state = await existing.getState();
    if ((state === "failed" || state === "completed") && stillPending && await stillPending()) {
      // Redis and SQL can commit on opposite sides of a process failure. Only
      // a still-pending SQL intent permits retrying a retained terminal job.
      await existing.retry(state, { resetAttemptsMade: true, resetAttemptsStarted: true });
    }
    return existing.id ?? "";
  }
  const job = await rpaQueue.add("trigger-rpa", data, { jobId: `rpa-${data.rpaJobId}` });
  return job.id ?? "";
}
