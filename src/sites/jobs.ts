import { randomBytes, timingSafeEqual } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { z } from "zod";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { HttpError } from "../http/errors.js";
import { hashToken } from "../security/crypto.js";
import { triggerRpaTask, getDeviceStatus } from "../api/duoPlusClient.js";
import { checkDevicePower } from "../orchestrator/powerCheck.js";
import { withEnvironmentWindow } from "../orchestrator/deviceOperations.js";
import { withTripLease } from "../trips/lease.js";
import { redisConnection } from "../queue/connection.js";
import { assertSiteJobReady, siteCallbackBase, siteIssueAt } from "./readiness.js";
import { busyJobStates, ownSite, parseJson, profileProblems, providerSnapshot, refreshSite,
  serializeJob, serializeResult, type StoredSiteProfile } from "./service.js";

const queueName = "observatory-site-jobs";
const resultLifetimeMs = 30 * 60_000;
const resultSchema = z.object({
  rank: z.number().int().min(1).max(10000).nullable(), raw: z.record(z.unknown()).refine((value) => Object.keys(value).length > 0, "Raw result must contain a reported measurement"),
  evidenceUrl: z.string().url().max(2048).refine((value) => {
    const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password;
  }, "Evidence must be an HTTPS URL without credentials").optional(),
  capturedAt: z.string().datetime({ offset: true }),
}).strict();

