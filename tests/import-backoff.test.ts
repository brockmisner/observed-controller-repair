import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportBackoff } from '../src/orchestrator/importBackoff.js';
test('failed inventory reads back off, retry when due, and recover immediately after provider status changes', () => {
  const state = new ImportBackoff();
  state.fail('a', 'phone', '1:', 'DuoPlus info failed (code 405)', 1000);
  assert.equal(state.canAttempt('a', 'phone', '1:', 2000), false);
  assert.equal(state.canAttempt('b', 'phone', '1:', 2000), true);
  assert.equal(state.canAttempt('a', 'phone', '1:', 121000), true);
  state.fail('a', 'phone', '1:', 'DuoPlus info failed (code 405)', 121000);
  assert.equal(state.canAttempt('a', 'phone', '1:', 242000), false);
  assert.equal(state.canAttempt('a', 'phone', '2:', 242000), true);
});
test('inventory success clears stale error status and removed phones are pruned', () => {
  const state = new ImportBackoff();
  state.fail('a', 'phone', '1:', 'missing GPS', 1000);
  assert.equal(state.statuses('a')[0].imageId, 'phone');
  state.clear('a', 'phone');
  assert.deepEqual(state.statuses('a'), []);
  state.fail('a', 'old', '1:', 'missing GPS', 1000);
  state.prune('a', new Set());
  assert.deepEqual(state.statuses('a'), []);
});
test('a successful provider read followed by a failed backfill preserves exponential retry history', async () => {
  const state = new ImportBackoff();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(state.run('a', 'phone', 'backfill', async () => {
      await Promise.resolve({ proxy: { ip: '192.0.2.1' } });
      // ISP lookup, tower lookup, and persistence are all part of this same attempt.
      throw new Error('backfill could not be persisted');
    }, () => 'ISP backfill will retry'), /could not be persisted/);
    const failure = state.statuses('a')[0];
    assert.equal(failure.attempts, attempt);
    assert.equal(Date.parse(failure.nextRetryAt) - Date.parse(failure.lastAttemptAt), 120_000 * 2 ** (attempt - 1));
    assert.equal(state.canAttempt('a', 'phone', 'backfill'), false);
  }
});
test('failure diagnostics remain until persistence finishes and registration failures receive a cooldown', async () => {
  const state = new ImportBackoff();
  state.fail('a', 'phone', 'import', 'Registration failed');
  let persisted!: () => void;
  const persistence = new Promise<void>(resolve => { persisted = resolve; });
  const work = state.run('a', 'phone', 'import', async () => {
    await Promise.resolve({ lat: 25, lng: -80 });
    await persistence;
    return 'registered';
  }, () => 'Phone registration could not complete; import will retry');
  await Promise.resolve();
  assert.equal(state.statuses('a')[0].attempts, 1);
  persisted();
  assert.equal(await work, 'registered');
  assert.deepEqual(state.statuses('a'), []);
  await assert.rejects(state.run('a', 'other', 'import', async () => {
    throw new Error('storage unavailable');
  }, () => 'Phone registration could not complete; import will retry'), /storage unavailable/);
  assert.equal(state.canAttempt('a', 'other', 'import'), false);
  assert.equal(state.statuses('a')[0].attempts, 1);
});
