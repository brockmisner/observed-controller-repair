import { tenantKeyCount } from "../api/tenantKeys.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { reserveMovement } from "./deviceOperations.js";
import { proposeDevice } from "./physicsTick.js";
import { deferGps, dispatchGps, gpsElapsedMs, gpsEligibility, gpsIsDue, type GpsProposal } from "./locationDispatch.js";
import type { Device } from "@prisma/client";

// A power transition must not erase the last dispatch's cooldown.
export function dropSidecar(_deviceId: string): void {}

export async function hookWake(device: Device): Promise<boolean> {
  if (device.phase !== "NAVIGATING") return false;
  const release = reserveMovement(device.id);
  if (!release) return false;
  try {
    const current = await prisma.device.findFirst({ where: { ...gpsEligibility(device.tenantId, [device.id]), phase: "NAVIGATING" } });
    if (!current || !await gpsIsDue(device.id)) return false;
    const proposed = proposeDevice(current, gpsElapsedMs(device.id));
    await dispatchGps([{ device: current, proposed }], "WAKE");
    return true;
  } finally {
    release();
  }
}

export async function jitterAwake(devices: Device[]): Promise<void> {
  const byTenant = new Map<string, Array<{ device: Device; release: () => void }>>();
  for (const device of devices) {
    if (device.phase !== "NAVIGATING") continue;
    const release = reserveMovement(device.id);
    if (!release) continue;
    try {
      if (!await gpsIsDue(device.id)) { release(); continue; }
      const list = byTenant.get(device.tenantId) ?? [];
      list.push({ device, release });
      byTenant.set(device.tenantId, list);
    } catch (err) {
      release();
      logger.warn({ deviceId: device.id, err }, "GPS pacing lookup failed");
    }
  }

  for (const [tenantId, reservations] of byTenant) {
    try {
      if (await tenantKeyCount(tenantId) === 0) continue;
      const current = new Map((await prisma.device.findMany({
        where: { ...gpsEligibility(tenantId, reservations.map(({ device }) => device.id)), phase: "NAVIGATING" },
      })).map((device) => [device.id, device]));
      const ready: Array<GpsProposal & { release: () => void }> = [];
      for (const reservation of reservations) {
        const device = current.get(reservation.device.id);
        if (!device) { reservation.release(); continue; }
        try {
          ready.push({ device, proposed: proposeDevice(device, gpsElapsedMs(device.id)), release: reservation.release });
        } catch (err) {
          deferGps(device.id);
          reservation.release();
          logger.warn({ tenantId, deviceId: device.id, err }, "device jitter skipped");
        }
      }
      for (let offset = 0; offset < ready.length; offset += 20) {
        const batch = ready.slice(offset, offset + 20);
        try {
          await dispatchGps(batch, "JITTER");
        } finally {
          for (const reservation of batch) reservation.release();
        }
      }
    } catch (err) {
      logger.warn({ tenantId, err }, "tenant jitter skipped");
    } finally {
      for (const reservation of reservations) reservation.release();
    }
  }
}

