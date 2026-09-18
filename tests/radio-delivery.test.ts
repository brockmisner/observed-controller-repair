import test from 'node:test';
import assert from 'node:assert/strict';
import { startStubRadioReceiver, type StubRadioReceiver } from '../src/trips/radioStubReceiver.js';
import { connectLoopback, createAuthenticatedRadioTransport } from '../src/trips/radioTransport.js';
import { RadioDeliveryAdapter } from '../src/trips/radioDelivery.js';
import { previewRadioCodec } from '../src/trips/radioWire.js';
import { authorizeImageWriter, withPhysicalImageLease, leaseKeyFor,
  type ImageLeaseClient, type ImageOwnership, type ImageOwnershipStore } from '../src/trips/imageOwnership.js';
import { openRadioDelivery } from '../src/trips/radioSession.js';

const token = 'radio-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const frame = { version: 1, synthetic: true, wifi: [{ bssid: '00:11:22:33:44:55', rssiDbm: -61 }], cells: [], bluetooth: null };

/** Minimal Redis stand-in for the two lease scripts and the fencing counter. */
function fakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const alive = (key: string) => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) { store.delete(key); return undefined; }
    return entry;
  };
  const client: ImageLeaseClient & { expireLease(imageId: string): void; keys(): string[] } = {
    async set(key, value, _px, ttlMs) {
      if (alive(key)) return null;
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return 'OK';
    },
    async eval(script, _numKeys, ...args) {
      const [key, expected, ttlMs] = args as [string, string, number | undefined];
      const entry = alive(key);
      if (!entry || entry.value !== expected) return 0;
      if (script.includes('PEXPIRE')) { entry.expiresAt = Date.now() + Number(ttlMs ?? 60_000); return 1; }
      store.delete(key);
      return 1;
    },
    async incr(key) {
      const entry = alive(key);
      const next = Number(entry?.value ?? 0) + 1;
      store.set(key, { value: String(next), expiresAt: Number.MAX_SAFE_INTEGER });
      return next;
    },
    expireLease(imageId) { store.delete(leaseKeyFor(imageId)); },
    keys: () => [...store.keys()],
  };
  return client;
}

function identityFor(imageId: string, sessionId: string, extra: Partial<{ instanceId: string; bootId: string }> = {}) {
  return { tenantId: 'workspace-one', imageId, sessionId, instanceId: `player-${imageId}`, bootId: `boot-${imageId}`,
    datasetRevision: 'city:3', ...extra };
}

function adapterFor(receiver: StubRadioReceiver, ownership: ImageOwnership, identity: ReturnType<typeof identityFor>, options: { timeoutMs?: number; maxPayloadBytes?: number } = {}) {
  const transport = createAuthenticatedRadioTransport({
    imageId: identity.imageId, codec: previewRadioCodec,
    connect: () => connectLoopback(receiver.port), credential: async () => token,
  });
  return { transport, adapter: new RadioDeliveryAdapter({ identity, ownership, transport, codec: previewRadioCodec,
    timeoutMs: options.timeoutMs ?? 1000, ...(options.maxPayloadBytes ? { maxPayloadBytes: options.maxPayloadBytes } : {}) }) };
}

async function withReceiver<T>(imageId: string, run: (receiver: StubRadioReceiver) => Promise<T>,
  options: Partial<Parameters<typeof startStubRadioReceiver>[0]> = {}): Promise<T> {
  const receiver = await startStubRadioReceiver({ imageId, token, instanceId: `player-${imageId}`, bootId: `boot-${imageId}`, ...options });
  try { return await run(receiver); }
  finally { await receiver.close(); }
}

const lease = <T>(client: ImageLeaseClient, imageId: string, work: (ownership: ImageOwnership) => Promise<T>, waitMs = 0) =>
  withPhysicalImageLease(imageId, client, work, { waitMs });

