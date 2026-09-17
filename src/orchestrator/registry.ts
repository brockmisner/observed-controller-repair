import { assertNoWarmup } from "../warmup/service.js";
import { createHash, randomUUID } from "node:crypto";
import type { Device, LocationRequest } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { bluetoothProfile } from "../env/bluetooth.js";
import { carrierByName, randomUsCellIds } from "../env/carriers.js";
import { simIdentifiers } from "../env/sim.js";
import { resolveWigleCell, resolveWigleCluster, wigleConfigured, type WigleCluster } from "../env/wigle.js";
import { logger } from "../logger.js";
import { deliverSavedRpaIntent } from "../queue/rpaOutbox.js";
import { pendingRpaStatuses } from "../queue/rpaDelivery.js";
import { assertNoPendingRpa } from "../queue/rpaOwnership.js";
import { withTripLease } from "../trips/lease.js";
import { siteIssueAt } from "../sites/readiness.js";
import type { LatLng, TransitMode } from "../types.js";
import { HttpError } from "../http/errors.js";
import { withEnvironmentWindow } from "./deviceOperations.js";

async function findDevice(identifier: string, tenantId?: string): Promise<Device> {
  const byId = await prisma.device.findFirst({ where: { id: identifier, tenantId } });
  const device = byId ?? await prisma.device.findFirst({ where: { imageId: identifier, tenantId } });
  if (!device) throw new HttpError(404, "Device not found");
  return device;
}

async function withIdleDevice<T>(identifier: string, tenantId: string | undefined, work: (device: Device) => Promise<T>): Promise<T> {
  const found = await findDevice(identifier, tenantId);
  return withEnvironmentWindow(found.id, async () => {
    const device = await findDevice(found.id, tenantId);
    await assertNoWarmup(device.id);
    if (await prisma.site.count({ where: { deviceId: device.id } })) throw new HttpError(409, "This phone belongs to a client. Use the Clients workspace; legacy movement is disabled.");
    if (device.activeTripId) throw new HttpError(409, "A driving trip owns this device. Pause or cancel it through the Driving controls.");
    return work(device);
  });
}

export interface RegisterDeviceInput {
  imageId: string;
  name?: string;
  anchorLat: number;
  anchorLng: number;
  groundElevationM?: number;
  timezone?: string;
  language?: string;
  wifiSsid?: string;
  wifiBssid?: string;
  wifiMac?: string;
  lookupWigle?: boolean;
  carrier?: string;
  msisdn?: string;
  msin?: string;
  iccid?: string;
  imsi?: string;
  lac?: number;
  cid?: number;
  campaignDays?: number;
  tenantId: string;
  proxyIp?: string;
  proxyIsp?: string;
  proxyAsn?: string;
  proxyKind?: string;
}

export function syntheticBssid(imageId: string): string {
  const hex = createHash("sha256").update(imageId).digest("hex").slice(0, 10);
  return `02:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}:${hex.slice(8, 10)}`;
}

