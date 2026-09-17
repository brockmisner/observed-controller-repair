import { assertNoWarmup } from "../warmup/service.js";
import { randomUUID } from "node:crypto";
import type { Device, DeviceEnvironment } from "@prisma/client";
import { z } from "zod";
import { applyDeviceEnvironment, CELL_UPDATE_UNAVAILABLE, getDeviceStatus, powerStatusMessage } from "../api/duoPlusClient.js";
import { readDeviceWifi, wifiReadbackMatches, type SubmittedWifi } from "../api/environmentWifi.js";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { CELL_SUPPORT, resolveEnvironmentData } from "../env/environmentData.js";
import { loadSavedEnvironment, type SavedSelection } from "../env/savedEnvironmentData.js";
import { wigleConfigured } from "../env/wigle.js";
import { HttpError } from "../http/errors.js";
import { checkDevicePower, recordPowerObservation } from "./powerCheck.js";
import { withEnvironmentWindow } from "./deviceOperations.js";
import { logger } from "../logger.js";
import { MAX_DEVICE_WIGLE_UPLOADS, saveWigleUpload } from "../ops/wigleUpload.js";

const previewMaxAgeMs = 15 * 60_000;
const busyDevices = new Set<string>();
const coordinates = { lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) };
const profileSchema = z.object({
  anchor: z.object(coordinates),
  sim: z.object({ mcc: z.string(), mnc: z.string() }),
  deviceWifi: z.object({ mac: z.string().nullable(), status: z.union([z.literal(1), z.literal(2)]).nullable() }).optional(),
  wifi: z.object({
    ssid: z.string().min(1).max(100), bssid: z.string().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i),
    ...coordinates, distanceM: z.number().finite().nonnegative(), lastSeen: z.string().nullable(), qos: z.number().finite(),
    lastUpdated: z.string().nullable().optional(),
  }).nullable(),
  cell: z.object({
    radio: z.enum(["GSM", "WCDMA"]), mcc: z.string().regex(/^\d{3}$/), mnc: z.string().regex(/^\d{2,3}$/),
    lac: z.number().int().min(1).max(65535), cid: z.number().int().min(1).max(268435455),
    ...coordinates, distanceM: z.number().finite().nonnegative(),
  }).nullable(),
  warnings: z.array(z.string()),
  cellSupport: z.object({ status: z.literal("UNSUPPORTED"), message: z.string() }).optional(),
  connection: z.object({ status: z.literal("UNVERIFIED"), message: z.string() }).optional(),
  search: z.object({
    anchor: z.object(coordinates), radiusM: z.number().finite().positive(), startedAt: z.string().datetime(),
    pagesLoaded: z.number().int().positive().safe(), observationsLoaded: z.number().int().nonnegative().safe(),
    nextCursor: z.string().min(1).max(2048).nullable(), cursorHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
    stopReason: z.enum(["END", "REPEATED_CURSOR"]).nullable(),
  }).optional(),
  source: z.object({ type: z.literal("UPLOAD"), uploadId: z.string(), recordIndex: z.number().int().nonnegative(),
    filename: z.string(), importedAt: z.string(), queriedAt: z.string().datetime({ offset: true }).nullable() }).optional(),
});

export type EnvironmentProfile = z.infer<typeof profileSchema>;

const verificationSchema = z.object({
  revision: z.string(),
  wifi: z.object({
    status: z.enum(["NOT_APPLIED", "PENDING", "VERIFIED", "MISMATCH", "UNAVAILABLE"]),
    checkedAt: z.string().nullable(),
    expected: z.object({ name: z.string(), bssid: z.string(), mac: z.string(), status: z.union([z.literal(1), z.literal(2)]) }).nullable(),
    observed: z.object({ name: z.string().nullable(), bssid: z.string().nullable(), mac: z.string().nullable(), status: z.union([z.literal(1), z.literal(2)]).nullable() }).nullable(),
    error: z.string().nullable(),
  }),
  cell: z.object({ status: z.enum(["NOT_APPLIED", "ACCEPTED_UNVERIFIED"]) }),
});
type EnvironmentVerification = z.infer<typeof verificationSchema>;

