import test from "node:test";
import assert from "node:assert/strict";
import { deliverRpaIntent, unresolvedRpaStatuses, type RpaIntent } from "../src/queue/rpaDelivery.js";
import { listLegacyRpaJobs, resolveLegacyRpaJob } from "../src/queue/rpaLifecycle.js";

const intent: RpaIntent = { id: "rpa-a", deviceId: "phone-a", templateId: "template-a", templateType: 2,
  name: "Search", variablesJson: '{"query":"coffee"}', status: "enqueue_pending",
  device: { tenantId: "tenant-a", imageId: "image-a" } };

test("Redis failure leaves a durable pending intent, then retries the same provider job identity", async () => {
  const submitted: string[] = [];
  let marked = 0;
  assert.equal(await deliverRpaIntent(intent, { enqueue: async data => { submitted.push(data.rpaJobId); throw new Error("Redis unavailable"); },
    markQueued: async () => { marked++; } }), "pending");
  assert.equal(marked, 0);
  assert.equal(await deliverRpaIntent(intent, { enqueue: async data => { submitted.push(data.rpaJobId); return `rpa-${data.rpaJobId}`; },
    markQueued: async () => { marked++; } }), "queued");
  assert.deepEqual(submitted, ["rpa-a", "rpa-a"]);
  assert.equal(marked, 1);
  assert.ok(unresolvedRpaStatuses.includes("enqueue_pending"));
});

test("outbox never automatically repeats a possibly submitted or resolved intent", async () => {
  for (const status of ["submitting", "submitted", "unconfirmed", "resolved_cancelled", "resolved_completed"]) {
    await assert.rejects(deliverRpaIntent({ ...intent, status }, { enqueue: async () => { assert.fail("Provider work must not be replayed"); }, markQueued: async () => {} }));
  }
});

test("loss of the database acknowledgment after enqueue remains pending for safe reconciliation", async () => {
  assert.equal(await deliverRpaIntent(intent, { enqueue: async () => "stable-job-id", markQueued: async () => { throw new Error("Database disconnected"); } }), "pending");
});

function fixture(status = "submitted") {
  let row: any = { id: "rpa-a", deviceId: "phone-a", templateId: "template-a", templateType: 2, name: "Search", variablesJson: '{"secret":"not public"}',
    status, error: "Original provider diagnostic", createdAt: new Date("2026-09-17T10:00:00Z"), updatedAt: new Date("2026-09-17T11:00:00Z") };
  const events: any[] = [];
  const queries: any[] = [];
  let owns = true, leaseChecks = 0, loseCas = false;
  const db: any = {
    device: { count: async ({ where }: any) => Number(owns && where.id === "phone-a" && where.tenantId === "tenant-a") },
    rpaJob: {
      findFirst: async ({ where }: any) => where.id === row.id && where.deviceId === row.deviceId && where.device?.tenantId === "tenant-a" ? { ...row } : null,
      findMany: async ({ where }: any) => { queries.push(where); return where.status.in?.includes(row.status) || where.status.notIn && !where.status.notIn.includes(row.status) ? [{ ...row }] : []; },
      updateMany: async ({ where, data }: any) => {
        if (loseCas || row.status !== where.status || +row.updatedAt !== +where.updatedAt || where.device.tenantId !== "tenant-a") return { count: 0 };
        row = { ...row, ...data, updatedAt: new Date("2026-09-17T12:00:00Z") }; return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ ...row }),
    },
    deviceEvent: { create: async ({ data }: any) => { events.push(data); return data; } },
    $transaction: async (work: any) => work(db),
  };
  const deps = { db, withLease: async (_device: string, _tenant: string, work: any) => work({ assertOwned: async () => { leaseChecks++; } }) };
  const input = { outcome: "completed", evidence: "Checked the provider; task finished successfully and the phone is idle.", providerIdleConfirmed: true,
    expectedUpdatedAt: row.updatedAt.toISOString() };
  return { deps, input, events, queries, row: () => row, leaseChecks: () => leaseChecks,
    denyTenant: () => { owns = false; }, loseCas: () => { loseCas = true; } };
}

test("operator resolution releases a submitted job and preserves its original evidence", async () => {
  const f = fixture();
  const result = await resolveLegacyRpaJob("phone-a", "tenant-a", "rpa-a", f.input, f.deps);
  assert.equal(result.job.status, "resolved_completed");
  assert.equal(result.job.canResolve, false);
  assert.equal(f.row().error, "Original provider diagnostic");
  assert.equal(f.leaseChecks(), 1);
  assert.equal(f.events.length, 1);
  const evidence = JSON.parse(f.events[0].detail);
  assert.equal(evidence.previousStatus, "submitted");
  assert.equal(evidence.previousError, "Original provider diagnostic");
  assert.equal(evidence.verification, "OPERATOR_ATTESTATION");
  assert.equal(evidence.evidence, f.input.evidence);
});

test("resolution requires tenant ownership, explicit idle confirmation, and the current revision", async () => {
  const f = fixture();
  for (const input of [{ ...f.input, providerIdleConfirmed: false }, { ...f.input, evidence: "" },
    { ...f.input, expectedUpdatedAt: "2026-09-17T09:00:00.000Z" }]) {
    await assert.rejects(resolveLegacyRpaJob("phone-a", "tenant-a", "rpa-a", input, f.deps));
  }
  await assert.rejects(resolveLegacyRpaJob("phone-a", "other-tenant", "rpa-a", f.input, f.deps));
  assert.equal(f.events.length, 0);
  assert.equal(f.row().status, "submitted");
});

test("concurrent changes prevent resolution and do not create false audit evidence", async () => {
  const f = fixture(); f.loseCas();
  await assert.rejects(resolveLegacyRpaJob("phone-a", "tenant-a", "rpa-a", f.input, f.deps));
  assert.equal(f.events.length, 0);
  assert.equal(f.row().status, "submitted");
});

test("pending work can be cancelled but cannot be claimed completed", async () => {
  const f = fixture("enqueue_pending");
  await assert.rejects(resolveLegacyRpaJob("phone-a", "tenant-a", "rpa-a", f.input, f.deps));
  const result = await resolveLegacyRpaJob("phone-a", "tenant-a", "rpa-a", { ...f.input, outcome: "cancelled" }, f.deps);
  assert.equal(result.job.status, "resolved_cancelled");
  assert.equal(unresolvedRpaStatuses.includes(result.job.status), false);
  await assert.rejects(resolveLegacyRpaJob("phone-a", "tenant-a", "rpa-a", f.input, f.deps));
});

test("job list includes pending ownership and omits task variable secrets", async () => {
  const f = fixture("enqueue_pending");
  const result = await listLegacyRpaJobs("phone-a", "tenant-a", f.deps);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0]!.canResolve, true);
  assert.equal(result.jobs[0]!.canConfirmCompleted, false);
  assert.equal("variablesJson" in result.jobs[0]!, false);
  assert.ok(f.queries.every(q => q.deviceId === "phone-a" && q.device.tenantId === "tenant-a"));
});