export async function registerDevice(input: RegisterDeviceInput): Promise<Device> {
  const bt = bluetoothProfile(input.imageId);
  const carrier = carrierByName(input.carrier);
  const sim = simIdentifiers(input.imageId, carrier);
  const cells = randomUsCellIds();
  let lac = input.lac ?? cells.lac;
  let cid = input.cid ?? cells.cid;
  let cellRadio = "LTE";
  if (input.lac == null && input.cid == null && await wigleConfigured(input.tenantId)) {
    const tower = await resolveWigleCell(input.anchorLat, input.anchorLng, carrier.mcc, carrier.mnc, input.tenantId);
    if (tower) {
      lac = tower.lac;
      cid = tower.cid;
      cellRadio = tower.radio;
    }
  }
  const days = input.campaignDays ?? config.defaultCampaignDays;
  const campaignEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const existing = await prisma.device.findUnique({
    where: { tenantId_imageId: { tenantId: input.tenantId, imageId: input.imageId } },
  });
  let cluster: WigleCluster | undefined;
  let wifiSsid = input.wifiSsid?.trim() ?? "";
  let wifiBssid = input.wifiBssid?.trim() ?? "";
  const missingRadio = !wifiSsid || !wifiBssid;
  const shouldLookup =
    missingRadio &&
    (Boolean(input.lookupWigle) || config.wigleAutoOnRegister) &&
    !(existing?.wifiLocked && existing.wifiBssid);
  if (shouldLookup && await wigleConfigured(input.tenantId)) {
    try {
      cluster = await resolveWigleCluster(input.anchorLat, input.anchorLng, {
        isp: input.proxyIsp,
        kind: input.proxyKind,
      }, input.tenantId);
      wifiSsid = wifiSsid || cluster.primary.ssid;
      wifiBssid = wifiBssid || cluster.primary.bssid;
    } catch (err) {
      logger.warn({ err, imageId: input.imageId }, "WiGLE lookup skipped");
    }
  }
  if (!wifiSsid || !wifiBssid) {
    wifiSsid = wifiSsid || `pending-${input.imageId.slice(0, 8)}`;
    wifiBssid = wifiBssid || syntheticBssid(input.imageId);
  }
  const wifiMac = input.wifiMac ?? "";

  return prisma.$transaction(async (tx) => {
    const existing = await tx.device.findUnique({ where: { tenantId_imageId: { tenantId: input.tenantId, imageId: input.imageId } } });
    if (existing) await assertNoWarmup(existing.id, tx);
    if (existing?.activeTripId) throw new HttpError(409, "Cancel the driving trip before re-registering this device");
    if (existing && await tx.site.count({ where: { deviceId: existing.id } })) throw new HttpError(409, "A client owns this phone. Its identity and anchor cannot be overwritten through registration.");
    return tx.device.upsert({
    where: { tenantId_imageId: { tenantId: input.tenantId, imageId: input.imageId } },
    create: {
      id: randomUUID(),
      tenantId: input.tenantId,
      imageId: input.imageId,
      name: input.name,
      campaignEnd,
      timezone: input.timezone ?? "America/New_York",
      language: input.language ?? "en-US",
      anchorLat: input.anchorLat,
      anchorLng: input.anchorLng,
      currentLat: input.anchorLat,
      currentLng: input.anchorLng,
      groundElevationM: input.groundElevationM ?? 20,
      lastAltitudeM: (input.groundElevationM ?? 20) + 1.5,
      wifiSsid,
      wifiBssid: wifiBssid.toLowerCase(),
      wifiMac,
      wifiLocked: true,
      wifiClusterJson: cluster ? JSON.stringify(cluster) : null,
      wigleQueriedAt: cluster ? new Date(cluster.queriedAt) : null,
      mcc: carrier.mcc,
      mnc: carrier.mnc,
      operator: carrier.operator,
      msisdn: input.msisdn,
      msin: input.msin ?? sim.msin,
      iccid: input.iccid ?? sim.iccid,
      imsi: input.imsi ?? sim.imsi,
      apn: carrier.apn,
      apnType: carrier.apnType,
      lac,
      cid,
      cellRadio,
      cellLocked: true,
      wigleCellQueriedAt: new Date(),
      carrierLocked: true,
      proxyIp: input.proxyIp,
      proxyIsp: input.proxyIsp,
      proxyAsn: input.proxyAsn,
      proxyKind: input.proxyKind,
      bluetoothName: bt.name,
      bluetoothAddress: bt.address,
      phase: "STATIONARY",
      active: true,
    },
    update: {
      name: input.name,
      anchorLat: input.anchorLat,
      anchorLng: input.anchorLng,
      currentLat: input.anchorLat,
      currentLng: input.anchorLng,
      groundElevationM: input.groundElevationM ?? 20,
      timezone: input.timezone ?? "America/New_York",
      language: input.language ?? "en-US",
      campaignEnd,
      active: true,
      phase: "STATIONARY",
      // Zero-leak: never rotate locked Wi-Fi / cell identity on re-register.
    },
    });
  });
}

export async function startNavigation(
  imageId: string,
  dest: LatLng,
  polyline: string | LatLng[],
  transitMode: TransitMode = "walk",
  tenantId?: string,
): Promise<Device> {
  return withIdleDevice(imageId, tenantId, async (device) => {
  const polylineJson = typeof polyline === "string" ? polyline : JSON.stringify(polyline);
  return prisma.device.update({
    where: { id: device.id, activeTripId: null },
    data: {
      phase: "NAVIGATING",
      transitMode,
      targetLat: dest.lat,
      targetLng: dest.lng,
      polylineJson,
      routeIndex: 0,
      routeProgressM: 0,
    },
  });
  });
}

