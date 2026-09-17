import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRpaIssueAt } from '../src/api/rpaSchedule.js';
test('default RPA execution rounds forward and uses the configured scheduler timezone', () => {
  assert.equal(defaultRpaIssueAt(new Date('2026-09-17T12:00:02Z'), 'America/New_York'), '2026-09-17 08:02');
  assert.equal(defaultRpaIssueAt(new Date('2026-09-17T12:00:59Z'), 'UTC'), '2026-09-17 12:02');
  assert.throws(() => defaultRpaIssueAt(new Date('2026-09-17T12:00:02Z'), ''));
});
