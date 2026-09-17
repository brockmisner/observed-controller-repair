// Isolated SQLite + Redis + real BullMQ worker. Provider I/O is replaced below.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import assert from "node:assert/strict";
const dir = mkdtempSync(join(tmpdir(), "observatory-rpa-test-"));
const probe = createServer();
await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = (probe.address() as { port: number }).port;
await new Promise<void>(resolve => probe.close(() => resolve()));
Object.assign(process.env, { DATABASE_URL: `file:${dir}/test.db`, DATABASE_PROVIDER: "sqlite", NODE_ENV: "test", DRY_RUN: "false",
  REDIS_URL: `redis://127.0.0.1:${port}`, REDIS_PRIVATE_URL: "", DUOPLUS_API_KEYS: "", LOG_LEVEL: "silent" });
process.env.SITE_RPA_TIMEZONE = "UTC";
let redis: ChildProcess | undefined;
async function startRedis() {
  redis = spawn(process.env.REDIS_SERVER_BINARY || "redis-server", ["--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no", "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Local Redis did not start")), 5000);
    redis!.once("error", error => { clearTimeout(timer); reject(error); });
    redis!.stdout!.on("data", data => { if (data.toString().includes("Ready to accept connections")) { clearTimeout(timer); resolve(); } });
  });
}
async function stopRedis() {
  if (!redis || !redis.pid || redis.exitCode !== null || redis.signalCode !== null) return;
  const closed = once(redis, "exit"); redis.kill("SIGTERM"); await closed;
}
async function until(check: () => Promise<boolean> | boolean, message: string) {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 25)); }
}
let worker: import("bullmq").Worker | undefined;
let outbox: { stop(): Promise<void> } | undefined;
let closeQueues: (() => Promise<void>) | undefined;
let connections: any;
let prisma: any;
let passed = 0;
async function check(name: string, work: () => Promise<void>) { await work(); console.log(`PASS ${name}`); passed++; }
try {
  await startRedis();
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { env: { ...process.env, RUST_LOG: "info" }, stdio: "pipe", timeout: 60000 });
  ({ prisma } = await import("../src/db.js"));
  connections = await import("../src/queue/connection.js");
  const queues = await import("../src/queue/queues.js"); closeQueues = queues.closeQueues;
  const { enqueueRpa } = await import("../src/queue/producer.js");
  const { queueSearch } = await import("../src/orchestrator/registry.js");
  const { assertNoPendingRpa } = await import("../src/queue/rpaOwnership.js");
  const { resolveLegacyRpaJob } = await import("../src/queue/rpaLifecycle.js");
  const { startRpaWorker } = await import("../src/queue/rpaWorker.js");
  const { startRpaOutbox, deliverSavedRpaIntent } = await import("../src/queue/rpaOutbox.js");
  await until(() => connections.producerConnection.status === "ready", "Producer did not connect");
  await prisma.tenant.createMany({ data: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
  for (const [id, tenantId] of [["phone", "a"], ["duplicate", "b"]]) {
    await prisma.device.create({ data: { id, tenantId, imageId: "same-physical-image", campaignEnd: new Date(Date.now() + 86400000),
      anchorLat: 25, anchorLng: -80, currentLat: 25, currentLng: -80, wifiSsid: "Existing", wifiBssid: "aa:bb:cc:dd:ee:00", wifiMac: "aa:bb:cc:dd:ee:02", active: true, poweredOn: true, duoPlusStatus: 1, lastPowerSyncAt: new Date() } });
  }
  let first: any;
  await check("HTTP retry identity and cross-workspace phone ownership", async () => {
    first = await queueSearch("phone", "template", { b: 2, a: 1 }, "Search", "a", "request-0001");
    const again = await Promise.all([1, 2].map(() => queueSearch("phone", "template", { a: 1, b: 2 }, "Search", "a", "request-0001")));
    assert.ok(again.every(result => result.jobId === first.jobId)); assert.equal(await prisma.rpaJob.count(), 1);
    await assert.rejects(queueSearch("phone", "different", {}, "Search", "a", "request-0001"));
    await assert.rejects(queueSearch("duplicate", "template", {}, "Search", "b", "request-0002"));
    await assert.rejects(assertNoPendingRpa("duplicate"));
  });
  let submissions = 0, loseResponse = false;
  let gate: Promise<void> | undefined;
  worker = startRpaWorker({ trigger: async (_image, _template, _vars, options) => {
    await options?.beforeSend?.(); submissions++;
    await gate;
    if (loseResponse) throw new Error("Simulated provider response loss");
    return { accepted: true };
  } });
  const row = (id: string) => prisma.rpaJob.findUniqueOrThrow({ where: { id } });
  const resolve = async (id: string, deviceId = "phone", tenantId = "a", outcome = "completed") => {
    const current = await row(id);
    return resolveLegacyRpaJob(deviceId, tenantId, id, { outcome, evidence: "Verified provider task is finished and no run remains active.", providerIdleConfirmed: true,
      expectedUpdatedAt: current.updatedAt.toISOString() });
  };
  await check("real worker dispatches once and accepted work is never replayed", async () => {
    await until(async () => (await row(first.jobId)).status === "submitted", "First job did not submit");
    const again = await queueSearch("phone", "template", { a: 1, b: 2 }, "Search", "a", "request-0001");
    assert.equal(again.delivery, "settled"); assert.equal(submissions, 1);
    await assert.rejects(resolve(first.jobId, "duplicate", "b"));
    await resolve(first.jobId);
    await assertNoPendingRpa("duplicate");
    const audit = await prisma.deviceEvent.findFirstOrThrow({ where: { kind: "LEGACY_RPA_RESOLVED" } });
    assert.equal(JSON.parse(audit.detail).previousStatus, "submitted");
  });
  await check("cancelled pending intent cannot be submitted by a queued worker", async () => {
    await worker!.pause();
    const pending = await queueSearch("duplicate", "template", {}, "Search", "b", "request-0003");
    await resolve(pending.jobId, "duplicate", "b", "cancelled");
    worker!.resume();
    await until(async () => (await queues.rpaQueue.getJob(`rpa-${pending.jobId}`))?.getState().then(s => s === "completed") ?? false, "Cancelled queue job was not consumed");
    assert.equal(submissions, 1); await assertNoPendingRpa("phone");
  });
  await check("uncertain remote submission remains owned and cannot be retried", async () => {
    loseResponse = true;
    const pending = await queueSearch("phone", "template", {}, "Search", "a", "request-0004");
    await until(async () => (await row(pending.jobId)).status === "unconfirmed", "Unconfirmed job not retained");
    assert.equal(submissions, 2);
    await assert.rejects(assertNoPendingRpa("duplicate"));
    await queueSearch("phone", "template", {}, "Search", "a", "request-0004");
    assert.equal(submissions, 2);
    await resolve(pending.jobId, "phone", "a", "cancelled"); loseResponse = false;
  });
  await check("operator resolution waits for active dispatch and rejects stale evidence", async () => {
    let release!: () => void;
    gate = new Promise<void>(r => { release = r; });
    const pending = await queueSearch("phone", "template", {}, "Search", "a", "request-0005");
    await until(async () => (await row(pending.jobId)).status === "submitting", "Dispatch never entered submitting");
    const resolving = resolve(pending.jobId).then(() => "resolved", () => "stale");
    await new Promise(r => setTimeout(r, 150));
    assert.equal((await row(pending.jobId)).status, "submitting");
    release(); gate = undefined;
    assert.equal(await resolving, "stale");
    assert.equal((await row(pending.jobId)).status, "submitted");
    await resolve(pending.jobId); assert.equal(submissions, 3);
  });
  await check("retained failed queue record is repaired only for a pending database intent", async () => {
    const data = { rpaJobId: "reconcile", tenantId: "a", deviceId: "phone", imageId: "same-physical-image", templateId: "template", templateType: 2 as const, name: "Reconcile", variables: {} };
    await enqueueRpa(data);
    await until(async () => (await queues.rpaQueue.getJob("rpa-reconcile"))?.getState().then(s => s === "failed") ?? false, "Missing SQL job did not fail");
    await prisma.rpaJob.create({ data: { id: data.rpaJobId, deviceId: "phone", templateId: "template", name: "Reconcile", status: "enqueue_pending" } });
    await enqueueRpa(data, async () => (await row("reconcile")).status === "enqueue_pending");
    await until(async () => (await row("reconcile")).status === "submitted", "Terminal queue row did not recover");
    assert.equal(submissions, 4);
    await enqueueRpa(data, async () => false);
    assert.equal(submissions, 4); await resolve("reconcile");
  });
  await check("offline producer fails promptly and sends no command after reconnect", async () => {
    await worker!.close(); worker = undefined;
    await stopRedis();
    await until(() => connections.producerConnection.status !== "ready", "Producer did not detect outage");
    const started = performance.now();
    await assert.rejects(enqueueRpa({ rpaJobId: "must-not-appear", tenantId: "a", deviceId: "phone", imageId: "same-physical-image", templateId: "template", templateType: 2, name: "Offline", variables: {} }));
    assert.ok(performance.now() - started < 500);
    await startRedis();
    await until(() => connections.producerConnection.status === "ready", "Producer did not recover");
    assert.equal(await queues.rpaQueue.getJob("rpa-must-not-appear"), undefined);
  });
  await check("background outbox delivers durable intent after Redis outage recovery", async () => {
    await stopRedis();
    await until(() => connections.producerConnection.status !== "ready", "Producer did not detect second outage");
    const intent = await prisma.rpaJob.create({ data: { id: "durable-outbox", deviceId: "phone", templateId: "template", name: "Durable", status: "enqueue_pending" },
      include: { device: { select: { tenantId: true, imageId: true } } } });
    assert.equal(await deliverSavedRpaIntent(intent), "pending");
    assert.equal((await row(intent.id)).status, "enqueue_pending");
    outbox = startRpaOutbox();
    await startRedis();
    await until(async () => (await row(intent.id)).status === "queued", "Outbox did not recover saved intent");
    const queued = await queues.rpaQueue.getJob(`rpa-${intent.id}`);
    assert.equal(queued?.data.rpaJobId, intent.id);
    assert.equal(queued?.data.tenantId, "a");
    assert.equal(submissions, 4);
    await outbox.stop(); outbox = undefined;
  });
  console.log(`${passed} isolated SQLite/Redis/BullMQ checks passed; provider submissions were stubbed.`);
} finally {
  await outbox?.stop();
  await worker?.close();
  await closeQueues?.();
  connections?.producerConnection.disconnect(); connections?.redisConnection.disconnect();
  await prisma?.$disconnect();
  await stopRedis();
  rmSync(dir, { recursive: true, force: true });
}
