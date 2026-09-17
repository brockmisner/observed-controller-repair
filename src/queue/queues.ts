import { Queue } from "bullmq";
import type { RpaJobData, TelemetryJobData } from "../types.js";
import { producerConnection } from "./connection.js";
import { logger } from "../logger.js";

export const TELEMETRY_QUEUE = "telemetry-queue";
export const RPA_QUEUE = "rpa-task-queue";

export const telemetryQueue = new Queue<TelemetryJobData>(TELEMETRY_QUEUE, {
  connection: producerConnection,
  defaultJobOptions: {
    removeOnComplete: 200,
    removeOnFail: 200,
    attempts: 8,
    backoff: { type: "exponential", delay: 1000 },
  },
});

export const rpaQueue = new Queue<RpaJobData>(RPA_QUEUE, {
  connection: producerConnection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 100,
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
  },
});

for (const queue of [telemetryQueue, rpaQueue]) {
  queue.on("error", () => logger.warn({ queue: queue.name }, "Queue producer unavailable; durable RPA intents will retry"));
}

export async function closeQueues(): Promise<void> {
  // disconnect, unlike quit, does not wait indefinitely for an unavailable Redis.
  producerConnection.disconnect();
  await Promise.allSettled([telemetryQueue.close(), rpaQueue.close()]);
}
