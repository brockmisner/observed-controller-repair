import { rpaQueue, telemetryQueue } from "./queues.js";
import type { RpaJobData, TelemetryJobData } from "../types.js";

export async function enqueueTelemetry(data: TelemetryJobData, delayMs = 0): Promise<string> {
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

export async function enqueueRpa(data: RpaJobData): Promise<string> {
  const job = await rpaQueue.add("trigger-rpa", data);
  return job.id ?? "";
}