function readVerification(json: string | null): EnvironmentVerification | null {
  return json ? verificationSchema.parse(JSON.parse(json)) : null;
}

async function verifyWifi(imageId: string, tenantId: string, verification: EnvironmentVerification): Promise<void> {
  verification.wifi.error = null;
  verification.wifi.observed = null;
  try {
    verification.wifi.observed = readDeviceWifi(await getDeviceStatus(imageId, tenantId), imageId);
    const observed = verification.wifi.observed;
    if (observed.name === null || observed.bssid === null || observed.mac === null || observed.status === null) {
      verification.wifi.status = "UNAVAILABLE";
      verification.wifi.error = "DuoPlus accepted the update, but its Wi-Fi readback was incomplete. Device configuration is unverified.";
    } else if (wifiReadbackMatches(verification.wifi.expected!, observed)) {
      verification.wifi.status = "VERIFIED";
    } else {
      verification.wifi.status = "MISMATCH";
      verification.wifi.error = "DuoPlus accepted the update, but its Wi-Fi readback did not match. Review the device before retrying.";
    }
  } catch {
    verification.wifi.status = "UNAVAILABLE";
    verification.wifi.error = "DuoPlus accepted the update, but Wi-Fi readback was unavailable. Device configuration is unverified.";
  }
  verification.wifi.checkedAt = new Date().toISOString();
}

export function environmentView(row: DeviceEnvironment | null, device?: Pick<Device, "anchorLat" | "anchorLng">) {
  if (!row) return null;
  const profile = profileSchema.parse(JSON.parse(row.preparedJson));
  const stale = device && (profile.anchor.lat !== device.anchorLat || profile.anchor.lng !== device.anchorLng);
  return {
    revision: row.revision, status: (stale || profile.cell) && row.status !== "APPLYING" ? "FAILED" : row.status,
    error: profile.cell ? CELL_UPDATE_UNAVAILABLE : stale ? "The anchor changed. Prepare a new environment." : row.error,
    preparedAt: row.preparedAt, acceptedAt: row.acceptedAt,
    dispatchedAt: row.dispatchedAt,
    profile,
    acceptedProfile: row.acceptedJson ? profileSchema.parse(JSON.parse(row.acceptedJson)) : null,
    verification: readVerification(row.verificationJson),
    acceptedVerification: readVerification(row.acceptedVerificationJson),
  };
}

async function ownDevice(deviceId: string, tenantId: string): Promise<Device> {
  const device = await prisma.device.findFirst({ where: { id: deviceId, tenantId } });
  if (!device) throw new HttpError(404, "Device not found");
  await assertNoWarmup(device.id);
  if (await prisma.site.count({ where: { deviceId, tenantId } })) throw new HttpError(409, "Use the Clients profile workflow for this phone");
  return device;
}

function requireEligible(device: Device): void {
  requireActive(device);
  if (device.duoPlusStatus !== 1) throw new HttpError(409, powerStatusMessage(device.duoPlusStatus));
  if (!device.poweredOn) throw new HttpError(409, "The saved power observations conflict. Use Check power now before retrying. No environment update was sent.");
  const age = Date.now() - (device.lastPowerSyncAt?.getTime() ?? 0);
  if (age < 0 || age > config.powerStatusMaxAgeMs) {
    throw new HttpError(409, "The ON confirmation is stale. Use Check power now before retrying. No environment update was sent.");
  }
}

function requireActive(device: Device): void {
  if (device.activeTripId) throw new HttpError(409, "A driving trip owns this device. Use its arrival environment controls or cancel the trip first.");
  if (!device.active) throw new HttpError(409, "The controller is paused for this device. Resume controller before preview or apply.");
}

