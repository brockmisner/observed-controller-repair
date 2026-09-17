import type { PrismaClient, RpaJob } from "@prisma/client";
import { z } from "zod";
import { HttpError } from "../http/errors.js";
import { unresolvedRpaStatuses } from "./rpaDelivery.js";

interface Dependencies {
  db: PrismaClient;
  withLease<T>(deviceId: string, tenantId: string, work: (lease: { assertOwned(): Promise<void> }) => Promise<T>): Promise<T>;
}
async function dependencies(): Promise<Dependencies> {
  const [{ prisma }, { withTripLease }] = await Promise.all([import("../db.js"), import("../trips/lease.js")]);
  return { db: prisma, withLease: withTripLease };
}
const identity = z.string().trim().min(1).max(200);
const completionStatuses = ["submitted", "submitting", "unconfirmed"];
const resolvableStatuses = [...unresolvedRpaStatuses, "failed", "dry_run"];
const resolutionSchema = z.object({
  outcome: z.enum(["completed", "cancelled"]),
  evidence: z.string().trim().min(10).max(2000),
  providerIdleConfirmed: z.literal(true),
  expectedUpdatedAt: z.string().datetime(),
}).strict();

function publicJob(job: RpaJob) {
  return { id: job.id, name: job.name, templateId: job.templateId, status: job.status, error: job.error,
    createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString(),
    canResolve: resolvableStatuses.includes(job.status), canConfirmCompleted: completionStatuses.includes(job.status) };
}
async function ownedDevice(db: PrismaClient, deviceId: string, tenantId: string) {
  if (!identity.safeParse(deviceId).success || !identity.safeParse(tenantId).success ||
      !await db.device.count({ where: { id: deviceId, tenantId } })) throw new HttpError(404, "Device not found");
}

export async function listLegacyRpaJobs(deviceId: string, tenantId: string, deps?: Dependencies) {
  const { db } = deps ?? await dependencies();
  await ownedDevice(db, deviceId, tenantId);
  // Unresolved work must remain visible even if many newer resolved jobs exist.
  const [unresolved, history] = await Promise.all([
    db.rpaJob.findMany({ where: { deviceId, device: { tenantId }, status: { in: unresolvedRpaStatuses } }, orderBy: { createdAt: "asc" }, take: 100 }),
    db.rpaJob.findMany({ where: { deviceId, device: { tenantId }, status: { notIn: unresolvedRpaStatuses } }, orderBy: { createdAt: "desc" }, take: 25 }),
  ]);
  return { jobs: [...unresolved, ...history].map(publicJob) };
}

export async function resolveLegacyRpaJob(deviceId: string, tenantId: string, jobId: string, raw: unknown, deps?: Dependencies) {
  const parsed = resolutionSchema.safeParse(raw);
  if (!parsed.success || !identity.safeParse(jobId).success) throw new HttpError(400, "Confirm the provider is idle, provide evidence, and use the current job revision");
  const input = parsed.data;
  const { db, withLease } = deps ?? await dependencies();
  await ownedDevice(db, deviceId, tenantId);
  return withLease(deviceId, tenantId, async lease => {
    const job = await db.rpaJob.findFirst({ where: { id: jobId, deviceId, device: { tenantId } } });
    if (!job) throw new HttpError(404, "RPA job not found");
    if (job.updatedAt.toISOString() !== input.expectedUpdatedAt || !resolvableStatuses.includes(job.status)) {
      throw new HttpError(409, "RPA job changed. Refresh and review its latest state before resolving it.");
    }
    if (input.outcome === "completed" && !completionStatuses.includes(job.status)) {
      throw new HttpError(409, "This job has no recorded provider submission. Cancel its pending intent instead.");
    }
    await lease.assertOwned();
    const resolved = await db.$transaction(async tx => {
      const result = await tx.rpaJob.updateMany({ where: { id: job.id, deviceId, device: { tenantId }, status: job.status, updatedAt: job.updatedAt },
        data: { status: `resolved_${input.outcome}` } });
      if (result.count !== 1) throw new HttpError(409, "RPA job changed during resolution");
      // Preserve the original job/error and a separate durable audit trail. This
      // records an operator attestation, never invented provider verification.
      await tx.deviceEvent.create({ data: { deviceId, kind: "LEGACY_RPA_RESOLVED", detail: JSON.stringify({
        jobId, tenantId, previousStatus: job.status, previousError: job.error,
        outcome: input.outcome, evidence: input.evidence, providerIdleConfirmed: true,
        verification: "OPERATOR_ATTESTATION", resolvedAt: new Date().toISOString(),
      }) } });
      return tx.rpaJob.findUniqueOrThrow({ where: { id: job.id } });
    });
    return { job: publicJob(resolved) };
  });
}
