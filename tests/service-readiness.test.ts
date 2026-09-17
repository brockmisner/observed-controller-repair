import test from 'node:test';
import assert from 'node:assert/strict';

import * as readiness from '../src/sites/readiness.js';
test('client jobs report both missing settings before accepting a schedule', () => {
  const result = readiness.siteJobReadiness({}, false);
  assert.equal(result.ready, false);
  assert.equal(result.issues.length, 2);
  assert.equal(result.callbackConfigured, false);
  assert.equal(result.schedulerTimezone, null);
});
test('client callback rejects credentials, paths, query strings and insecure origins', () => {
  for (const origin of ['http://example.com', 'https://secret:password@example.com', 'https://example.com/callback', 'https://example.com?token=secret']) {
    const result = readiness.siteJobReadiness({ SITE_RESULT_BASE_URL: origin, SITE_RPA_TIMEZONE: 'UTC' }, false);
    assert.equal(result.ready, false);
    assert.equal(result.callbackConfigured, false);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});
test('readiness blocks invalid timezone and dry-run independently', () => {
  const env = { SITE_RESULT_BASE_URL: 'https://example.com', SITE_RPA_TIMEZONE: 'America/New_York' };
  assert.equal(readiness.siteJobReadiness(env, false).ready, true);
  assert.equal(readiness.siteJobReadiness(env, true).ready, false);
  assert.equal(readiness.siteJobReadiness({ ...env, SITE_RPA_TIMEZONE: 'Not/A_Zone' }, false).ready, false);
});
test('provider issue time uses explicit scheduler timezone through daylight saving', () => {
  assert.equal(readiness.siteIssueAt(new Date('2026-07-01T15:02:00Z'), 'America/New_York'), '2026-07-01 11:02');
  assert.equal(readiness.siteIssueAt(new Date('2026-01-01T15:02:00Z'), 'America/New_York'), '2026-01-01 10:02');
  assert.throws(() => readiness.siteIssueAt(new Date('2026-01-01T15:02:00Z'), ''));
});

import * as providerErrors from '../src/api/providerError.js';
test('provider failures retain endpoint/code/reason and redact credentials before logging', () => {
  const error = providerErrors.providerFailure('/api/v1/cloudPhone/info', 405,
    'Phone unavailable; key=secret-key-123; password=supersecret; see https://example.com?token=hidden', 'secret-key-123');
  assert.equal(error.status, 502);
  assert.match(error.message, /405/);
  assert.match(error.message, /cloudPhone\/info/);
  assert.match(error.message, /Phone unavailable/);
  assert.doesNotMatch(error.message, /secret-key-123|supersecret|hidden/);
  assert.ok(error.message.length < 400);
});
test('provider failures tolerate missing or malformed messages without persisting response bodies', () => {
  const error = providerErrors.providerFailure('/api/v1/cloudPhone/info', 405, { password: 'hidden' }, 'key');
  assert.match(error.message, /405/);
  assert.doesNotMatch(error.message, /hidden|object Object/);
});
