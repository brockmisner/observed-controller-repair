import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const statusContext = { module: { exports: {} as Record<string, any> } };
vm.runInNewContext(readFileSync(new URL("../public/ui-state.js", import.meta.url), "utf8"), statusContext);
const status = statusContext.module.exports;
const now = Date.parse("2026-09-17T12:00:00Z");
const context = { nowMs: now, connected: true, snapshotAt: now, powerStatusMaxAgeMs: 75000 };
const phone = { id: "phone-a", active: true, phase: "STATIONARY", poweredOn: true, duoPlusStatus: 1,
  lastPowerSyncAt: new Date(now - 1000).toISOString(), lastTickAt: new Date(now - 35 * 3600000).toISOString() };

test("an enabled parked phone does not claim that movement is running", () => {
  assert.equal(typeof status.controller, "function", "controller status must distinguish enabled from executing");
  const result = status.controller(phone, context);
  assert.equal(result.code, "idle");
  assert.equal(result.tone, "neutral");
});

test("a stale navigating phone raises attention even with fresh successful fleet polls", () => {
  assert.equal(typeof status.controller, "function");
  const device = { ...phone, phase: "NAVIGATING" };
  assert.equal(status.controller(device, context).code, "stalled");
  assert.equal(status.attention(device, context), true);
});

test("trip readback waits are shown as waiting rather than moving", () => {
  assert.equal(typeof status.controller, "function");
  const device = { ...phone, activeTripId: "trip-a", trip: { id: "trip-a", deviceId: "phone-a",
    status: "RUNNING", pauseReason: "Waiting for phone GPS", lastStepAt: new Date(now).toISOString() } };
  assert.equal(status.controller(device, context).code, "waiting");
});

test("a disconnected browser cannot report current controller activity", () => {
  assert.equal(typeof status.controller, "function");
  assert.equal(status.controller(phone, { ...context, connected: false }).code, "unknown");
});

const clockModule = await import("../src/trips/checkpointClock.js").catch(() => ({})) as Record<string, any>;
test("a 90-second readback delay never turns into 90 seconds of catch-up movement", () => {
  assert.equal(typeof clockModule.checkpointAdvanceMs, "function", "checkpoint time must be bounded separately from provider wait time");
  assert.equal(clockModule.checkpointAdvanceMs(100000, 10000, 1100), 1100);
});

test("checkpoint time preserves early ticks, holds on start, and rejects invalid clocks", () => {
  assert.equal(typeof clockModule.checkpointAdvanceMs, "function");
  assert.equal(clockModule.checkpointAdvanceMs(10100, 10000, 1100), 100);
  assert.equal(clockModule.checkpointAdvanceMs(10100, undefined, 1100), 0);
  assert.equal(clockModule.checkpointAdvanceMs(9000, 10000, 1100), 0);
  assert.throws(() => clockModule.checkpointAdvanceMs(NaN, 10000, 1100));
});

const diagnostics = await import("../src/ops/phoneLocationCheck.js").catch(() => ({})) as Record<string, any>;
const diagnosticPhone = { ...phone, imageId: "demo", tenantId: "workspace-a", activeTripId: null };
test("phone GPS check reports Android evidence without changing model coordinates", async () => {
  assert.equal(typeof diagnostics.checkPhoneLocation, "function");
  const before = JSON.stringify(diagnosticPhone);
  let commands = 0;
  const observation = { state: "UNKNOWN", point: null, reason: "No current fix" };
  const result = await diagnostics.checkPhoneLocation("phone-a", "workspace-a", {
    getDevice: async () => diagnosticPhone,
    observe: async (imageId: string, tenantId: string, validate: () => Promise<void>) => {
      assert.equal(imageId, "demo"); assert.equal(tenantId, "workspace-a");
      await validate(); commands++; return observation;
    },
    now: () => now, powerMaxAgeMs: 75000,
  });
  assert.equal(result.observation, observation);
  assert.equal(commands, 1);
  assert.equal(JSON.stringify(diagnosticPhone), before);
});

test("phone GPS check revalidates tenant, trip ownership and power before dispatch", async () => {
  assert.equal(typeof diagnostics.checkPhoneLocation, "function");
  for (const changed of [
    null,
    { ...diagnosticPhone, tenantId: "workspace-b" },
    { ...diagnosticPhone, imageId: "replacement" },
    { ...diagnosticPhone, activeTripId: "running-trip" },
    { ...diagnosticPhone, phase: "NAVIGATING" },
    { ...diagnosticPhone, duoPlusStatus: 2, poweredOn: false },
    { ...diagnosticPhone, lastPowerSyncAt: new Date(now - 80000).toISOString() },
  ]) {
    let reads = 0;
    let commands = 0;
    await assert.rejects(diagnostics.checkPhoneLocation("phone-a", "workspace-a", {
      getDevice: async () => ++reads === 1 ? diagnosticPhone : changed,
      observe: async (_imageId: string, _tenantId: string, validate: () => Promise<void>) => {
        await validate(); commands++; return { state: "OBSERVED" };
      },
      now: () => now, powerMaxAgeMs: 75000,
    }));
    assert.equal(commands, 0);
  }
});

import { readPhoneLocation } from "../src/api/phoneNavigation.js";
test("phone GPS diagnostics distinguish missing uptime from Android permission denial", () => {
  assert.match(readPhoneLocation("Permission Denial: can't dump LocationManagerService").reason, /permission/i);
  assert.match(readPhoneLocation("Location Manager State:").reason, /uptime/i);
});

import { phoneReadbackFailure } from "../src/api/phoneReadbackFailure.js";
import { readPhoneCommandContent } from "../src/api/phoneNavigation.js";
import { HttpError } from "../src/http/errors.js";
test("readback errors distinguish execution rejection and timeout without leaking raw responses", () => {
  let rejection: unknown;
  try { readPhoneCommandContent({success: false, content: "sensitive provider output"}); }
  catch (error) { rejection = error; }
  assert.match(phoneReadbackFailure(rejection), /rejected the phone command execution/);
  assert.match(phoneReadbackFailure(new HttpError(504, "DuoPlus phone command timed out after 10 seconds.")), /timed out/);
  assert.equal(phoneReadbackFailure(new HttpError(502, "secret API key")), "Android location readback failed unexpectedly.");
  assert.equal(readPhoneCommandContent({success: true, content: "123.0 456.0"}), "123.0 456.0");
});
