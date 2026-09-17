import { Queue } from "bullmq";
import type { RpaJobData, TelemetryJobData } from "../types.js";
import { redisConnection } from "./connection.js";

export const TELEMETRY_QUEUE = "telemetry-queue";
export const RPA_QUEUE = "rpa-task-queue";

export const telemetryQueue = new Queue<TelemetryJobData>(TELEMETRY_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 200,
    removeOnFail: 200,
    attempts: 8,
    backoff: { type: "exponential", delay: 1000 },
  },
});

export const rpaQueue = new Queue<RpaJobData>(RPA_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 100,
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
  },
});
