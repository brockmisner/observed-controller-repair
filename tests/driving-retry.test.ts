import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness(status: string) {
  const nodes = new Map<string, any>(), listeners = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, classList: { toggle() {} } });
    return nodes.get(id);
  };
  const context = { window: {}, module: { exports: {} as any }, document: { getElementById: node,
    addEventListener: (name: string, fn: any) => listeners.set(name, fn) } };
  vm.runInNewContext(readFileSync(new URL('../public/driving.js', import.meta.url), 'utf8'), context);
  const calls: string[] = [];
  const trip = { id: 'trip-a', deviceId: 'phone-a', status: 'PREVIEW', revision: 'old' };
  let writes = 0;
  const view = context.module.exports.create({ icon: () => '',
    map: { on() {}, removeLayer() {} }, L: { layerGroup: () => ({ clearLayers() {} }) },
    api: async (url: string, options?: any) => {
      calls.push(`${options?.method || 'GET'} ${url}`);
      if (!options) return { trip: { ...trip, status, revision: 'new' } };
      if (++writes === 1) throw new Error('Response lost');
      assert.equal(JSON.parse(options.body).revision, 'new');
      return { trip: { ...trip, status: 'RUNNING', revision: 'new' } };
    } });
  const device = { id: 'phone-a', imageId: 'demo', trip };
  view.update(device, false);
  const retry = () => listeners.get('click')({ target: { closest: () => ({ disabled: false, dataset: { drivingAction: 'retry-operation' } }) } });
  return { view, device, calls, node, retry };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('manual retry reconciles a lost start response without starting a running trip twice', async () => {
  const h = harness('RUNNING');
  await h.view.action('start');
  assert.equal(h.node('drivingRetry').hidden, false);
  h.retry(); h.retry();
  await settle();
  assert.deepEqual(h.calls, ['POST /api/trips/trip-a/start', 'GET /api/trips/trip-a']);
  assert.equal(h.node('drivingRetry').hidden, true);
});

test('manual retry repeats a failed start once using the refreshed revision', async () => {
  const h = harness('PREVIEW');
  await h.view.action('start');
  h.retry(); h.retry();
  await settle();
  assert.deepEqual(h.calls, ['POST /api/trips/trip-a/start', 'GET /api/trips/trip-a', 'POST /api/trips/trip-a/start']);
  assert.equal(h.view.stateFor(h.device).trip.status, 'RUNNING');
});
