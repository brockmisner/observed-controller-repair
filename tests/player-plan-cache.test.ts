import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PlayerPlanCache } from '../src/trips/playerPlan.js';

const route = { provider: 'OSRM', points: [{ lat: 25, lng: -80 }, { lat: 25.001, lng: -80 }],
  origin: { lat: 25, lng: -80 }, destination: { lat: 25.001, lng: -80 },
  distanceM: 111.2, durationMs: 60000, staticDurationMs: 60000,
  fetchedAt: '2026-09-17T10:00:00Z', expiresAt: '2026-09-17T11:00:00Z',
  traffic: [{ startIndex: 0, endIndex: 1, category: 'UNKNOWN' }] };
const trip = { id: 'trip', revision: 'revision-1', routeJson: JSON.stringify(route), optionsJson: '{}' };
const session = { sessionId: 'session-1', offsetMs: 0 };
const cache = (options?: ConstructorParameters<typeof PlayerPlanCache>[0]) => new PlayerPlanCache(options);

test('player polls reuse the same immutable samples, serialized bytes and upload digest', () => {
  const c = cache(), first = c.get(trip, session), second = c.get({ ...trip }, { ...session });
  assert.equal(first, second);
  assert.equal(first.plan.samples[0].lat, 25);
  assert.equal(first.plan.samples.at(-1).lat, 25.001);
  assert.equal(first.bytes.toString(), JSON.stringify(first.plan));
  assert.equal(first.sha256, createHash('sha256').update(first.bytes).digest('hex'));
  assert.throws(() => { first.plan.samples[0].lat = 90; });
  assert.equal(c.get(trip, session).plan.samples[0].lat, 25);
});

test('resume, revision and route/options changes never reuse an obsolete playback plan', () => {
  const c = cache(), first = c.get(trip, session);
  const resumed = c.get(trip, { ...session, offsetMs: 5000 });
  assert.notEqual(resumed, first);
  assert.equal(resumed.plan.samples[0].model_ms, 5000);
  assert.equal(resumed.plan.samples[0].speed_mps, 0);
  const restarted = c.get(trip, { ...session, sessionId: 'session-2', offsetMs: 5000 });
  assert.notEqual(restarted, resumed);
  const revised = c.get({ ...trip, revision: 'revision-2' }, session);
  assert.notEqual(revised, restarted);
  const changedOptions = c.get({ ...trip, revision: 'revision-2', optionsJson: '{"maxSpeedMps":1}' }, session);
  assert.notEqual(changedOptions.sha256, revised.sha256);
  const changedRoute = c.get({ ...trip, routeJson: JSON.stringify({ ...route, durationMs: 120000 }) }, session);
  assert.notEqual(changedRoute.sha256, first.sha256);
});

test('terminal cleanup and inactivity release plans while active polling refreshes their expiry', () => {
  let now = 0;
  const c = cache({ idleTtlMs: 100, now: () => now });
  const first = c.get(trip, session);
  now = 90; assert.equal(c.get(trip, session), first);
  now = 150; assert.equal(c.get(trip, session), first);
  now = 251; const expired = c.get(trip, session); assert.notEqual(expired, first);
  c.delete(trip.id); assert.notEqual(c.get(trip, session), expired);
});

test('plan cache evicts least recently used entries and does not retain an over-budget plan', () => {
  const c = cache({ maxEntries: 2 });
  const first = c.get(trip, session);
  const second = c.get({ ...trip, id: 'second' }, session);
  assert.equal(c.get(trip, session), first);
  c.get({ ...trip, id: 'third' }, session);
  assert.equal(c.get(trip, session), first);
  assert.notEqual(c.get({ ...trip, id: 'second' }, session), second);
  const tiny = cache({ maxBytes: 1 });
  assert.notEqual(tiny.get(trip, session), tiny.get(trip, session));
});
