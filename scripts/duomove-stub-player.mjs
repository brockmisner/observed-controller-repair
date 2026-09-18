#!/usr/bin/env node
// A stand-in for the phone's ControlServer, used only to self-test the acceptance harness.
//
// It reproduces the wire behaviour recorded in docs/radio-apk-build-brief.md §4 — line-framed
// JSON, `auth` then ops on the same connection, the 1 Hz plan clock with a 500 ms start delay,
// a 20 ms scheduler tick, and the `status()` field set — so the harness can be exercised and its
// statistics checked against known injected jitter. It is NOT a phone and produces no acceptance
// evidence: any run against it must be labelled a harness self-test.
//
//   node scripts/duomove-stub-player.mjs --port 19999 --token <token> [--jitter-ms 40] [--skip 7,8]
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};

const PORT = Number(value('port', '19999'));
const TOKEN = value('token', 'stub-token-stub-token-stub-token');
const JITTER_MS = Number(value('jitter-ms', '0'));
const SKIP = new Set((value('skip', '') || '').split(',').filter(Boolean).map(Number));
const START_DELAY_MS = 500;
const TICK_MS = 20;
const INSTANCE_ID = randomUUID();

/** Deterministic per-index jitter so a self-test is reproducible. */
function jitterFor(seq) {
  if (!JITTER_MS) return 0;
  const hash = createHash('sha256').update(`${seq}`).digest();
  return (hash[0] / 255) * JITTER_MS;
}

const player = {
  state: 'IDLE',
  sessionId: '',
  receivedBytes: 0,
  expectedBytes: 0,
  expectedSha256: '',
  chunks: [],
  plan: null,
  appliedSeq: -1,
  frameworkObservedSeq: -1,
  fusedObservedSeq: -1,
  skippedSamples: 0,
  maxLatenessMs: 0,
  startNanos: 0,
  observerElapsedNanos: 0,
  cleanupOk: true,
  error: '',
  retired: new Set(),
};

const nowNanos = () => process.hrtime.bigint();

function status(id) {
  return {
    ok: true,
    id,
    instance_id: INSTANCE_ID,
    session_id: player.sessionId,
    state: player.state,
    received_bytes: player.receivedBytes,
    applied_seq: player.appliedSeq,
    skipped_samples: player.skippedSamples,
    max_lateness_ms: Math.round(player.maxLatenessMs),
    start_elapsed_nanos: Number(player.startNanos),
    lease_remaining_ms: 15_000,
    cleanup_ok: player.cleanupOk,
    error: player.error,
    // AndroidSink.observations()
    delivery: 'framework_and_fused',
    observer_scope: 'player_app',
    framework_observed_seq: player.frameworkObservedSeq,
    fused_observed_seq: player.fusedObservedSeq,
    observer_elapsed_nanos: Number(player.observerElapsedNanos),
    synthetic: true,
    observer_mismatches: 0,
  };
}

setInterval(() => {
  if (player.state !== 'RUNNING' && player.state !== 'DWELL') return;
  const elapsedMs = Number(nowNanos() - player.startNanos) / 1e6;
  const total = player.plan.samples.length;
  for (let seq = player.appliedSeq + 1; seq < total; seq++) {
    const scheduledMs = START_DELAY_MS + seq * (player.plan.interval_ms ?? 1000) + jitterFor(seq);
    if (elapsedMs < scheduledMs) break;
    if (SKIP.has(seq)) { player.skippedSamples += 1; player.appliedSeq = seq; continue; }
    player.maxLatenessMs = Math.max(player.maxLatenessMs, elapsedMs - scheduledMs);
    player.appliedSeq = seq;
    // The real sink observes its own injected fix in-process, a moment after application.
    player.frameworkObservedSeq = seq;
    player.fusedObservedSeq = seq;
    player.observerElapsedNanos = nowNanos();
    player.state = player.plan.samples[seq].phase === 'dwell' ? 'DWELL' : 'RUNNING';
  }
  if (player.appliedSeq >= total - 1) {
    player.state = 'COMPLETED';
    player.cleanupOk = true;
  }
}, TICK_MS);

