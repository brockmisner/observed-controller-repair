import type { Device } from "@prisma/client";
import { fetchDevicePowerObservation } from "../api/duoPlusClient.js";
import { prisma } from "../db.js";
import { HttpError } from "../http/errors.js";
import { logger } from "../logger.js";

async function ownDevice(deviceId: string, tenantId: string): Promise<Device> {
  const device = await prisma.device.findFirst({ where: { id: deviceId, tenantId } });
  if (!device) throw new HttpError(404, "Device not found");
  return device;
}

export async function recordPowerObservation(
  deviceId: string,
  tenantId: string,
  status: number | null,
  checkedAt: Date,
): Promise<Device> {
  const device = await ownDevice(deviceId, tenantId);
  if (!Number.isFinite(checkedAt.getTime()) || checkedAt.getTime() > Date.now() ||
      (status !== null && ![0, 1, 2, 3, 4, 10, 11, 12].includes(status))) {
    throw new HttpError(400, "Invalid power observation");
  }
  const written = await prisma.device.updateMany({
    where: { id: device.id, tenantId, OR: [{ lastPowerSyncAt: null }, { lastPowerSyncAt: { lte: checkedAt } }] },
    data: {
      duoPlusStatus: status,
      poweredOn: status === null ? device.poweredOn : status === 1,
      lastPowerSyncAt: checkedAt,
      ...(status === 1 ? { lastSeenOnAt: checkedAt } : {}),
    },
  });
  const current = await ownDevice(deviceId, tenantId);
  logger.info({
    tenantId, deviceId, providerStatus: status, persistedStatus: current.duoPlusStatus,
    checkedAt, persistedAt: current.lastPowerSyncAt,
    superseded: !written.count || current.lastPowerSyncAt?.getTime() !== checkedAt.getTime() || current.duoPlusStatus !== status,
  }, "DuoPlus power observation");
  return current;
}

export async function checkDevicePower(deviceId: string, tenantId: string): Promise<Device> {
  const device = await ownDevice(deviceId, tenantId);
  const { status, checkedAt } = await fetchDevicePowerObservation(device.imageId, tenantId);
  return recordPowerObservation(device.id, tenantId, status, checkedAt);
}
