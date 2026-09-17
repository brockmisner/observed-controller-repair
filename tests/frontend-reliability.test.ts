import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import vm from "node:vm";
import { tryServeStatic } from "../src/http/static.js";

const context = { module: { exports: {} as Record<string, any> } };
vm.runInNewContext(readFileSync(new URL("../public/polling.js", import.meta.url), "utf8"), context);
const { singleFlight, snapshotNeeded } = context.module.exports;
const deferred = <T = string>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

test("slow workspace reads share one in-flight request", async () => {
  const response = deferred(); let calls = 0;
  const load = singleFlight(() => { calls++; return response.promise; });
  const reads = [load(), load(), load()];
  await Promise.resolve(); assert.equal(calls, 1);
  response.resolve("snapshot");
  assert.deepEqual(await Promise.all(reads), ["snapshot", "snapshot", "snapshot"]);
});

test("a mutation during a slow read refreshes once after the old read settles", async () => {
  const old = deferred(), fresh = deferred(); let revision = 0, calls = 0, active = 0, maximumActive = 0;
  const load = singleFlight(() => {
    active++; maximumActive = Math.max(maximumActive, active);
    return (++calls === 1 ? old.promise : fresh.promise).finally(() => { active--; });
  }, () => revision);
  const first = load(); await Promise.resolve(); revision++;
  const second = load(), third = load();
  assert.equal(calls, 1);
  old.resolve("old"); await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2); assert.equal(maximumActive, 1);
  fresh.resolve("fresh"); assert.deepEqual(await Promise.all([second, third]), ["fresh", "fresh"]);
});

test("an expired session's failed read does not block a new session refresh", async () => {
  const old = deferred(); let revision = 0, calls = 0;
  const load = singleFlight(() => ++calls === 1 ? old.promise : Promise.resolve("new session"), () => revision);
  const first = load(); const failure = assert.rejects(first, /expired/); await Promise.resolve();
  revision++; const second = load(); old.reject(new Error("expired"));
  await failure; assert.equal(await second, "new session"); assert.equal(calls, 2);
});

test("background tabs and inactive workspaces do not request full fleet snapshots", () => {
  const visible = { hidden: false, authenticated: true, hasSnapshot: true, section: "devices", diagnosticsOpen: false };
  assert.equal(snapshotNeeded(visible), true);
  assert.equal(snapshotNeeded({ ...visible, hidden: true }), false);
  assert.equal(snapshotNeeded({ ...visible, authenticated: false }), false);
  assert.equal(snapshotNeeded({ ...visible, section: "warmup" }), false);
  assert.equal(snapshotNeeded({ ...visible, section: "sites" }), false);
  assert.equal(snapshotNeeded({ ...visible, section: "sites", hasSnapshot: false }), true);
  assert.equal(snapshotNeeded({ ...visible, section: "sites", diagnosticsOpen: true }), true);
});

function warmupHarness(api: () => Promise<unknown>) {
  const elements = new Map<string, any>();
  function element(id: string): any {
    if (!elements.has(id)) elements.set(id, {
      value: id === "warmupStatus" ? "all" : "", hidden: false, textContent: "", innerHTML: "", dataset: {},
      classList: { toggle() {} }, addEventListener() {}, querySelectorAll: () => [], reset() {},
      elements: new Proxy({}, { get: (_, name) => element(`${id}:${String(name)}`) }),
    });
    return elements.get(id);
  }
  const window: Record<string, any> = { ObservatoryPolling: { singleFlight } };
  const document = { hidden: false, getElementById: element, addEventListener() {}, body: { insertAdjacentHTML() {} } };
  vm.runInNewContext(readFileSync(new URL("../public/warmup.js", import.meta.url), "utf8"), { window, document });
  const warmup = window.ObservatoryWarmup.create({ api, openModal() {}, closeModal() {} });
  return { warmup, element };
}
const warmupView = (name: string) => ({ campaigns: [], devices: [], runtime: {},
  cities: [{ id: name, name, timezone: "UTC", radiusM: 1000, counts: { WIFI: 0, CELL: 0, BLUETOOTH: 0 } }] });
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Warmup queues a forced refresh behind a slow poll and never renders its stale response", async () => {
  const old = deferred<unknown>(), fresh = deferred<unknown>(); let calls = 0, active = 0, maximumActive = 0;
  const { warmup, element } = warmupHarness(() => {
    active++; maximumActive = Math.max(maximumActive, active);
    return (++calls === 1 ? old.promise : fresh.promise).finally(() => { active--; });
  });
  warmup.update(); await nextTurn();
  const reloaded = warmup.reload();
  assert.equal(calls, 1);
  old.resolve(warmupView("Outdated city")); await nextTurn();
  assert.equal(calls, 2); assert.equal(maximumActive, 1);
  assert.equal(element("warmupCities").innerHTML, "");
  fresh.resolve(warmupView("Fresh city")); await reloaded;
  assert.match(element("warmupCities").innerHTML, /Fresh city/);
  assert.doesNotMatch(element("warmupCities").innerHTML, /Outdated city/);
});

test("Warmup clears an old session while its queued refresh is pending without rendering its error", async () => {
  const old = deferred<unknown>(), fresh = deferred<unknown>(); let calls = 0;
  const { warmup, element } = warmupHarness(() => ++calls === 1 ? old.promise : fresh.promise);
  warmup.update(); await nextTurn();
  const queued = warmup.reload();
  warmup.clear(); warmup.update();
  old.reject(new Error("Previous account expired")); await nextTurn();
  assert.equal(calls, 2); assert.equal(element("warmupFeedback").textContent, "");
  fresh.resolve(warmupView("New account city")); await queued;
  assert.match(element("warmupCities").innerHTML, /New account city/);
  assert.equal(element("warmupCityModalForm").dataset.submitting, "false");
});

test("asset revalidation saves response bytes without caching HTML or making mutable scripts immutable", async (t) => {
  const server = createServer((req, res) => { if (!tryServeStatic(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const asset = await fetch(`${base}/polling.js`); const body = await asset.text();
  assert.equal(asset.status, 200); assert.ok(body.includes("singleFlight"));
  assert.equal(asset.headers.get("cache-control"), "public, no-cache");
  const etag = asset.headers.get("etag"); assert.ok(etag);
  const unchanged = await fetch(`${base}/polling.js`, { headers: { "If-None-Match": etag } });
  assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), "");
  const changed = await fetch(`${base}/polling.js`, { headers: { "If-None-Match": '"old-deployment"' } });
  assert.equal(changed.status, 200); await changed.text();
  const html = await fetch(base, { headers: { "If-None-Match": "*" } });
  assert.equal(html.status, 200); assert.equal(html.headers.get("cache-control"), "no-store"); await html.text();
  const vendor = await fetch(`${base}/vendor/leaflet-1.9.4/leaflet.js`);
  assert.equal(vendor.status, 200); assert.match(vendor.headers.get("cache-control")!, /immutable/); await vendor.text();
});