export async function runSiteJob(id: string): Promise<void> {
  const initial = await prisma.siteJob.findUnique({ where: { id } });
  if (!initial || initial.status !== "QUEUED" || initial.scheduledAt > new Date()) return;
  const found = await ownSite(initial.tenantId, initial.siteId);
  await withTripLease(found.deviceId, found.tenantId, (lease) => withEnvironmentWindow(found.deviceId, async () => {
    const job = await prisma.siteJob.findUniqueOrThrow({ where: { id } });
    if (job.status !== "QUEUED") return;
    if (await prisma.siteJob.count({ where: { siteId: found.id, id: { not: id }, status: { in: busyJobStates } } })) return;
    const claim = await prisma.siteJob.updateMany({ where: { id, status: "QUEUED" }, data: { status: "PREFLIGHT", startedAt: new Date() } });
    if (!claim.count) return;
    let submitted = false;
    try {
      assertSiteJobReady(process.env, config.dryRun);
      const site = await ownSite(job.tenantId, job.siteId);
      if (!site.enabled || site.profileStatus !== "PROVIDER_MATCH" || !site.templateId) throw new HttpError(409, "Client jobs are disabled, template missing, or profile needs review");
      if (site.device.activeTripId || site.device.campaignEnd <= new Date() || site.device.phase === "EXPIRED") throw new HttpError(409, "Client phone is unavailable or expired");
      if (job.motion !== "STILL") throw new HttpError(409, "This tracker worker supports stationary client measurements only");
      const profile = parseJson<StoredSiteProfile>(site.profileJson);
      if (!profile?.wifi || !profile.baseline) throw new HttpError(409, "Client profile is incomplete");
      const base = siteCallbackBase();
      const power = await checkDevicePower(site.deviceId, site.tenantId);
      if (!power.poweredOn || power.duoPlusStatus !== 1) throw new HttpError(409, "The client phone is not confirmed ON; no RPA task was sent");
      const observed = providerSnapshot(await getDeviceStatus(site.device.imageId, site.tenantId), site.device.imageId);
      const problems = profileProblems(site, profile, observed, true);
      if (problems.length) throw new HttpError(409, problems.join("; "));
      // Schedule after readback, on the next full minute plus one; never truncate into the past.
      const executionAt = new Date((Math.floor(Date.now() / 60_000) + 2) * 60_000);
      const scheduledIssue = siteIssueAt(executionAt);
      const accepted = await prisma.locationRequest.findFirst({ where: { deviceId: site.deviceId, tenantId: site.tenantId, status: "API_ACCEPTED" }, orderBy: { acceptedAt: "desc" } });
      const preflight = {
        siteId: site.id, imageId: site.device.imageId, profileRevision: site.profileRevision,
        checkedAt: new Date().toISOString(), requested: { type: 2, lat: site.lat, lng: site.lng, elevationM: site.elevationM, state: "STILL", modeledSpeedMps: 0 },
        apiAcceptance: accepted ? { requestId: accepted.id, lat: accepted.lat, lng: accepted.lng, acceptedAt: accepted.acceptedAt } : null,
        provider: observed,
        androidObservation: null,
        wifi: { name: profile.wifi.ssid, bssid: profile.wifi.bssid, phoneMac: profile.phoneWifiMac },
        cell: { selected: profile.cell, applied: false }, bluetooth: { applied: false },
        motionSource: "CONTROLLER_MODEL", egressSource: "PROVIDER_PROFILE_NOT_MEASURED_EGRESS",
        executionScheduledAt: executionAt.toISOString(), schedulerTimezone: process.env.SITE_RPA_TIMEZONE,
        warnings: ["Provider configuration is not an Android observation", "GPS type is requested; /info may not return it", "Preflight precedes execution; the RPA template must record the capture-time device state", "Proxy geolocation does not verify a ZIP or a building"],
      };
      const token = randomBytes(32).toString("base64url");
      await prisma.siteJob.update({ where: { id }, data: { preflightJson: JSON.stringify(preflight),
        callbackTokenHash: hashToken(token), callbackExpiresAt: new Date(executionAt.getTime() + resultLifetimeMs) } });
      const response = await triggerRpaTask(site.device.imageId, site.templateId, {
        site_id: site.id, job_id: id, keyword: job.keyword, app: job.app,
        latitude: site.lat, longitude: site.lng, expected_ssid: profile.wifi.ssid, expected_bssid: profile.wifi.bssid,
        result_url: `${base}/api/site-jobs/${encodeURIComponent(id)}/callback`, result_token: token,
      }, { name: `site-${site.id}-job-${id}`, templateType: site.templateType === 1 ? 1 : 2,
        issueAt: scheduledIssue, tenantId: site.tenantId, requireAcceptance: true,
        beforeSend: async () => {
          await lease.assertOwned();
          if (submitted) throw new HttpError(409, "RPA submission is uncertain; it will not be replayed on another key");
          if (executionAt.getTime() - Date.now() < 15_000) throw new HttpError(409, "The RPA issue time expired while waiting; no task was sent");
          const current = await ownSite(site.tenantId, site.id);
          const powerAge = Date.now() - (current.device.lastPowerSyncAt?.getTime() ?? 0);
          if (!current.enabled || current.profileRevision !== site.profileRevision || current.device.duoPlusStatus !== 1 ||
              !current.device.poweredOn || powerAge < 0 || powerAge > config.powerStatusMaxAgeMs ||
              Date.now() - Date.parse(observed.capturedAt) > 30_000) throw new HttpError(409, "Client preflight expired or changed while waiting to submit");
          const dispatched = await prisma.siteJob.updateMany({ where: { id, status: "PREFLIGHT" }, data: { status: "SUBMITTING" } });
          if (!dispatched.count) throw new HttpError(409, "Tracker job no longer owns this submission");
          submitted = true;
        },
      });
      // A 200 only schedules the task. The result callback is the completion boundary.
      await prisma.siteJob.updateMany({ where: { id, status: "SUBMITTING" }, data: { status: "AWAITING_RESULT",
        providerResponseJson: JSON.stringify({ source: "DUOPLUS_TASK_ACCEPTANCE", acceptedAt: new Date().toISOString(),
          envelopeAccepted: true, responsePresent: response != null }) } });
    } catch (error) {
      await prisma.siteJob.updateMany({ where: { id, status: { in: ["PREFLIGHT", "SUBMITTING"] } }, data: {
        status: submitted ? "UNCONFIRMED" : "BLOCKED",
        error: error instanceof HttpError ? error.message : submitted ? "RPA acceptance is unknown. No automatic retry; inspect DuoPlus." : "Preflight failed; no RPA task was sent",
        ...(submitted ? {} : { completedAt: new Date(), callbackTokenHash: null, callbackExpiresAt: null }),
      } });
    }
  }));
}