test('an authenticated frame applies on its own phone and returns a correlated result', async () => {
  const redis = fakeRedis();
  await withReceiver('phone-a', async (receiver) => {
    await lease(redis, 'phone-a', async (ownership) => {
      const identity = identityFor('phone-a', 'session-a');
      const { adapter, transport } = adapterFor(receiver, ownership, identity);
      const result = await adapter.deliver(frame, { sequence: 0, elapsedMs: 0 });
      transport.close();

      assert.equal(result.state, 'APPLIED');
      assert.equal(result.applied, true);
      assert.equal(result.received, true);
      assert.equal(result.uncertain, false);
      assert.equal(result.epoch, ownership.epoch);
      assert.equal(receiver.applied.length, 1);
      assert.deepEqual(receiver.applied[0]!.frame, frame);
      assert.equal(receiver.applied[0]!.sessionId, 'session-a');
      assert.equal(receiver.applied[0]!.epoch, ownership.epoch);
    });
  });
});

test('a frame addressed to another phone is refused by the credential check and never applied', async () => {
  const redis = fakeRedis();
  await withReceiver('phone-a', async (receiver) => {
    await lease(redis, 'phone-b', async (ownership) => {
      const { adapter, transport } = adapterFor(receiver, ownership, identityFor('phone-b', 'session-b'));
      const result = await adapter.deliver(frame, { sequence: 0, elapsedMs: 0 });
      transport.close();

      assert.equal(result.state, 'UNREACHABLE');
      assert.equal(result.sent, false);
      assert.equal(result.applied, false);
      assert.equal(result.uncertain, false);
      assert.match(result.detail, /rejected this radio credential/);
      assert.equal(receiver.applied.length, 0);
      assert.equal(receiver.authFailures, 1);
    });
  });
});

test('an acknowledgment from a different player instance is a mismatch, not an application', async () => {
  const redis = fakeRedis();
  await withReceiver('phone-a', async (receiver) => {
    await lease(redis, 'phone-a', async (ownership) => {
      const { adapter, transport } = adapterFor(receiver, ownership, identityFor('phone-a', 'session-a', { instanceId: 'player-before-restart' }));
      const result = await adapter.deliver(frame, { sequence: 1, elapsedMs: 1000 });
      assert.equal(result.state, 'IDENTITY_MISMATCH');
      assert.equal(result.applied, false);
      assert.equal(result.uncertain, true);
      assert.match(result.detail, /different player instance/);
      // A writer that cannot identify its peer stops instead of continuing to send.
      const next = await adapter.deliver(frame, { sequence: 2, elapsedMs: 2000 });
      assert.equal(next.state, 'CLOSED');
      assert.equal(next.sent, false);
      transport.close();
    });
  }, { instanceId: 'player-after-restart' });
});

test('a silent phone produces an explicit uncertain timeout rather than an assumed success', async () => {
  const redis = fakeRedis();
  await withReceiver('phone-a', async (receiver) => {
    await lease(redis, 'phone-a', async (ownership) => {
      const { adapter, transport } = adapterFor(receiver, ownership, identityFor('phone-a', 'session-a'), { timeoutMs: 120 });
      const result = await adapter.deliver(frame, { sequence: 0, elapsedMs: 0 });
      transport.close();
      assert.equal(result.state, 'TIMED_OUT');
      assert.equal(result.sent, true);
      assert.equal(result.applied, false);
      assert.equal(result.uncertain, true);
      assert.equal(receiver.applied.length, 0);
    });
  }, { behavior: () => 'SILENT' });
});

test('an oversized frame and a replayed frame are refused before anything is sent', async () => {
  const redis = fakeRedis();
  await withReceiver('phone-a', async (receiver) => {
    await lease(redis, 'phone-a', async (ownership) => {
      const identity = identityFor('phone-a', 'session-a');
      const { adapter, transport } = adapterFor(receiver, ownership, identity, { maxPayloadBytes: 2048 });
      const huge = { ...frame, wifi: Array.from({ length: 200 }, (_, index) => ({ bssid: `00:11:22:33:44:${index}`, ssid: 'x'.repeat(40), rssiDbm: -70 })) };
      const oversized = await adapter.deliver(huge, { sequence: 0, elapsedMs: 0 });
      assert.equal(oversized.state, 'PAYLOAD_TOO_LARGE');
      assert.equal(oversized.sent, false);

      assert.equal((await adapter.deliver(frame, { sequence: 5, elapsedMs: 5000 })).state, 'APPLIED');
      const duplicate = await adapter.deliver(frame, { sequence: 5, elapsedMs: 5000 });
      const late = await adapter.deliver(frame, { sequence: 3, elapsedMs: 3000 });
      transport.close();

      assert.equal(duplicate.state, 'REPLAY_REJECTED');
      assert.equal(duplicate.sent, false);
      assert.equal(late.state, 'REPLAY_REJECTED');
      assert.equal(late.sent, false);
      assert.deepEqual(receiver.applied.map((entry) => entry.sequence), [5]);
    });
  });
});

