import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { Site, SiteJob, SiteResult } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError } from "../http/errors.js";
import { config } from "../config.js";
import { applyDeviceEnvironment, getDeviceStatus } from "../api/duoPlusClient.js";
import { normalizedMac, readDeviceWifi, wifiReadbackMatches } from "../api/environmentWifi.js";
import { checkDevicePower } from "../orchestrator/powerCheck.js";
import { withEnvironmentWindow } from "../orchestrator/deviceOperations.js";
import { dispatchGps, gpsIsDue } from "../orchestrator/locationDispatch.js";
import { withTripLease } from "../trips/lease.js";
import { haversineMeters } from "../geo/haversine.js";
import { prepareSiteProfile, refreshSiteLibrary, type SiteProfile } from "./profile.js";

export const busyJobStates = ["PREFLIGHT", "SUBMITTING", "AWAITING_RESULT", "UNCONFIRMED", "TIMED_OUT"];
const point = { lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) };
const timeZone = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}, "Invalid timezone");
export const createSiteSchema = z.object({
  deviceId: z.string().min(1).max(200), name: z.string().trim().min(1).max(120), ...point,
  elevationM: z.number().finite().min(-500).max(9000).nullable().optional(),
  street: z.string().trim().max(250).default(""), zip: z.string().trim().max(20).default(""),
  proxyId: z.string().trim().min(1).max(200).nullable().optional(),
  proxyIp: z.string().trim().refine((ip) => isIP(ip) !== 0, "A fixed proxy IP is required"),
  timezone: timeZone, language: z.string().trim().min(2).max(40),
  templateId: z.string().trim().min(1).max(200).nullable().optional(),
  templateType: z.union([z.literal(1), z.literal(2)]).default(2),
}).strict();
export const editSiteSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(), enabled: z.boolean().optional(),
  elevationM: createSiteSchema.shape.elevationM, templateId: createSiteSchema.shape.templateId,
  weeklyRefresh: z.boolean().optional(),
}).strict();
export const createJobSchema = z.object({
  keyword: z.string().trim().min(1).max(250), app: z.enum(["chrome", "maps", "tracker"]),
  scheduledAt: z.string().datetime({ offset: true }), motion: z.literal("STILL").default("STILL"),
  idempotencyKey: z.string().min(8).max(100),
}).strict();

export function parseJson<T = unknown>(json: string | null): T | null {
  if (!json) return null;
  try { return JSON.parse(json) as T; } catch { return null; }
}
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function coordinate(value: unknown, max: number): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= max ? number : null;
}

// Only these nonsecret fields may enter profile, result or browser snapshots.
export function providerSnapshot(raw: unknown, imageId: string) {
  const info = object(raw);
  const wifi = readDeviceWifi(raw, imageId);
  const gps = object(info.gps), proxy = object(info.proxy), locale = object(info.locale);
  const sim = object(info.sim), bluetooth = object(info.bluetooth), device = object(info.device);
  return {
    id: imageId, capturedAt: new Date().toISOString(), source: "DUOPLUS_INFO" as const,
    gps: { type: gps.type === 2 || gps.type === "2" ? 2 : gps.type === 1 || gps.type === "1" ? 1 : null,
      latitude: coordinate(gps.latitude ?? gps.lat, 90), longitude: coordinate(gps.longitude ?? gps.lng, 180) },
    wifi, proxy: { id: text(proxy.id), ip: text(proxy.ip), city: text(proxy.city), country: text(proxy.country), zip: text(proxy.zipcode) },
    locale: { timezone: text(locale.timezone), language: text(locale.language) },
    sim: { mcc: sim.mcc == null ? null : String(sim.mcc), mnc: sim.mnc == null ? null : String(sim.mnc), operator: text(sim.operator) },
    bluetooth: { name: text(bluetooth.name), address: normalizedMac(bluetooth.address) },
    device: { name: text(device.model ?? device.name), os: text(info.os) },
  };
}
export type ProviderSnapshot = ReturnType<typeof providerSnapshot>;
export type StoredSiteProfile = SiteProfile & { baseline: ProviderSnapshot; verification?: {
  requestId: string | null; gpsAcceptedAt: string | null; wifiDispatchedAt: string | null; wifiAcceptedAt: string | null;
  provider: ProviderSnapshot | null; problems: string[];
} };