async function confirmEligible(deviceId: string, tenantId: string): Promise<Device> {
  requireActive(await ownDevice(deviceId, tenantId));
  let device = await checkDevicePower(deviceId, tenantId);
  requireActive(device);
  const deadline = Date.now() + 15_000;
  // Movement is held by exclusive(); allow an outstanding provider transition to settle.
  for (let attempt = 1; attempt < 6 && (device.duoPlusStatus === 10 || device.duoPlusStatus === 11); attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(2000, remaining)));
    const latest = await ownDevice(deviceId, tenantId);
    requireActive(latest);
    if (![1, 10, 11].includes(latest.duoPlusStatus ?? -1)) requireEligible(latest);
    if (Date.now() >= deadline) break;
    device = await checkDevicePower(deviceId, tenantId);
    requireActive(device);
  }
  requireEligible(device);
  return device;
}

async function exclusive<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
  if (busyDevices.has(deviceId)) throw new HttpError(409, "An environment operation is already running for this device");
  busyDevices.add(deviceId);
  const startedAt = new Date();
  logger.info({ deviceId, startedAt }, "environment movement hold requested");
  try {
    return await withEnvironmentWindow(deviceId, async () => {
      logger.info({ deviceId, startedAt }, "environment movement hold ready");
      return task();
    });
  } finally {
    busyDevices.delete(deviceId);
    logger.info({ deviceId, startedAt, endedAt: new Date() }, "environment movement hold released");
  }
}

export async function previewEnvironment(deviceId: string, tenantId: string, selection?: SavedSelection, continuation?: { revision: string }) {
  await ownDevice(deviceId, tenantId);
  return exclusive(deviceId, async () => {
    const device = await ownDevice(deviceId, tenantId);
    requireActive(device);
    let previousProfile: EnvironmentProfile | null = null;
    if (continuation) {
      const previous = await prisma.deviceEnvironment.findUnique({ where: { deviceId } });
      if (!previous || previous.revision !== continuation.revision) throw new HttpError(409, "The preview changed. Review the latest environment before loading more.");
      if (previous.status === "APPLYING") throw new HttpError(409, "This device's environment is being applied");
      previousProfile = profileSchema.parse(JSON.parse(previous.preparedJson));
      if (selection || previousProfile.source || !previousProfile.search?.nextCursor || previousProfile.cell) {
        throw new HttpError(409, "This preview has no resumable Wi-Fi search. Prepare a new environment.");
      }
      if (previousProfile.anchor.lat !== device.anchorLat || previousProfile.anchor.lng !== device.anchorLng ||
          previousProfile.search.anchor.lat !== device.anchorLat || previousProfile.search.anchor.lng !== device.anchorLng) {
        throw new HttpError(409, "The anchor changed. Prepare a new environment.");
      }
    }
    const saved = selection ? await loadSavedEnvironment(prisma, device, selection) : null;
    if (!saved && !await wigleConfigured(tenantId)) throw new HttpError(400, "Add your WiGLE API name and token before preparing an environment.");
    if (!saved && await prisma.deviceWigleUpload.count({ where: { deviceId } }) >= MAX_DEVICE_WIGLE_UPLOADS) {
      throw new HttpError(409, `This device has reached its limit of ${MAX_DEVICE_WIGLE_UPLOADS} saved WiGLE datasets. Use an existing saved observation. No new lookup was sent; the preview and cursor are preserved.`);
    }
    await confirmEligible(deviceId, tenantId);
    const info = await getDeviceStatus(device.imageId, tenantId) as { sim?: { mcc?: unknown; mnc?: unknown }; wifi?: { status?: number } };
    const deviceWifi = readDeviceWifi(info, device.imageId);
    const mcc = String(info?.sim?.mcc ?? "");
    const mnc = String(info?.sim?.mnc ?? "");
    const sim = { mcc: /^\d{3}$/.test(mcc) ? mcc : "", mnc: /^\d{2,3}$/.test(mnc) ? mnc : "" };
    const anchor = { lat: device.anchorLat, lng: device.anchorLng };
    const live = saved ? null : await resolveEnvironmentData(anchor, sim, tenantId, previousProfile?.search ? {
      search: previousProfile.search,
      wifi: previousProfile.wifi ? { ...previousProfile.wifi, lastUpdated: previousProfile.wifi.lastUpdated ?? null } : null,
    } : undefined).catch(() => {
      throw new HttpError(502, continuation ? "WiGLE could not load the next Wi-Fi page. Your saved preview and cursor are unchanged. Check credentials or quota, then retry. If the cursor expired, start a new preview." : "WiGLE could not provide an environment preview. Check your credentials or quota and try again.");
    });
    const matches = saved ?? live!;
    if (deviceWifi.status !== 1) matches.warnings.push("Wi-Fi is not reported as enabled. Apply is blocked; the controller will not enable it or change network mode.");
    if (!deviceWifi.mac) matches.warnings.push("The existing device Wi-Fi MAC is unavailable. Apply is blocked until DuoPlus returns it.");
    const profile = profileSchema.parse({ anchor, sim, ...matches, deviceWifi: { mac: deviceWifi.mac, status: deviceWifi.status },
      cellSupport: CELL_SUPPORT,
      connection: { status: "UNVERIFIED", message: "DuoPlus reports Wi-Fi configuration. Network mode is unavailable from /info, and a connection or coverage area has not been verified." },
    });
    const current = await confirmEligible(deviceId, tenantId);
    if (current.anchorLat !== anchor.lat || current.anchorLng !== anchor.lng) {
      throw new HttpError(409, "The anchor changed during preview. Prepare a new environment.");
    }
    const row = await prisma.$transaction(async (tx) => {
      const previous = await tx.deviceEnvironment.findUnique({ where: { deviceId } });
      if (previous?.status === "APPLYING") throw new HttpError(409, "This device's environment is being applied");
      if (continuation && previous?.revision !== continuation.revision) throw new HttpError(409, "The preview changed. Review the latest environment before loading more.");
      const latestDevice = await tx.device.findFirst({ where: { id: deviceId, tenantId } });
      if (!latestDevice || latestDevice.anchorLat !== anchor.lat || latestDevice.anchorLng !== anchor.lng) {
        throw new HttpError(409, "The anchor changed during preview. Prepare a new environment.");
      }
      if (live) {
        const results = live.observations;
        await saveWigleUpload(tx, deviceId, tenantId, `environment-wifi-${live.query.queriedAt}.json`,
          { ...live.query.rawResponses.at(-1) as Record<string, unknown>, success: true, results, resultCount: results.length }, live.query);
      }
      const prepared = { revision: randomUUID(), status: "PREPARED", preparedJson: JSON.stringify(profile), preparedAt: new Date(), error: null, verificationJson: null, dispatchedAt: null };
      return tx.deviceEnvironment.upsert({ where: { deviceId }, create: { deviceId, ...prepared }, update: prepared });
    });
    return environmentView(row);
  });
}