interface AnchorResult {
  device: Device;
  gpsUpdate: { status: string; message: string };
  locationRequest: LocationRequest | null;
}

export async function setAnchor(imageId: string, lat: number, lng: number, tenantId?: string): Promise<AnchorResult> {
  return withIdleDevice(imageId, tenantId, async (device) => {
  const { dispatchGps, gpsEligibility, gpsIsDue } = await import("./locationDispatch.js");
  const eligible = await prisma.device.count({ where: gpsEligibility(device.tenantId, [device.id]) }) === 1;
  const saved = await prisma.device.update({
    where: { id: device.id, activeTripId: null },
    data: {
      anchorLat: lat,
      anchorLng: lng,
      currentLat: lat,
      currentLng: lng,
      phase: "STATIONARY",
      transitMode: null,
      polylineJson: null,
      routeIndex: 0,
      routeProgressM: 0,
    },
  });
  const local = async (message: string): Promise<AnchorResult> => ({
    device: await prisma.device.findUniqueOrThrow({ where: { id: device.id } }),
    gpsUpdate: { status: "NOT_SENT", message }, locationRequest: null,
  });
  if (!eligible) return local("Anchor saved locally. No GPS update sent: the controller must be active and the phone freshly confirmed ON.");
  if (!await gpsIsDue(device.id)) return local("Anchor saved locally. No GPS update sent: the phone is cooling down.");

  let dispatchedId: string | undefined;
  let request: LocationRequest | null = null;
  try {
    [request = null] = await dispatchGps([{ device: saved, proposed: saved }], "ANCHOR", {
      onDispatched: async (_tx, records) => { dispatchedId = records[0]?.id; },
    });
  } catch {
    if (dispatchedId) request = await prisma.locationRequest.findUnique({ where: { id: dispatchedId } });
    if (!request) return local("Anchor saved locally. The GPS update was not sent.");
  }
  const message = request?.status === "API_ACCEPTED" ? "Anchor saved. DuoPlus accepted the GPS request; device GPS is not verified." :
    request?.status === "API_REJECTED" ? "Anchor saved locally. DuoPlus rejected the GPS request." :
    request?.status === "DRY_RUN" ? "Anchor saved locally. Dry run: no GPS update sent." :
    "Anchor saved locally. GPS request acceptance is unconfirmed.";
  return {
    device: await prisma.device.findUniqueOrThrow({ where: { id: device.id } }),
    gpsUpdate: { status: request?.status ?? "UNCONFIRMED", message }, locationRequest: request,
  };
  });
}

export async function rebindRadio(imageId: string, tenantId?: string): Promise<Device> {
  return withIdleDevice(imageId, tenantId, async (device) => {
  const carrier = carrierByName(device.mnc);
  const sim = simIdentifiers(device.imageId, carrier);
  let wifiSsid = device.wifiSsid;
  let wifiBssid = device.wifiBssid;
  let clusterJson = device.wifiClusterJson;
  if (await wigleConfigured(device.tenantId)) {
    const cluster = await resolveWigleCluster(device.anchorLat, device.anchorLng, {
      isp: device.proxyIsp ?? undefined,
      kind: device.proxyKind ?? undefined,
    }, device.tenantId);
    wifiSsid = cluster.primary.ssid;
    wifiBssid = cluster.primary.bssid;
    clusterJson = JSON.stringify(cluster);
  }
  let lac = device.lac;
  let cid = device.cid;
  let cellRadio = device.cellRadio;
  if (await wigleConfigured(device.tenantId)) {
    const tower = await resolveWigleCell(device.anchorLat, device.anchorLng, carrier.mcc, carrier.mnc, device.tenantId);
    if (tower) {
      lac = tower.lac;
      cid = tower.cid;
      cellRadio = tower.radio;
    }
  }
  logger.info({ imageId: device.imageId, wifiSsid, lac, cid }, "radio rebound");
  return prisma.device.update({
    where: { id: device.id, activeTripId: null },
    data: {
      wifiSsid,
      wifiBssid: wifiBssid.toLowerCase(),
      wifiLocked: true,
      wifiClusterJson: clusterJson,
      wigleQueriedAt: new Date(),
      mcc: carrier.mcc,
      mnc: carrier.mnc,
      operator: carrier.operator,
      apn: device.apn ?? carrier.apn,
      apnType: device.apnType ?? carrier.apnType,
      imsi: device.imsi ?? sim.imsi,
      iccid: device.iccid ?? sim.iccid,
      msin: device.msin ?? sim.msin,
      lac,
      cid,
      cellRadio,
      cellLocked: true,
      wigleCellQueriedAt: new Date(),
    },
  });
  });
}

