import { assertNoWarmup } from "../warmup/service.js";
import { UnrecoverableError, Worker } from "bullmq";
import { triggerRpaTask } from "../api/duoPlusClient.js";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { KeyDeadError, RateLimitError, type RpaJobData } from "../types.js";
import { redisConnection } from "./connection.js";
import { RPA_QUEUE } from "./queues.js";
import { withTripLease } from "../trips/lease.js";
import { withEnvironmentWindow } from "../orchestrator/deviceOperations.js";

export function startRpaWorker(): Worker<RpaJobData> {
  const worker = new Worker<RpaJobData>(
    RPA_QUEUE,
    async (job) => {
      if (!job.data.rpaJobId || !job.data.tenantId) {
        throw new UnrecoverableError("Legacy RPA queue item has no workspace or job identity; submit a new job");
      }
      const row = await prisma.rpaJob.findFirst({
        where: { id: job.data.rpaJobId, deviceId: job.data.deviceId, templateId: job.data.templateId,
          device: { tenantId: job.data.tenantId } },
      });
      if (!row) throw new UnrecoverableError("RPA job not found in workspace");
      if (row.status === "submitted" || row.status === "dry_run") return;
      if (row.status !== "queued") {
        throw new UnrecoverableError("RPA job is not queued; inspect its previous submission before creating another job");
      }
      let dispatched = false;
      const currentDevice = async () => {
        const current = await prisma.device.findFirst({ where: { id: job.data.deviceId, tenantId: job.data.tenantId } });
        if (current) await assertNoWarmup(current.id);
        if (!current || current.imageId !== job.data.imageId) throw new UnrecoverableError("RPA phone identity changed; submit a new job");
        if (await prisma.site.count({ where: { deviceId: current.id } })) throw new UnrecoverableError("A client owns this phone; legacy RPA submission is blocked");
        const now = Date.now();
        if (!current.active || current.phase === "EXPIRED" || current.campaignEnd.getTime() <= now) {
          throw new Error("RPA phone is inactive or its campaign has expired");
        }
        const observedAt = current.lastPowerSyncAt?.getTime();
        if (!current.poweredOn || current.duoPlusStatus !== 1 || observedAt === undefined ||
            observedAt > now || observedAt < now - config.powerStatusMaxAgeMs) {
          throw new Error("RPA requires a fresh DuoPlus ON observation");
        }
        return current;
      };
      try {
        const device = await currentDevice();
        await withTripLease(device.id, device.tenantId, (lease) => withEnvironmentWindow(device.id, async () => {
          await triggerRpaTask(device.imageId, job.data.templateId, job.data.variables, {
            name: job.data.name,
            templateType: job.data.templateType,
            issueAt: job.data.issueAt,
            tenantId: device.tenantId,
            requireAcceptance: true,
            beforeSend: async () => {
              await lease.assertOwned();
              await currentDevice();
              // Key failover only follows explicit authentication/rate-limit rejections.
              if (dispatched) return;
              const reserved = await prisma.rpaJob.updateMany({
                where: { id: row.id, status: "queued" }, data: { status: "submitting", error: null },
              });
              if (reserved.count !== 1) throw new UnrecoverableError("RPA job was already claimed; inspect its submission before retrying");
              dispatched = true;
            },
          });
          await prisma.rpaJob.update({
            where: { id: row.id },
            data: { status: config.dryRun ? "dry_run" : "submitted", error: null },
          });
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (dispatched && !(err instanceof RateLimitError || err instanceof KeyDeadError)) {
          await prisma.rpaJob.update({ where: { id: row.id }, data: { status: "unconfirmed",
            error: "Submission may have reached DuoPlus. Inspect the provider before submitting another job." } });
          throw new UnrecoverableError("RPA submission is unconfirmed; automatic retry stopped");
        }
        const exhausted = err instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        await prisma.rpaJob.updateMany({ where: { id: row.id, status: dispatched ? { in: ["queued", "submitting"] } : "queued" },
          data: { status: err instanceof RateLimitError || !exhausted ? "queued" : "failed", error: message } });
        if (err instanceof RateLimitError) {
          await worker.rateLimit(err.retryAfterMs);
          throw Worker.RateLimitError();
        }
        throw err;
      }
    },
    {
      connection: redisConnection,
      concurrency: 1,
      limiter: { max: 1, duration: 1000 },
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "rpa job failed");
  });

  return worker;
}
