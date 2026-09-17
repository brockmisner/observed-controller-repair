import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { buildPlayerPlan } from '../src/trips/playerPlan.js';
import { PlayerSocket } from '../src/trips/playerProtocol.js';
import { routeSegmentDistance, type DrivingRoute } from '../src/trips/routes.js';
import { createRouteTimeline } from '../src/trips/routeTimeline.js';
const points = [{ lat: 25.77, lng: -80.13 }, { lat: 25.7703, lng: -80.13 }, { lat: 25.77031, lng: -80.13 }, { lat: 25.771, lng: -80.13 }];
const route: DrivingRoute = { provider: 'OSRM', points, origin: points[0]!, destination: points.at(-1)!,
  distanceM: points.slice(1).reduce((sum, p, i) => sum + routeSegmentDistance(points[i]!, p), 0), durationMs: 20000, staticDurationMs: 20000,
  fetchedAt: '2026-09-17T10:00:00Z', expiresAt: '2026-09-17T11:00:00Z', traffic: [{ startIndex: 0, endIndex: 3, category: 'UNKNOWN' }] };
test('plan crosses short geometry segments without losing traveled distance; endpoints stopped and 30-second dwell', () => {
  const p = buildPlayerPlan(route, { maxSpeedMps: 8 });
  assert.equal(p.samples[0]!.speed_mps, 0);
  assert.equal(p.samples.at(-1)!.speed_mps, 0);
  assert.equal(p.samples.at(-1)!.lat, route.destination.lat);
  assert.equal(p.samples.at(-1)!.distance_m, p.total_distance_m);
  assert.equal(p.samples.slice(-30).every(s => s.phase === 'dwell' && s.speed_mps === 0 && s.lat === route.destination.lat), true);
  p.samples.forEach((s, i) => {
    assert.equal(s.seq, i); assert.equal(s.t_ms, i * 1000);
    assert.ok(s.speed_mps <= 8 && Number.isFinite(s.bearing_deg));
    if (i) assert.ok(s.distance_m >= p.samples[i - 1]!.distance_m);
  });
});
test('resume begins at the acknowledged position at rest and gradually advances modeled time', () => {
  const p = buildPlayerPlan(route, { maxSpeedMps: 8 }, 5000);
  const before = createRouteTimeline(route, { maxSpeedMps: 8 }).sample(5000);
  assert.equal(p.samples[0]!.lat, before.lat);
  assert.equal(p.samples[0]!.speed_mps, 0);
  assert.equal(p.samples[1]!.model_ms, 5062.5);
  assert.equal(p.samples.at(-1)!.lat, route.destination.lat);
});
test('invalid offset is rejected rather than jumping backwards', () => {
  assert.throws(() => buildPlayerPlan(route, {}, -1000));
  assert.throws(() => buildPlayerPlan(route, {}, Infinity));
});
async function fakePlayer(wrongId: boolean, run: (port: number, ops: string[]) => Promise<void>) {
  const ops: string[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buf = '';
    socket.on('data', chunk => {
      buf += chunk;
      let end;
      while ((end = buf.indexOf('\n')) >= 0) {
        const q = JSON.parse(buf.slice(0, end)); buf = buf.slice(end + 1); ops.push(q.op);
        const response = JSON.stringify({ id: wrongId ? 'bad' : q.id, ok: true, instance_id: 'one',
          session_id: '', state: 'IDLE', applied_seq: -1, cleanup_ok: true });
        socket.write(response.slice(0, 12)); socket.write(response.slice(12) + '\n');
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try { await run((server.address() as import('node:net').AddressInfo).port, ops); }
  finally { for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())); }
}
test('TCP framing accepts fragmented acknowledgments; status does not start movement', async () => {
  await fakePlayer(false, async (port, ops) => {
    const c = await PlayerSocket.connect(port, 'test-token');
    try { assert.equal((await c.request({ op: 'status' })).state, 'IDLE'); }
    finally { c.close(); }
    assert.deepEqual(ops, ['auth', 'status']);
  });
});
test('a mismatched acknowledgment is rejected and the socket closes', async () => {
  await fakePlayer(true, async port => { await assert.rejects(PlayerSocket.connect(port, 'test-token')); });
});
