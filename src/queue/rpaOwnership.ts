import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../http/errors.js";
import { unresolvedRpaStatuses } from "./rpaDelivery.js";

export async function assertNoPendingRpa(deviceId: string, tx: Prisma.TransactionClient = prisma): Promise<void> {
  const device = await tx.device.findUnique({ where: { id: deviceId }, select: { imageId: true } });
  if (!device) throw new HttpError(404, "Device not found");
  if (await tx.rpaJob.count({ where: { device: { imageId: device.imageId }, status: { in: unresolvedRpaStatuses } } })) {
    throw new HttpError(409, "This physical phone has unresolved legacy RPA work. Review and resolve it before assigning new work.");
  }
}