test('two phones apply their own radio sessions at the same time without crossing over', async () => {
  const redis = fakeRedis();
  await withReceiver('phone-a', async (receiverA) => {
    await withReceiver('phone-b', async (receiverB) => {
      const drive = (imageId: string, receiver: StubRadioReceiver, sessionId: string) => lease(redis, imageId, async (ownership) => {
        const { adapter, transport } = adapterFor(receiver, ownership, identityFor(imageId, sessionId));
        const results = [];
        for (const sequence of [0, 1, 2]) {
          results.push(await adapter.deliver({ ...frame, sequence }, { sequence, elapsedMs: sequence * 1000 }));
        }
        transport.close();
        return results;
      });
      const [a, b] = await Promise.all([drive('phone-a', receiverA, 'session-a'), drive('phone-b', receiverB, 'session-b')]);

      assert.deepEqual(a.map((result) => result.state), ['APPLIED', 'APPLIED', 'APPLIED']);
      assert.deepEqual(b.map((result) => result.state), ['APPLIED', 'APPLIED', 'APPLIED']);
      assert.deepEqual(receiverA.applied.map((entry) => entry.sessionId), ['session-a', 'session-a', 'session-a']);
      assert.deepEqual(receiverB.applied.map((entry) => entry.sessionId), ['session-b', 'session-b', 'session-b']);
      assert.equal(receiverA.applied.every((entry) => entry.imageId === 'phone-a'), true);
      assert.equal(receiverB.applied.every((entry) => entry.imageId === 'phone-b'), true);
    });
  });
});

test('a competing job cannot open a second writer for one image', async () => {
  const redis = fakeRedis();
  await withReceiver('phone-a', async (receiver) => {
    await lease(redis, 'phone-a', async (ownership) => {
      const { adapter, transport } = adapterFor(receiver, ownership, identityFor('phone-a', 'session-a'));
      assert.equal((await adapter.deliver(frame, { sequence: 0, elapsedMs: 0 })).state, 'APPLIED');

      await assert.rejects(lease(redis, 'phone-a', async () => 'second writer'),
        (error: Error & { status?: number }) => error.status === 409 && /Another trip operation is in progress/.test(error.message));

      assert.equal((await adapter.deliver(frame, { sequence: 1, elapsedMs: 1000 })).state, 'APPLIED');
      transport.close();
      assert.deepEqual(receiver.applied.map((entry) => entry.sequence), [0, 1]);
    });
  });
});

test('an expired worker cannot overwrite the newer owner, in flight or on retry', async () => {
  const redis = fakeRedis();
  await withReceiver('phone-a', async (receiver) => {
    const expired = await lease(redis, 'phone-a', async (ownership) => {
      const { adapter, transport } = adapterFor(receiver, ownership, identityFor('phone-a', 'session-expired'));
      assert.equal((await adapter.deliver(frame, { sequence: 1, elapsedMs: 1000 })).state, 'APPLIED');
      // The worker keeps running while its lease disappears, exactly as an expiry looks from here.
      redis.expireLease('phone-a');
      return { adapter, transport, epoch: ownership.epoch };
    });

    await lease(redis, 'phone-a', async (ownership) => {
      assert.ok(ownership.epoch > expired.epoch, 'a newer owner must hold a higher fencing epoch');
      const { adapter, transport } = adapterFor(receiver, ownership, identityFor('phone-a', 'session-current'));
      assert.equal((await adapter.deliver({ ...frame, owner: 'current' }, { sequence: 2, elapsedMs: 2000 })).state, 'APPLIED');
      transport.close();
    });

    const lostResult = await expired.adapter.deliver({ ...frame, owner: 'expired' }, { sequence: 3, elapsedMs: 3000 });
    assert.equal(lostResult.state, 'OWNERSHIP_LOST');
    assert.equal(lostResult.sent, false);

    // A payload that was already in flight when the lease expired is fenced by the receiver too.
    const inFlight = createAuthenticatedRadioTransport({ imageId: 'phone-a', codec: previewRadioCodec,
      connect: () => connectLoopback(receiver.port), credential: async () => token });
    const raw = await inFlight.send(previewRadioCodec.encodeApply({ identity: identityFor('phone-a', 'session-expired'),
      requestId: 'late-request', epoch: expired.epoch, sequence: 4, elapsedMs: 4000, frame: { ...frame, owner: 'expired' } }), 1000);
    inFlight.close();
    expired.transport.close();

    const ack = previewRadioCodec.decodeAck(raw);
    assert.equal(ack.status, 'REJECTED');
    assert.equal(ack.reason, 'STALE_EPOCH');
    assert.deepEqual(receiver.rejections.map((entry) => entry.reason), ['STALE_EPOCH']);
    assert.deepEqual(receiver.applied.map((entry) => entry.sequence), [1, 2]);
    assert.equal((receiver.applied.at(-1)!.frame as { owner?: string }).owner, 'current');
  });
});

