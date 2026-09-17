import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { enqueueRpa } from "./producer.js";
import { producerConnection } from "./connection.js";
import { deliverRpaIntent, pendingRpaStatuses, type RpaIntent } from "./rpaDelivery.js";

export async function deliverSavedRpaIntent(intent: RpaIntent) {
  return deliverRpaIntent(intent, {
    enqueue: data => enqueueRpa(data, async () => Boolean(await prisma.rpaJob.count({ where: { id: data.rpaJobId, status: { in: pendingRpaStatuses } } }))),
    markQueued: async (id) => {
      await prisma.rpaJob.updateMany({ where: { id, status: "enqueue_pending" }, data: { status: "queued", error: null } });
    },
  });
}

export function startRpaOutbox(): { stop(): Promise<void> } {
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let cursor: string | undefined;
  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = (async () => {
      // Include legacy queued rows: a process can die between its DB write and
      // Redis add. The worker's DB claim prevents dispatching a row twice.
      const intents = await prisma.rpaJob.findMany({
        where: { status: { in: pendingRpaStatuses } }, include: { device: { select: { tenantId: true, imageId: true } } },
        orderBy: { id: "asc" }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      cursor = intents.length === 100 ? intents.at(-1)!.id : undefined;
      for (const intent of intents) {
        if (stopped) break;
        const delivery = await deliverSavedRpaIntent(intent);
        if (delivery === "pending" && producerConnection.status !== "ready") break;
      }
    })().catch(() => logger.warn("RPA outbox reconciliation unavailable"))
      .finally(() => { inFlight = undefined; });
  };
  const timer = setInterval(tick, 5000);
  tick();
  return { async stop() { stopped = true; clearInterval(timer); await inFlight; } };
}