export async function applyEnvironment(deviceId: string, tenantId: string, revision: string) {
  await ownDevice(deviceId, tenantId);
  return exclusive(deviceId, async () => {
    const row = await prisma.deviceEnvironment.findUnique({ where: { deviceId } });
    if (!row || row.revision !== revision) throw new HttpError(409, "The preview changed. Review the latest environment first.");
    const profile = profileSchema.parse(JSON.parse(row.preparedJson));
    if (profile.cell) throw new HttpError(409, CELL_UPDATE_UNAVAILABLE);
    if (row.status === "ACCEPTED") {
      const view = environmentView(row, await ownDevice(deviceId, tenantId));
      if (view?.status !== "ACCEPTED") throw new HttpError(409, "The anchor changed. Prepare a new environment.");
      return view;
    }
    if (readVerification(row.acceptedVerificationJson)?.revision === revision) {
      throw new HttpError(409, "DuoPlus already accepted this revision. Review the readback and prepare a new environment before applying again.");
    }
    if (row.dispatchedAt) {
      throw new HttpError(409, "This revision was already sent to DuoPlus. Review the device and prepare a new environment before retrying.");
    }
    if (row.status === "APPLYING") throw new HttpError(409, "This device's environment is already being applied");
    if (!profile.wifi) throw new HttpError(409, "No supported WiGLE matches are available to apply");
    const ensureCurrent = async (checkPower = true) => {
      const device = await ownDevice(deviceId, tenantId);
      if (checkPower) requireEligible(device);
      else requireActive(device);
      if (Date.now() - row.preparedAt.getTime() > previewMaxAgeMs) throw new HttpError(409, "This preview expired. Prepare a new environment.");
      if (device.anchorLat !== profile.anchor.lat || device.anchorLng !== profile.anchor.lng) {
        throw new HttpError(409, "The anchor changed. Prepare a new environment.");
      }
      const latest = await prisma.deviceEnvironment.findUnique({ where: { deviceId } });
      if (latest?.revision !== revision) throw new HttpError(409, "The preview changed. Review the latest environment first.");
    };
    await ensureCurrent(false);
    await confirmEligible(deviceId, tenantId);
    await ensureCurrent();
    const claimed = await prisma.deviceEnvironment.updateMany({
      where: { deviceId, revision, status: { in: ["PREPARED", "FAILED"] } }, data: { status: "APPLYING", error: null, verificationJson: null },
    });
    if (claimed.count !== 1) throw new HttpError(409, "This environment cannot be applied right now");
    try {
      const imageId = (await ownDevice(deviceId, tenantId)).imageId;
      const submitted: SubmittedWifi = await applyDeviceEnvironment(imageId, {
        wifi: { ssid: profile.wifi.ssid, bssid: profile.wifi.bssid, expectedMac: profile.deviceWifi?.mac },
      }, tenantId, ensureCurrent, async () => {
        // A durable send marker prevents replay after a lost response or failed acceptance write.
        const marked = await prisma.deviceEnvironment.updateMany({
          where: { deviceId, revision, status: "APPLYING", dispatchedAt: null },
          data: { dispatchedAt: new Date() },
        });
        if (marked.count !== 1) throw new HttpError(409, "This revision was already sent. Prepare a new environment before retrying.");
      }, async (checkedAt) => {
        await recordPowerObservation(deviceId, tenantId, 1, checkedAt);
      });
      const verification: EnvironmentVerification = {
        revision,
        wifi: { status: "PENDING", checkedAt: null, expected: submitted, observed: null, error: null },
        cell: { status: "NOT_APPLIED" },
      };
      // Persist acceptance before the separate, fallible readback. Never resend on a readback failure.
      await prisma.$transaction(async (tx) => {
        const current = await tx.device.findUniqueOrThrow({ where: { id: deviceId } });
        const anchorChanged = current.anchorLat !== profile.anchor.lat || current.anchorLng !== profile.anchor.lng;
        await tx.deviceEnvironment.update({
          where: { deviceId, revision },
          data: {
            status: anchorChanged ? "FAILED" : "ACCEPTED", acceptedJson: row.preparedJson, acceptedAt: new Date(),
            verificationJson: JSON.stringify(verification), acceptedVerificationJson: JSON.stringify(verification),
            error: anchorChanged ? "DuoPlus accepted the profile, but the anchor changed during apply. Prepare a new environment." : null,
          },
        });
        await tx.device.update({ where: { id: deviceId }, data: { wifiMac: submitted.mac } });
      });
      await verifyWifi(imageId, tenantId, verification);
      const accepted = await prisma.$transaction(async (tx) => {
        const current = await tx.device.findUniqueOrThrow({ where: { id: deviceId } });
        const anchorChanged = current.anchorLat !== profile.anchor.lat || current.anchorLng !== profile.anchor.lng;
        const result = await tx.deviceEnvironment.update({
          where: { deviceId, revision },
          data: {
            status: anchorChanged || verification.wifi.status === "MISMATCH" ? "FAILED" : "ACCEPTED",
            verificationJson: JSON.stringify(verification), acceptedVerificationJson: JSON.stringify(verification),
            error: anchorChanged ? "DuoPlus accepted the profile, but the anchor changed during apply. Prepare a new environment." : verification.wifi.error,
          },
        });
        if (verification.wifi.status === "VERIFIED") {
          await tx.device.update({ where: { id: deviceId }, data: {
            wifiSsid: submitted.name, wifiBssid: submitted.bssid, wifiMac: submitted.mac,
            wifiLocked: true, ...(profile.source ? {} : { wigleQueriedAt: row.preparedAt }),
          } });
        }
        return result;
      });
      return environmentView(accepted);
    } catch (error) {
      const message = error instanceof HttpError ? error.message : "Environment acceptance could not be confirmed. Review the device before retrying.";
      await prisma.deviceEnvironment.updateMany({ where: { deviceId, revision, status: "APPLYING" }, data: { status: "FAILED", error: message } });
      throw error;
    }
  });
}