const storeFor = (rows: { id: string; tenantId: string; activeTripId: string | null }[],
  reservation: { tenantId: string; deviceId: string } | null = null): ImageOwnershipStore => ({
  devicesForImage: async () => rows.map((row) => ({ ...row, imageId: 'phone-a' })),
  reservationForImage: async () => reservation ? { imageId: 'phone-a', campaignId: 'campaign-1', ...reservation } : null,
});

test('duplicate image rows in other workspaces cannot be written through, and reservations hold', async () => {
  const mine = { id: 'device-mine', tenantId: 'workspace-one', activeTripId: null };
  const theirs = { id: 'device-theirs', tenantId: 'workspace-two', activeTripId: null };

  const authorized = await authorizeImageWriter('workspace-one', 'phone-a', storeFor([mine, theirs]));
  assert.equal(authorized.deviceId, 'device-mine');

  await assert.rejects(authorizeImageWriter('workspace-three', 'phone-a', storeFor([mine, theirs])),
    (error: Error & { status?: number }) => error.status === 404);
  await assert.rejects(authorizeImageWriter('workspace-one', 'phone-a', storeFor([mine, { ...theirs, activeTripId: 'trip-9' }])),
    (error: Error & { status?: number }) => error.status === 409 && /Another workspace trip owns/.test(error.message));
  await assert.rejects(authorizeImageWriter('workspace-one', 'phone-a',
    storeFor([mine, theirs], { tenantId: 'workspace-two', deviceId: 'device-theirs' })),
  (error: Error & { status?: number }) => error.status === 409 && /campaign reservation/.test(error.message));

  const ownReservation = await authorizeImageWriter('workspace-one', 'phone-a',
    storeFor([mine, theirs], { tenantId: 'workspace-one', deviceId: 'device-mine' }));
  assert.equal(ownReservation.reservedBy, 'campaign-1');
});

test('opening a radio session requires both workspace authorization and the image lease', async () => {
  const redis = fakeRedis();
  const store = storeFor([{ id: 'device-mine', tenantId: 'workspace-one', activeTripId: null }]);
  await withReceiver('phone-a', async (receiver) => {
    await lease(redis, 'phone-a', async (ownership) => {
      const transport = createAuthenticatedRadioTransport({ imageId: 'phone-a', codec: previewRadioCodec,
        connect: () => connectLoopback(receiver.port), credential: async () => token });
      const session = await openRadioDelivery({ identity: identityFor('phone-a', 'session-a'), ownership, store, transport });
      assert.equal((await session.adapter.deliver(frame, { sequence: 0, elapsedMs: 0 })).state, 'APPLIED');
      await session.close();
      assert.equal((await session.adapter.deliver(frame, { sequence: 1, elapsedMs: 1000 })).state, 'CLOSED');

      await assert.rejects(openRadioDelivery({ identity: { ...identityFor('phone-a', 'session-a'), tenantId: 'workspace-three' },
        ownership, store, transport }), (error: Error & { status?: number }) => error.status === 404);
      await assert.rejects(openRadioDelivery({ identity: identityFor('phone-b', 'session-b'), ownership, store, transport }),
        /does not match the owned image/);
    });
  });
});