export async function parkStationary(imageId: string, tenantId?: string): Promise<Device> {
  return withIdleDevice(imageId, tenantId, async (device) => {
  return prisma.device.update({
    where: { id: device.id, activeTripId: null },
    data: {
      phase: "STATIONARY",
      transitMode: null,
      polylineJson: null,
      routeProgressM: 0,
      routeIndex: 0,
    },
  });
  });
}

export async function queueSearch(
  imageId: string,
  templateId: string,
  variables: Record<string, unknown>,
  name = "local-search",
  tenantId?: string,
  idempotencyKey?: string,
): Promise<{ queued: true; jobId: string; delivery: "queued" | "pending" | "settled"; message: string }> {
  const device = await findDevice(imageId, tenantId);
  if (idempotencyKey !== undefined && (idempotencyKey.length < 8 || idempotencyKey.length > 100 || idempotencyKey !== idempotencyKey.trim() || /[\x00-\x1f\x7f]/.test(idempotencyKey))) {
    throw new HttpError(400, "Idempotency key must be 8–100 characters");
  }
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
  const variablesJson = JSON.stringify(canonical(variables));
  const stableId = idempotencyKey === undefined ? undefined : `rpa-${createHash("sha256").update(JSON.stringify([device.tenantId, idempotencyKey])).digest("hex")}`;
  const existing = async () => {
    if (!stableId) return null;
    const previous = await prisma.rpaJob.findUnique({ where: { id: stableId }, include: { device: { select: { tenantId: true, imageId: true } } } });
    if (!previous) return null;
    if (previous.deviceId !== device.id || previous.templateId !== templateId || previous.name !== name ||
        JSON.stringify(canonical(JSON.parse(previous.variablesJson))) !== variablesJson) throw new HttpError(409, "Idempotency key was already used for different RPA work");
    return previous;
  };
  const accepted = await existing();
  if (!accepted) siteIssueAt(new Date());
  const job = accepted ?? await withTripLease(device.id, device.tenantId, async lease => {
    const previous = await existing();
    if (previous) return previous;
    await lease.assertOwned();
    return prisma.$transaction(async tx => {
      await assertNoPendingRpa(device.id, tx);
      await assertNoWarmup(device.id, tx);
      if (await tx.site.count({ where: { device: { imageId: device.imageId } } })) throw new HttpError(409, "Schedule this phone's searches through its client jobs");
      if (await tx.device.count({ where: { imageId: device.imageId, activeTripId: { not: null } } })) throw new HttpError(409, "A driving trip owns this phone. Finish or cancel it first.");
      if (await tx.warmupCampaign.count({ where: { imageId: device.imageId, reservedImageId: { not: null } } })) throw new HttpError(409, "A warmup campaign owns this physical phone");
      return tx.rpaJob.create({
        data: {
          ...(stableId ? { id: stableId } : {}),
          deviceId: device.id,
          templateId,
          name,
          variablesJson,
          status: "enqueue_pending",
        },
        include: { device: { select: { tenantId: true, imageId: true } } },
      });
    });
  }).catch(async error => {
    if ((error as { code?: string }).code === "P2002") {
      const previous = await existing();
      if (previous) return previous;
    }
    throw error;
  });
  if (!pendingRpaStatuses.includes(job.status)) return { queued: true, jobId: job.id, delivery: "settled", message: `This request was already accepted. Current job state: ${job.status}.` };
  const delivery = await deliverSavedRpaIntent(job);
  return { queued: true, jobId: job.id, delivery, message: delivery === "queued"
    ? "Job accepted and queued."
    : "Job saved. Queue delivery is pending and will retry automatically; do not submit it again." };
}