export async function recheckEnvironment(deviceId: string, tenantId: string, revision: string) {
  await ownDevice(deviceId, tenantId);
  return exclusive(deviceId, async () => {
    const device = await ownDevice(deviceId, tenantId);
    const row = await prisma.deviceEnvironment.findUnique({ where: { deviceId } });
    const verification = readVerification(row?.acceptedVerificationJson ?? null);
    if (!row?.acceptedJson || !row.acceptedAt || verification?.revision !== revision || !verification.wifi.expected) {
      throw new HttpError(409, "This accepted Wi-Fi revision is no longer available to recheck");
    }
    if (row.status === "APPLYING") throw new HttpError(409, "This device's environment is being applied");
    await verifyWifi(device.imageId, tenantId, verification);
    const json = JSON.stringify(verification);
    return prisma.$transaction(async (tx) => {
      const current = await tx.device.findFirst({ where: { id: deviceId, tenantId } });
      if (!current) throw new HttpError(404, "Device not found");
      if (current.imageId !== device.imageId || await tx.site.count({ where: { deviceId } })) {
        throw new HttpError(409, "The phone changed while its Wi-Fi was being rechecked");
      }
      const latest = await tx.deviceEnvironment.findUnique({ where: { deviceId } });
      if (!latest || latest.status === "APPLYING" || latest.acceptedVerificationJson !== row.acceptedVerificationJson ||
          latest.acceptedJson !== row.acceptedJson) {
        throw new HttpError(409, "The accepted environment changed. Review it before rechecking Wi-Fi.");
      }
      const profile = profileSchema.parse(JSON.parse(row.acceptedJson!));
      const anchorChanged = current.anchorLat !== profile.anchor.lat || current.anchorLng !== profile.anchor.lng;
      const failed = anchorChanged || Boolean(profile.cell) || verification.wifi.status === "MISMATCH";
      const error = profile.cell ? CELL_UPDATE_UNAVAILABLE : anchorChanged ?
        "The anchor changed. Prepare a new environment." : verification.wifi.error;
      // An older accepted revision remains inspectable without replacing a newer preview.
      const updated = await tx.deviceEnvironment.updateMany({
        where: { deviceId, revision: latest.revision, status: { not: "APPLYING" },
          acceptedVerificationJson: row.acceptedVerificationJson, acceptedJson: row.acceptedJson },
        data: { acceptedVerificationJson: json, ...(latest.revision === revision ? {
          verificationJson: json, status: failed ? "FAILED" : "ACCEPTED", error,
        } : {}) },
      });
      if (updated.count !== 1) throw new HttpError(409, "The environment changed during Wi-Fi recheck. Review the latest result.");
      return environmentView(await tx.deviceEnvironment.findUniqueOrThrow({ where: { deviceId } }), current);
    });
  });
}

export async function recoverInterruptedEnvironments(): Promise<void> {
  await prisma.deviceEnvironment.updateMany({
    where: { status: "APPLYING" },
    data: { status: "FAILED", error: "The controller restarted before acceptance was recorded. Review the device before retrying." },
  });
  const rows = await prisma.deviceEnvironment.findMany({ where: { acceptedVerificationJson: { not: null } } });
  for (const row of rows) {
    const accepted = readVerification(row.acceptedVerificationJson);
    if (accepted?.wifi.status !== "PENDING") continue;
    accepted.wifi.status = "UNAVAILABLE";
    accepted.wifi.error = "The controller restarted after API acceptance but before Wi-Fi readback was recorded. Review the device; the update was not resent.";
    const json = JSON.stringify(accepted);
    await prisma.deviceEnvironment.updateMany({
      where: { deviceId: row.deviceId, revision: row.revision },
      data: {
        acceptedVerificationJson: json,
        ...(readVerification(row.verificationJson)?.revision === accepted.revision ? { verificationJson: json } : {}),
      },
    });
  }
}
