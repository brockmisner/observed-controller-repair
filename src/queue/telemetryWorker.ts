import { DelayedError, Worker } from "bullmq";
import { keyPool } from "../api/keyPool.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { HttpError } from "../http/errors.js";
import { reserveMovement } from "../orchestrator/deviceOperations.js";
import { dispatchGps, gpsEligibility, gpsIsDue } from "../orchestrator/locationDispatch.js";
import { RateLimitError, type TelemetryJobData } from "../types.js";
import { redisConnection } from "./connection.js";
import { TELEMETRY_QUEUE } from "./queues.js";

export function startTelemetryWorker(): Worker<TelemetryJobData> {
  const limiterMax = Math.max(1, keyPool.size());

  const worker = new Worker<TelemetryJobData>(
    TELEMETRY_QUEUE,
    async (job, token) => {
      const release = reserveMovement(job.data.deviceId);
      if (!release) return;
      try {
        const device = await prisma.device.findFirst({ where: { id: job.data.deviceId, tenantId: job.data.tenantId } });
        if (!device || !device.active) return;
        if (device.phase === "EXPIRED" || device.campaignEnd <= new Date()) {
          await prisma.device.update({ where: { id: device.id }, data: { phase: "EXPIRED", active: false } });
          return;
        }
        const current = await prisma.device.findFirst({ where: { ...gpsEligibility(device.tenantId, [device.id]), phase: "NAVIGATING" } });
        if (!current || !await gpsIsDue(device.id)) return;
        try {
          await dispatchGps([{ device: current, proposed: current }], "QUEUE");
        } catch (err) {
          if (err instanceof HttpError && err.status === 409) return;
          if (err instanceof RateLimitError) {
            await worker.rateLimit(err.retryAfterMs);
            throw new DelayedError();
          }
          throw err;
        }
      } finally {
        release();
      }
    },
    {
      connection: redisConnection,
      concurrency: limiterMax,
      limiter: {
        max: limiterMax,
        duration: 1000,
      },
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "telemetry job failed");
  });
  worker.on("completed", (job) => {
    logger.debug({ jobId: job.id, deviceId: job.data.deviceId }, "telemetry job completed");
  });

  return worker;
}