export function serializeSite(site: Site) {
  const { profileJson, ...fields } = site;
  return { ...fields, profile: parseJson(profileJson) };
}
export function serializeResult(row: SiteResult) {
  const { rawJson, provenanceJson, ...fields } = row;
  return { ...fields, raw: parseJson(rawJson), provenance: parseJson(provenanceJson) };
}
export function serializeJob(row: SiteJob & { result?: SiteResult | null }) {
  const { callbackTokenHash: _token, callbackExpiresAt: _expiry, requestJson, preflightJson, providerResponseJson, result, ...fields } = row;
  return { ...fields, request: parseJson(requestJson), preflight: parseJson(preflightJson),
    submission: parseJson(providerResponseJson), result: result ? serializeResult(result) : null };
}
export async function ownSite(tenantId: string, id: string) {
  const site = await prisma.site.findFirst({ where: { id, tenantId, device: { tenantId } }, include: { device: true } });
  if (!site) throw new HttpError(404, "Client not found");
  return site;
}
export async function requireIdleSite(siteId: string): Promise<void> {
  if (await prisma.siteJob.count({ where: { siteId, status: { in: busyJobStates } } })) {
    throw new HttpError(409, "A tracker job owns this client. Resolve its pending or unconfirmed result before changing the profile.");
  }
}
export async function listSites(tenantId: string) {
  const sites = await prisma.site.findMany({ where: { tenantId }, include: { device: { select: { id: true, imageId: true, name: true, duoPlusStatus: true } } }, orderBy: { name: "asc" } });
  const devices = await prisma.device.findMany({ where: { tenantId, site: { is: null } }, select: {
    id: true, imageId: true, name: true, anchorLat: true, anchorLng: true, proxyIp: true, timezone: true, language: true,
  }, orderBy: { name: "asc" } });
  const pendingStates = ["QUEUED", ...busyJobStates];
  const [pendingJobs, recentJobs] = await Promise.all([
    prisma.siteJob.findMany({ where: { tenantId, status: { in: pendingStates } }, include: { result: true }, orderBy: { createdAt: "desc" } }),
    prisma.siteJob.findMany({ where: { tenantId, status: { notIn: pendingStates } }, include: { result: true }, orderBy: { createdAt: "desc" }, take: 200 }),
  ]);
  const jobs = [...new Map([...pendingJobs, ...recentJobs].map((job) => [job.id, job])).values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return { sites: sites.map(serializeSite), devices, jobs: jobs.map(serializeJob) };
}
export async function createSite(tenantId: string, input: unknown) {
  const data = createSiteSchema.parse(input);
  return withTripLease(data.deviceId, tenantId, () => withEnvironmentWindow(data.deviceId, async () => {
    const device = await prisma.device.findFirst({ where: { id: data.deviceId, tenantId } });
    if (!device) throw new HttpError(404, "Device not found");
    if (device.activeTripId) throw new HttpError(409, "Cancel this phone's driving trip before assigning a client");
    if (await prisma.site.findFirst({ where: { OR: [{ deviceId: device.id }, { tenantId, proxyIp: data.proxyIp }] } })) {
      throw new HttpError(409, "This phone or proxy IP already belongs to a client");
    }
    const row = await prisma.$transaction(async (tx) => {
      // Binding freezes the legacy ticker; it does not write to DuoPlus.
      const claimed = await tx.device.updateMany({ where: { id: device.id, tenantId, activeTripId: null, site: { is: null } },
        data: { active: false, anchorLat: data.lat, anchorLng: data.lng } });
      if (claimed.count !== 1) throw new HttpError(409, "Device ownership changed");
      return tx.site.create({ data: { ...data, tenantId } });
    });
    return serializeSite(row);
  }));
}
export async function editSite(tenantId: string, id: string, input: unknown) {
  const data = editSiteSchema.parse(input), found = await ownSite(tenantId, id);
  return withTripLease(found.deviceId, tenantId, async () => {
    const site = await ownSite(tenantId, id);
    await requireIdleSite(id);
    if (data.enabled === true && (site.profileStatus !== "PROVIDER_MATCH" || !(data.templateId ?? site.templateId))) {
      throw new HttpError(409, "Apply a matching client profile and set an RPA template before enabling jobs");
    }
    if (data.templateId === null && (data.enabled ?? site.enabled)) throw new HttpError(409, "Disable jobs before clearing the template");
    return serializeSite(await prisma.site.update({ where: { id }, data: { ...data,
      ...(data.weeklyRefresh === true && !site.nextWigleRefreshAt ? { nextWigleRefreshAt: new Date() } : {}) } }));
  });
}
export async function prepareSite(tenantId: string, id: string) {
  const found = await ownSite(tenantId, id);
  return withTripLease(found.deviceId, tenantId, () => withEnvironmentWindow(found.deviceId, async () => {
    const site = await ownSite(tenantId, id);
    await requireIdleSite(id);
    const baseline = providerSnapshot(await getDeviceStatus(site.device.imageId, tenantId), site.device.imageId);
    const profile = { ...await prepareSiteProfile(site, baseline), baseline };
    const missing = !profile.wifi || !profile.phoneWifiMac;
    const row = await prisma.site.update({ where: { id }, data: { profileJson: JSON.stringify(profile), profileRevision: randomUUID(),
      profileStatus: missing ? "BLOCKED" : "PREPARED", enabled: false, appliedAt: null,
      profileError: missing ? "No eligible saved Wi-Fi observation or existing phone Wi-Fi MAC" : null } });
    return serializeSite(row);
  }));
}
export async function refreshSite(tenantId: string, id: string) {
  const site = await ownSite(tenantId, id);
  return withTripLease(site.deviceId, tenantId, async () => {
    await requireIdleSite(id);
    const refreshed = await refreshSiteLibrary(site);
    const now = refreshed.checkedAt ? new Date(refreshed.checkedAt) : new Date();
    return serializeSite(await prisma.site.update({ where: { id }, data: {
      wigleCheckedAt: now, nextWigleRefreshAt: new Date(now.getTime() + 7 * 86_400_000),
    } }));
  });
}

export function profileProblems(site: Site, profile: StoredSiteProfile, observed: ProviderSnapshot, includeGpsWifi: boolean): string[] {
  const problems: string[] = [];
  if (observed.proxy.ip !== site.proxyIp) problems.push("Provider proxy IP does not match the client (or is unavailable)");
  if (site.proxyId && observed.proxy.id !== site.proxyId) problems.push("Provider proxy ID does not match the client (or is unavailable)");
  if (observed.locale.timezone !== site.timezone) problems.push("Provider timezone does not match the client (or is unavailable)");
  if (observed.locale.language !== site.language) problems.push("Provider language does not match the client (or is unavailable)");
  if (!profile.phoneWifiMac || normalizedMac(observed.wifi.mac) !== normalizedMac(profile.phoneWifiMac)) problems.push("Phone Wi-Fi MAC changed or is unavailable");
  if (profile.baseline) {
    if (JSON.stringify(observed.sim) !== JSON.stringify(profile.baseline.sim)) problems.push("SIM profile changed after preparation");
    if (JSON.stringify(observed.bluetooth) !== JSON.stringify(profile.baseline.bluetooth)) problems.push("Phone Bluetooth identity changed after preparation");
    if (JSON.stringify(observed.device) !== JSON.stringify(profile.baseline.device)) problems.push("Phone model or OS changed after preparation");
  }
  if (includeGpsWifi) {
    // /info documents coordinates but not gps.type. Missing type is not a mismatch.
    if (observed.gps.type === 1 || observed.gps.latitude === null || observed.gps.longitude === null ||
        haversineMeters(site.lat, site.lng, observed.gps.latitude, observed.gps.longitude) > 5) problems.push("Provider GPS does not match the requested client pin within 5 m (or explicitly follows the proxy)");
    if (!profile.wifi || !profile.phoneWifiMac || !wifiReadbackMatches({ status: 1, name: profile.wifi.ssid,
      bssid: profile.wifi.bssid, mac: profile.phoneWifiMac }, observed.wifi)) problems.push("Provider Wi-Fi profile does not match the client");
  }
  return problems;
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function waitSiteOn(site: Site, assertOwned: () => Promise<void>) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await assertOwned();
    const device = await checkDevicePower(site.deviceId, site.tenantId);
    if (device.duoPlusStatus === 1 && device.poweredOn) return device;
    if (![10, 11].includes(device.duoPlusStatus ?? -1)) throw new HttpError(409, "Client phone is not confirmed ON");
    if (attempt < 11) await wait(3000);
  }
  throw new HttpError(409, "Provider is still transitioning; no further update was sent");
}
export async function applySite(tenantId: string, id: string, revision: string) {
  if (config.dryRun) throw new HttpError(409, "Client apply is disabled in dry-run mode");
  const found = await ownSite(tenantId, id);
  return withTripLease(found.deviceId, tenantId, (lease) => withEnvironmentWindow(found.deviceId, async () => {
    let site = await ownSite(tenantId, id);
    await requireIdleSite(id);
    if (site.profileRevision !== revision || site.profileStatus !== "PREPARED") throw new HttpError(409, "Prepare and review a fresh client profile before applying");
    const profile = parseJson<StoredSiteProfile>(site.profileJson);
    if (!profile?.wifi || !profile.phoneWifiMac) throw new HttpError(409, "No eligible Wi-Fi profile");
    if (site.device.activeTripId) throw new HttpError(409, "A trip owns this phone");
    await waitSiteOn(site, lease.assertOwned);
    const baseline = providerSnapshot(await getDeviceStatus(site.device.imageId, tenantId), site.device.imageId);
    const problems = profileProblems(site, profile, baseline, false);
    if (problems.length) throw new HttpError(409, problems.join("; "));
    const verification: NonNullable<StoredSiteProfile["verification"]> = { requestId: null, gpsAcceptedAt: null, wifiDispatchedAt: null, wifiAcceptedAt: null, provider: null, problems: [] };
    profile.verification = verification;
    await prisma.site.update({ where: { id }, data: { profileStatus: "APPLYING", enabled: false, profileError: null } });
    let wrote = false;
    try {
      for (let attempt = 0; !await gpsIsDue(site.deviceId, 15_000); attempt++) {
        if (attempt >= 30) throw new HttpError(409, "GPS writer is cooling down");
        await lease.assertOwned(); await wait(1000);
      }
      const device = await waitSiteOn(site, lease.assertOwned);
      const requests = await dispatchGps([{ device, proposed: { ...device, currentLat: site.lat, currentLng: site.lng, lastSpeedMps: 0, phase: "STATIONARY" } }], "SITE", {
        siteId: site.id, intervalMs: 15_000, beforeDispatch: lease.assertOwned,
        onDispatched: async (_tx, rows) => { wrote = true; verification.requestId = rows[0]!.id; },
      });
      const request = requests[0]!;
      verification.requestId = request.id;
      if (request.status !== "API_ACCEPTED") throw new HttpError(409, "Client GPS was not confirmed accepted. Review its location request before retrying.");
      verification.gpsAcceptedAt = request.acceptedAt!.toISOString();
      await prisma.site.update({ where: { id }, data: { profileJson: JSON.stringify(profile), lastGpsAt: request.acceptedAt } });
      await waitSiteOn(site, lease.assertOwned);
      const submitted = await applyDeviceEnvironment(site.device.imageId, { wifi: {
        ssid: profile.wifi.ssid, bssid: profile.wifi.bssid, expectedMac: profile.phoneWifiMac,
      } }, tenantId, async () => {
        await lease.assertOwned();
        if (verification.wifiDispatchedAt) throw new HttpError(409, "This Wi-Fi update was already dispatched; key failover must not replay it");
      }, async () => {
        if (verification.wifiDispatchedAt) throw new HttpError(409, "Wi-Fi already dispatched");
        verification.wifiDispatchedAt = new Date().toISOString();
        await prisma.site.update({ where: { id }, data: { profileJson: JSON.stringify(profile) } });
        wrote = true;
      });
      verification.wifiAcceptedAt = new Date().toISOString();
      await prisma.site.update({ where: { id }, data: { profileStatus: "API_ACCEPTED", profileJson: JSON.stringify(profile), appliedAt: new Date() } });
      await waitSiteOn(site, lease.assertOwned);
      verification.provider = providerSnapshot(await getDeviceStatus(site.device.imageId, tenantId), site.device.imageId);
      verification.problems = profileProblems(site, profile, verification.provider, true);
      if (!wifiReadbackMatches(submitted, verification.provider.wifi)) verification.problems.push("Wi-Fi readback differs from the submitted slice");
      if (!verification.problems.length) await prisma.device.update({ where: { id: site.deviceId }, data: {
        wifiSsid: submitted.name, wifiBssid: submitted.bssid, wifiMac: submitted.mac, active: false,
      } });
      site = await ownSite(tenantId, id);
      return serializeSite(await prisma.site.update({ where: { id }, data: {
        profileStatus: verification.problems.length ? "MISMATCH" : "PROVIDER_MATCH", profileJson: JSON.stringify(profile),
        profileError: verification.problems.join("; ") || null,
      } }));
    } catch (error) {
      await prisma.site.update({ where: { id }, data: { profileStatus: wrote ? "UNCONFIRMED" : "BLOCKED", profileJson: JSON.stringify(profile),
        profileError: error instanceof HttpError ? error.message : "Client apply interrupted; inspect provider state before preparing again" } });
      throw error;
    }
  }));
}