createServer(socket => {
  let authorized = false;
  let buffer = '';
  socket.setNoDelay(true);
  socket.on('data', data => {
    buffer += data.toString('utf8');
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let request;
      try { request = JSON.parse(line); } catch { socket.write(`${JSON.stringify({ ok: false, error: 'invalid_request' })}\n`); continue; }
      const id = request.id;
      if (!/^[0-9a-f]{32}$/.test(id ?? '')) { socket.write(`${JSON.stringify({ ok: false, id, error: 'invalid_request_id' })}\n`); continue; }
      const fail = error => socket.write(`${JSON.stringify({ ok: false, id, error })}\n`);

      if (request.op === 'auth') {
        if (request.version !== 1 || request.token !== TOKEN) { fail('unauthorized'); continue; }
        authorized = true;
        socket.write(`${JSON.stringify(status(id))}\n`);
        continue;
      }
      if (!authorized) { fail('unauthorized'); continue; }

      switch (request.op) {
        case 'status':
        case 'heartbeat':
          break;
        case 'prepare':
          if (player.retired.has(request.session_id)) { fail('retired_session'); continue; }
          if (!(player.state === 'IDLE' || ['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(player.state))) { fail('device_busy'); continue; }
          if (!Number.isInteger(request.size) || request.size < 2 || request.size > 8_000_000) { fail('invalid_prepare'); continue; }
          Object.assign(player, {
            state: 'UPLOADING', sessionId: request.session_id, expectedBytes: request.size,
            expectedSha256: request.sha256, receivedBytes: 0, chunks: [], appliedSeq: -1,
            frameworkObservedSeq: -1, fusedObservedSeq: -1, skippedSamples: 0, maxLatenessMs: 0,
            startNanos: 0n, observerElapsedNanos: 0n, error: '',
          });
          break;
        case 'append': {
          if (player.state !== 'UPLOADING') { fail('not_uploading'); continue; }
          if (request.session_id !== player.sessionId) { fail('session_mismatch'); continue; }
          if (request.offset !== player.receivedBytes) { fail('invalid_chunk'); continue; }
          const chunk = Buffer.from(request.data, 'base64');
          if (chunk.length > 48_000) { fail('invalid_chunk'); continue; }
          player.chunks.push(chunk);
          player.receivedBytes += chunk.length;
          break;
        }
        case 'commit': {
          if (player.state !== 'UPLOADING') { fail('not_uploading'); continue; }
          if (request.session_id !== player.sessionId) { fail('session_mismatch'); continue; }
          const bytes = Buffer.concat(player.chunks);
          if (bytes.length !== player.expectedBytes) { fail('incomplete_upload'); continue; }
          if (createHash('sha256').update(bytes).digest('hex') !== player.expectedSha256) { fail('plan_checksum'); continue; }
          try { player.plan = JSON.parse(bytes.toString('utf8')); } catch { fail('plan_validation_failed'); continue; }
          if (!Array.isArray(player.plan.samples) || !player.plan.samples.length) { fail('plan_validation_failed'); continue; }
          player.state = 'READY';
          break;
        }
        case 'start':
          if (player.state !== 'READY') { fail('plan_not_ready'); continue; }
          if (request.session_id !== player.sessionId) { fail('session_mismatch'); continue; }
          player.startNanos = nowNanos();
          player.state = 'RUNNING';
          break;
        case 'cancel':
          if (request.session_id !== player.sessionId) { fail('session_mismatch'); continue; }
          player.retired.add(player.sessionId);
          player.state = 'CANCELLED';
          player.cleanupOk = true;
          break;
        default:
          fail('unknown_operation');
          continue;
      }
      socket.write(`${JSON.stringify(status(id))}\n`);
    }
  });
  socket.on('error', () => socket.destroy());
}).listen(PORT, '127.0.0.1', () => {
  console.error(`stub player on 127.0.0.1:${PORT} instance ${INSTANCE_ID} jitter<=${JITTER_MS}ms skip=[${[...SKIP]}]`);
});
