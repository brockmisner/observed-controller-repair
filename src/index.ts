import { recoverWarmup, startWarmupPlanner } from "./warmup/runner.js";
import { initializePlayer } from "./trips/playerConnection.js";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keyPool } from "./api/keyPool.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { startHttpServer } from "./http/server.js";
import { logger } from "./logger.js";
import { startFleetSync } from "./orchestrator/fleetSync.js";
import { startScheduler } from "./orchestrator/scheduler.js";
import { redisConnection, producerConnection } from "./queue/connection.js";
import { startRpaWorker } from "./queue/rpaWorker.js";
import { startRpaOutbox } from "./queue/rpaOutbox.js";
import { closeQueues } from "./queue/queues.js";
import { startTelemetryWorker } from "./queue/telemetryWorker.js";
import { recoverInterruptedEnvironments } from "./orchestrator/environment.js";
import { recoverTrips, startTripScheduler } from "./trips/runner.js";
import { recoverSiteWork, startSitePlanner } from "./sites/jobs.js";

function ensureSqliteDir(): void {
  const url = config.databaseUrl;
  if (!url.startsWith("file:")) return;
  const raw = url.slice("file:".length);
  const schemaDir = resolve(fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)), "..");
  const dbPath = raw.startsWith("/") ? raw : resolve(schemaDir, raw);
  mkdirSync(dirname(dbPath), { recursive: true });
}

async function main(): Promise<void> {
  logger.info("observatory controller boot");
  ensureSqliteDir();
  await prisma.$connect();
  await recoverInterruptedEnvironments();
  await recoverTrips();
  await initializePlayer();
  await recoverSiteWork();
  await recoverWarmup();
  await keyPool.ensureRows();

  const telemetryWorker = startTelemetryWorker();
  const rpaWorker = startRpaWorker();
  const rpaOutbox = startRpaOutbox();
  const fleetSync = startFleetSync();
  const scheduler = startScheduler(400);
  const trips = startTripScheduler();
  const sites = startSitePlanner();
  const warmup = startWarmupPlanner();
  const http = startHttpServer();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    // An unavailable Redis must not prevent process termination. Any RPA already
    // marked submitting remains owned and requires reconciliation after restart.
    const deadline = setTimeout(() => {
      logger.error("Shutdown deadline reached; unfinished work remains recorded for recovery");
      producerConnection.disconnect();
      redisConnection.disconnect();
      process.exit(1);
    }, 25_000);
    deadline.unref();
    fleetSync.stop();
    clearInterval(scheduler);
    http.close();
    await rpaOutbox.stop();
    await trips.stop();
    await sites.stop();
    await warmup.stop();
    await Promise.allSettled([telemetryWorker.close(), rpaWorker.close()]);
    await closeQueues();
    redisConnection.disconnect();
    await prisma.$disconnect();
    clearTimeout(deadline);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandled rejection trapped — daemon stays up");
  });
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "uncaught exception trapped — daemon stays up");
  });
}

main().catch((err) => {
  logger.error({ err }, "fatal boot error");
  process.exit(1);
});