export async function scheduleJob(tenantId: string, id: string, input: unknown) {
  const data = createJobSchema.parse(input), site = await ownSite(tenantId, id);
  const requestJson = JSON.stringify({ ...data, siteId: id });
  const existing = await prisma.siteJob.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: data.idempotencyKey } } });
  if (existing) {
    if (existing.requestJson !== requestJson) throw new HttpError(409, "Idempotency key belongs to a different job");
    return serializeJob(existing);
  }
  const scheduledAt = new Date(data.scheduledAt);
  if (scheduledAt.getTime() < Date.now() - 60_000 || scheduledAt.getTime() > Date.now() + 366 * 86_400_000) throw new HttpError(400, "Schedule within the next year");
  if (!site.enabled || site.profileStatus !== "PROVIDER_MATCH" || !site.templateId) throw new HttpError(409, "Enable a prepared client with a matching provider profile and RPA template first");
  try { return serializeJob(await prisma.siteJob.create({ data: { ...data, tenantId, siteId: id, scheduledAt, requestJson } })); }
  catch (error) {
    const replay = await prisma.siteJob.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: data.idempotencyKey } } });
    if (replay?.requestJson === requestJson) return serializeJob(replay);
    if (replay) throw new HttpError(409, "Idempotency key belongs to a different job");
    throw error;
  }
}
export async function cancelSiteJob(tenantId: string, id: string) {
  const job = await prisma.siteJob.findFirst({ where: { id, tenantId } });
  if (!job) throw new HttpError(404, "Job not found");
  const site = await ownSite(tenantId, job.siteId);
  return withTripLease(site.deviceId, tenantId, async () => {
    const result = await prisma.siteJob.updateMany({ where: { id, tenantId, status: "QUEUED" }, data: { status: "CANCELLED", completedAt: new Date() } });
    if (!result.count) throw new HttpError(409, "Only queued jobs can be cancelled here. Submitted RPA work must be stopped in DuoPlus before resolving its result.");
    return serializeJob(await prisma.siteJob.findUniqueOrThrow({ where: { id } }));
  });
}