export async function saveSiteResult(id: string, input: unknown, auth: { tenantId: string } | { token: string }) {
  const result = resultSchema.parse(input);
  const job = await prisma.siteJob.findUnique({ where: { id }, include: { result: true, site: true } });
  if (!job) throw new HttpError(404, "Job not found");
  const manual = "tenantId" in auth;
  if (manual) {
    if (job.tenantId !== auth.tenantId || job.site.tenantId !== auth.tenantId) throw new HttpError(404, "Job not found");
  } else {
    const supplied = Buffer.from(hashToken(auth.token)), stored = Buffer.from(job.callbackTokenHash ?? "");
    if (!stored.length || supplied.length !== stored.length || !timingSafeEqual(supplied, stored) || !job.callbackExpiresAt || job.callbackExpiresAt < new Date()) {
      throw new HttpError(401, "Invalid or expired job result credential");
    }
  }
  const capturedAt = new Date(result.capturedAt);
  if (!job.startedAt || capturedAt < job.startedAt || capturedAt.getTime() > Date.now() + 5000) throw new HttpError(400, "Capture timestamp must follow this job's start and not be in the future");
  const rawJson = JSON.stringify(result.raw);
  if (Buffer.byteLength(rawJson) > 1_000_000) throw new HttpError(413, "Raw result exceeds 1 MB");
  if (job.result) {
    if (job.result.rank !== result.rank || job.result.rawJson !== rawJson || job.result.capturedAt.getTime() !== capturedAt.getTime() || job.result.evidenceUrl !== (result.evidenceUrl ?? null)) {
      throw new HttpError(409, "This job already has a different immutable result");
    }
    return serializeResult(job.result);
  }
  if (!["SUBMITTING", "AWAITING_RESULT", "UNCONFIRMED", "TIMED_OUT"].includes(job.status)) throw new HttpError(409, "Job is not awaiting a submitted tracker result");
  const executionTime = z.string().datetime({ offset: true }).safeParse(parseJson<{ executionScheduledAt?: unknown }>(job.preflightJson)?.executionScheduledAt);
  const executionAt = executionTime.success ? new Date(executionTime.data) : null;
  if (!executionAt || !Number.isFinite(executionAt.getTime()) || executionAt < job.startedAt) {
    throw new HttpError(409, "Job has no valid recorded execution schedule; inspect the remote task before resolving it");
  }
  if (capturedAt < executionAt) throw new HttpError(400, "Capture timestamp must be at or after this job's scheduled execution");
  const row = await prisma.$transaction(async (tx) => {
    const claimed = await tx.siteJob.updateMany({ where: { id, tenantId: job.tenantId, status: job.status }, data: { status: "COMPLETED", completedAt: new Date(), error: null } });
    if (!claimed.count) throw new HttpError(409, "Job changed while saving result; reload before retrying");
    return tx.siteResult.create({ data: { jobId: id, rank: result.rank, rawJson, evidenceUrl: result.evidenceUrl,
      capturedAt, source: manual ? "MANUAL_IMPORT" : "RPA_CALLBACK",
      provenanceJson: JSON.stringify({ site: { id: job.site.id, name: job.site.name, lat: job.site.lat, lng: job.site.lng },
        keyword: job.keyword, app: job.app, preflight: parseJson(job.preflightJson),
        captureState: "TRACKER_REPORTED_NOT_INDEPENDENTLY_VERIFIED", receivedAt: new Date().toISOString() }) } });
  });
  return serializeResult(row);
}
export async function listSiteResults(tenantId: string, keyword?: string, app?: "chrome" | "maps" | "tracker") {
  const rows = await prisma.siteResult.findMany({ where: { job: { tenantId, ...(keyword ? { keyword } : {}), ...(app ? { app } : {}) } },
    include: { job: { include: { site: { select: { id: true, name: true, lat: true, lng: true } } } } }, orderBy: { capturedAt: "desc" }, take: 1000 });
  return { results: rows.map(({ job, ...row }) => ({ ...serializeResult(row), site: job.site, keyword: job.keyword, app: job.app })) };
}
export async function resolveSiteJob(tenantId: string, id: string) {
  const job = await prisma.siteJob.findFirst({ where: { id, tenantId } });
  if (!job) throw new HttpError(404, "Job not found");
  const site = await ownSite(tenantId, job.siteId);
  return withTripLease(site.deviceId, tenantId, async () => {
    const changed = await prisma.siteJob.updateMany({ where: { id, tenantId, status: { in: ["UNCONFIRMED", "TIMED_OUT"] } }, data: {
      status: "CANCELLED", error: "Operator confirmed the remote task stopped or completed; no result recorded",
      completedAt: new Date(), callbackTokenHash: null, callbackExpiresAt: null,
    } });
    if (!changed.count) throw new HttpError(409, "Only uncertain or timed-out jobs can be resolved here");
    return serializeJob(await prisma.siteJob.findUniqueOrThrow({ where: { id } }));
  });
}
export async function recoverSiteWork() {
  await prisma.site.updateMany({ where: { profileStatus: "APPLYING" }, data: { profileStatus: "UNCONFIRMED", enabled: false,
    profileError: "Controller restarted during apply. Review provider state before preparing again." } });
  await prisma.siteJob.updateMany({ where: { status: "PREFLIGHT" }, data: { status: "BLOCKED", completedAt: new Date(), error: "Controller restarted during preflight; no automatic replay" } });
  await prisma.siteJob.updateMany({ where: { status: "SUBMITTING" }, data: { status: "UNCONFIRMED", error: "Controller restarted during submission; inspect DuoPlus before resolving" } });
}
export function startSitePlanner() {
  const queue = new Queue<{ id: string }>(queueName, { connection: redisConnection });
  const worker = new Worker<{ id: string }>(queueName, async (job) => {
    try { await runSiteJob(job.data.id); }
    catch (error) { logger.warn({ jobId: job.data.id, message: error instanceof HttpError ? error.message : "Coordination unavailable" }, "site job dispatch deferred"); }
  }, { connection: redisConnection, concurrency: 1 });
  worker.on("error", (error) => logger.error({ message: error.message }, "site worker connection error"));
  let active: Promise<void> | undefined;
  const scan = async () => {
    await prisma.siteJob.updateMany({ where: { status: "AWAITING_RESULT", callbackExpiresAt: { lt: new Date() } },
      data: { status: "TIMED_OUT", error: "No result received before deadline; task completion is unknown", completedAt: new Date() } });
    const due = await prisma.siteJob.findMany({ where: { status: "QUEUED", scheduledAt: { lte: new Date() },
      site: { jobs: { none: { status: { in: busyJobStates } } } } }, orderBy: { scheduledAt: "asc" }, take: 100 });
    for (const job of due) await queue.add("measure-site", { id: job.id }, { jobId: job.id, attempts: 1, removeOnComplete: true, removeOnFail: true });
    const refresh = await prisma.site.findFirst({ where: { weeklyRefresh: true, nextWigleRefreshAt: { lte: new Date() },
      jobs: { none: { status: { in: busyJobStates } } } }, orderBy: { nextWigleRefreshAt: "asc" } });
    if (refresh) {
      // Claim a retry window before network work so quota failures cannot spin every scan.
      const claim = await prisma.site.updateMany({ where: { id: refresh.id, nextWigleRefreshAt: refresh.nextWigleRefreshAt },
        data: { nextWigleRefreshAt: new Date(Date.now() + 24 * 60 * 60_000) } });
      if (claim.count) {
        try { await refreshSite(refresh.tenantId, refresh.id); }
        catch { logger.warn({ siteId: refresh.id }, "weekly WiGLE refresh failed; library unchanged, retry delayed"); }
      }
    }
  };
  const timer = setInterval(() => {
    if (!active) active = scan().catch(() => logger.warn("site planner scan failed; database jobs retained")).finally(() => { active = undefined; });
  }, 5000);
  timer.unref();
  return { async stop() { clearInterval(timer); await active; await worker.close(); await queue.close(); } };
}
