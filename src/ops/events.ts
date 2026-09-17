import { prisma } from "../db.js";
import { logger } from "../logger.js";

export async function recordDeviceEvent(deviceId: string, kind: string, detail?: string): Promise<void> {
  try {
    await prisma.deviceEvent.create({ data: { deviceId, kind, detail } });
  } catch (err) {
    logger.debug({ err, deviceId, kind }, "device event not stored");
  }
}

export async function eventsSince(deviceIds: string[], since: Date) {
  if (deviceIds.length === 0) return [];
  try {
    return prisma.deviceEvent.findMany({
      where: { deviceId: { in: deviceIds }, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      take: 400,
    });
  } catch {
    return [];
  }
}
