import { config } from "../config.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { jitterAwake } from "./sidecar.js";

let inFlight: Promise<void> | undefined;

export function tickFleet(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runTick().finally(() => { inFlight = undefined; });
  return inFlight;
}

async function runTick(): Promise<void> {
  try {
    const devices = await prisma.device.findMany({
      where: {
        active: true,
        phase: "NAVIGATING",
        activeTripId: null,
        site: { is: null },
        poweredOn: true,
        duoPlusStatus: 1,
        lastPowerSyncAt: { gte: new Date(Date.now() - config.powerStatusMaxAgeMs), lte: new Date() },
        campaignEnd: { gt: new Date() },
        tenant: { keys: { some: { dead: false } } },
      },
    });
    if (devices.length === 0) return;
    await jitterAwake(devices);
  } catch (err) {
    logger.error({ err }, "sidecar jitter failed");
  }
}

export function startScheduler(intervalMs = 500): NodeJS.Timeout {
  logger.info(
    {
      pulseMs: config.fleetPulseMs,
      jitterMs: config.jitterMs,
      onlyWhenPowered: config.telemetryOnlyWhenPowered,
    },
    "reactive sidecar started",
  );
  return setInterval(() => {
    void tickFleet();
  }, intervalMs);
}
