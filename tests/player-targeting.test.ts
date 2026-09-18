import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIAL_PATTERN, provisionerFor } from '../src/trips/playerCredentials.js';
import { parsePlayerTargets, playerImageIds, requirePlayerTarget, findPlayerTarget, usesPlayer,
  resetPlayerRegistry, PlayerTargetError, type PlayerTarget } from '../src/trips/playerTargets.js';
import { PlayerGateway, type PlayerAdbDriver } from '../src/trips/playerConnection.js';
import { PlayerSocket } from '../src/trips/playerProtocol.js';
import { PlayerLifecycle, evaluatePlayerReadiness, type PlayerStatusSummary, type ReadinessSteps } from '../src/trips/playerReadiness.js';

const env = (extra: Record<string, string>) => ({ DUOMOVE_STATE_DIR: '/app/data', ...extra } as NodeJS.ProcessEnv);
const demo = { imageId: 'demo-phone', endpoint: '10.0.0.5:5555' };
const phoneA = { imageId: 'phone-a', endpoint: '10.0.0.6:5555' };
const phoneB = { imageId: 'phone-b', endpoint: '10.0.0.7:5555' };

test('each image resolves its own endpoint and its own credential file', () => {
  const registry = parsePlayerTargets(env({ DUOMOVE_PLAYER_TARGETS: JSON.stringify([demo, phoneA, phoneB]) }));
  assert.deepEqual([...registry.targets.keys()], ['demo-phone', 'phone-a', 'phone-b']);
  const endpoints = [...registry.targets.values()].map((target) => target.endpoint);
  const credentials = [...registry.targets.values()].map((target) => target.credentialPath);
  assert.equal(new Set(endpoints).size, 3);
  assert.equal(new Set(credentials).size, 3);
  assert.equal(credentials.every((path) => path.startsWith('/app/data/player-credentials/') && !path.includes('..')), true);
  assert.equal(registry.problems.size, 0);

  // The radio agent is a separate artifact on the same phone: own package, port and credential.
  const target = registry.targets.get('phone-a')!;
  assert.equal(target.playerPackage, 'net.stakeout.duomove.player');
  assert.equal(target.credentialMode, 'RUN_AS');
  assert.equal(target.radioAgent.packageName, 'net.stakeout.duomove.radioagent');
  assert.equal(target.radioAgent.moduleName, 'duomove-radio');
  assert.notEqual(target.radioAgent.port, target.controlPort);
  assert.notEqual(target.radioAgent.credentialPath, target.credentialPath);
  // A release-signed agent cannot be provisioned over run-as, so it is not the default.
  assert.equal(target.radioAgent.credentialMode, 'OPERATOR_SUPPLIED');
});

test('radio agent settings are validated per image and never collide with the player channel', () => {
  const agent = { packageName: 'net.example.agent', port: 9100, moduleName: 'duomove-radio-next', credentialMode: 'AGENT_MINTED' };
  const configured = parsePlayerTargets(env({ DUOMOVE_PLAYER_TARGETS: JSON.stringify([{ ...phoneA, radioAgent: agent }]) }));
  assert.deepEqual(configured.targets.get('phone-a')!.radioAgent, { ...agent,
    credentialPath: configured.targets.get('phone-a')!.radioAgent.credentialPath });

  for (const [broken, reason] of [
    [{ radioAgent: { port: 9999 } }, /port is the player control port/],
    [{ radioAgent: { packageName: 'not a package' } }, /agent package is invalid/],
    [{ radioAgent: { credentialMode: 'RUN_AS_MAYBE' } }, /credential mode is invalid/],
    [{ credentialMode: 'SOMEHOW' }, /Player credential mode is invalid/],
  ] as [Record<string, unknown>, RegExp][]) {
    const registry = parsePlayerTargets(env({ DUOMOVE_PLAYER_TARGETS: JSON.stringify([{ ...phoneA, ...broken }]) }));
    assert.equal(registry.targets.has('phone-a'), false);
    assert.match(registry.problems.get('phone-a') ?? '', reason);
  }
});

test('a traversal or injection attempt in an image identifier never becomes a path or a target', () => {
  const registry = parsePlayerTargets(env({ DUOMOVE_PLAYER_TARGETS: JSON.stringify([{ imageId: '../../etc/passwd', endpoint: '10.0.0.6:5555' }, phoneA]) }));
  assert.equal(registry.targets.has('../../etc/passwd'), false);
  assert.match(registry.problems.get('../../etc/passwd') ?? '', /invalid image identifier/);
  assert.equal(registry.targets.get('phone-a')?.endpoint, phoneA.endpoint);
});

test('one bad entry disables only its own image', () => {
  const registry = parsePlayerTargets(env({ DUOMOVE_PLAYER_TARGETS: JSON.stringify([{ imageId: 'phone-a', endpoint: 'not-an-endpoint' }, phoneB]) }));
  assert.equal(registry.targets.has('phone-a'), false);
  assert.match(registry.problems.get('phone-a') ?? '', /endpoint is invalid/);
  assert.equal(registry.targets.get('phone-b')?.endpoint, phoneB.endpoint);
});

test('two images may not share one ADB endpoint, and a duplicated image is never guessed', () => {
  const shared = parsePlayerTargets(env({ DUOMOVE_PLAYER_TARGETS: JSON.stringify([phoneA, { imageId: 'phone-b', endpoint: phoneA.endpoint }]) }));
  assert.equal(shared.targets.size, 0);
  assert.match(shared.problems.get('phone-a') ?? '', /shared with another image/);
  assert.match(shared.problems.get('phone-b') ?? '', /shared with another image/);
  const duplicated = parsePlayerTargets(env({ DUOMOVE_PLAYER_TARGETS: JSON.stringify([phoneA, { imageId: 'phone-a', endpoint: phoneB.endpoint }]) }));
  assert.equal(duplicated.targets.size, 0);
  assert.match(duplicated.problems.get('phone-a') ?? '', /defined more than once/);
});

test('the single-phone configuration still resolves, and an unconfigured phone is refused rather than redirected', () => {
  const registry = parsePlayerTargets(env({ DUOMOVE_IMAGE_ID: 'demo-phone', ADB_PREFLIGHT_ENDPOINT: demo.endpoint }));
  assert.equal(registry.targets.get('demo-phone')?.endpoint, demo.endpoint);
  try {
    process.env.DUOMOVE_PLAYER_TARGETS = JSON.stringify([demo]);
    delete process.env.DUOMOVE_IMAGE_ID;
    resetPlayerRegistry();
    assert.equal(usesPlayer('demo-phone'), true);
    assert.equal(usesPlayer('phone-a'), false);
    assert.equal(findPlayerTarget('phone-a'), undefined);
    assert.throws(() => requirePlayerTarget('phone-a'), PlayerTargetError);
    assert.deepEqual(playerImageIds(), ['demo-phone']);
  } finally {
    delete process.env.DUOMOVE_PLAYER_TARGETS;
    resetPlayerRegistry();
  }
});

interface FakePhone { imageId: string; port: number; instanceId: string; sessions: string[]; close(): Promise<void> }

async function startFakePlayer(imageId: string, instanceId: string, token: string): Promise<FakePhone> {
  const sessions: string[] = [];
  const sockets = new Set<Socket>();
  let authorized = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let end = buffer.indexOf('\n');
      while (end >= 0) {
        const request = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf('\n');
        if (request.op === 'auth') authorized = request.token === token;
        if (request.op === 'prepare') sessions.push(String(request.session_id));
        socket.write(`${JSON.stringify({ id: request.id, ok: authorized, instance_id: instanceId,
          session_id: request.op === 'prepare' ? request.session_id : '', state: 'IDLE', applied_seq: -1,
          cleanup_ok: true, image_hint: imageId })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { imageId, instanceId, sessions, port: (server.address() as AddressInfo).port,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

interface Harness { gateway: PlayerGateway; calls: { imageId: string; endpoint: string; op: string }[] }

function harness(phones: Map<string, FakePhone>, tokens: Map<string, string>, unreachable: Set<string> = new Set()): Harness {
  const calls: { imageId: string; endpoint: string; op: string }[] = [];
  const record = (target: PlayerTarget, op: string) => calls.push({ imageId: target.imageId, endpoint: target.endpoint, op });
  const adb: PlayerAdbDriver = {
    async connect(target) {
      record(target, 'connect');
      if (unreachable.has(target.imageId)) throw new Error('Player ADB command failed; check the phone connection');
    },
    async state(target) { record(target, 'state'); return unreachable.has(target.imageId) ? 'offline' : 'device'; },
    async shell(target, args) { record(target, `shell:${args[0]}`); return args[0] === 'pm' ? 'package:/data/app/x/base.apk' : ''; },
    async forward(target, devicePort) {
      record(target, `forward:${devicePort}`);
      const phone = phones.get(target.imageId);
      if (!phone) throw new Error('No fake phone for this image');
      return phone.port;
    },
    async removeForward(target) { record(target, 'removeForward'); },
    async pushControlToken(target, packageName) { record(target, `pushToken:${packageName}`); },
  };
  return { calls, gateway: new PlayerGateway({
    adb,
    readCredential: async (slot) => {
      const token = tokens.get(slot.imageId);
      if (!token) throw new Error('Player setup is incomplete');
      return token;
    },
    provisionCredential: async (slot) => tokens.get(slot.imageId) ?? 'unprovisioned',
    connectSocket: (port, token) => PlayerSocket.connect(port, token),
  }) };
}

async function withFleet(run: (context: { phones: Map<string, FakePhone>; tokens: Map<string, string> }) => Promise<void>) {
  process.env.DUOMOVE_PLAYER_TARGETS = JSON.stringify([demo, phoneA, phoneB]);
  resetPlayerRegistry();
  const tokens = new Map([['demo-phone', 'demo-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'], ['phone-a', 'phone-a-token-bbbbbbbbbbbbbbbbbbbbbb'], ['phone-b', 'phone-b-token-cccccccccccccccccccccc']]);
  const phones = new Map<string, FakePhone>([
    ['demo-phone', await startFakePlayer('demo-phone', 'instance-demo', tokens.get('demo-phone')!)],
    ['phone-a', await startFakePlayer('phone-a', 'instance-a', tokens.get('phone-a')!)],
    ['phone-b', await startFakePlayer('phone-b', 'instance-b', tokens.get('phone-b')!)],
  ]);
  try { await run({ phones, tokens }); }
  finally {
    for (const phone of phones.values()) await phone.close();
    delete process.env.DUOMOVE_PLAYER_TARGETS;
    resetPlayerRegistry();
  }
}

test('two eligible phones hold independent player sessions at the same time, and neither uses Demo\'s connection', async () => {
  await withFleet(async ({ phones }) => {
    const { gateway, calls } = harness(phones, new Map([['demo-phone', 'demo-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      ['phone-a', 'phone-a-token-bbbbbbbbbbbbbbbbbbbbbb'], ['phone-b', 'phone-b-token-cccccccccccccccccccccc']]));
    const drive = (imageId: string, sessionId: string) => gateway.withPlayer(imageId, async (client) => {
      const status = await client.request({ op: 'status' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const prepared = await client.request({ op: 'prepare', session_id: sessionId });
      return { instanceId: status.instance_id, sessionId: prepared.session_id };
    });
    const [a, b] = await Promise.all([drive('phone-a', 'session-a'), drive('phone-b', 'session-b')]);

    assert.equal(a.instanceId, 'instance-a');
    assert.equal(b.instanceId, 'instance-b');
    assert.equal(a.sessionId, 'session-a');
    assert.equal(b.sessionId, 'session-b');
    assert.deepEqual(phones.get('phone-a')!.sessions, ['session-a']);
    assert.deepEqual(phones.get('phone-b')!.sessions, ['session-b']);
    assert.deepEqual(phones.get('demo-phone')!.sessions, []);
    assert.equal(calls.some((call) => call.imageId === 'demo-phone'), false);
    assert.equal(calls.some((call) => call.imageId === 'phone-a' && call.endpoint !== phoneA.endpoint), false);
    assert.equal(calls.some((call) => call.imageId === 'phone-b' && call.endpoint !== phoneB.endpoint), false);
  });
});

test('a phone whose credential is missing fails on its own; it is never driven with another phone\'s token', async () => {
  await withFleet(async ({ phones }) => {
    const { gateway, calls } = harness(phones, new Map([['phone-b', 'phone-b-token-cccccccccccccccccccccc']]));
    await assert.rejects(gateway.withPlayer('phone-a', (client) => client.request({ op: 'status' })), /Player setup is incomplete/);
    const status = await gateway.withPlayer('phone-b', (client) => client.request({ op: 'status' }));
    assert.equal(status.instance_id, 'instance-b');
    assert.equal(calls.some((call) => call.imageId === 'phone-a' && call.op.startsWith('forward')), false);
    assert.deepEqual(phones.get('phone-a')!.sessions, []);
  });
});

test('an unreachable phone reports its own failure while the other phone stays ready', async () => {
  await withFleet(async ({ phones, tokens }) => {
    const { gateway, calls } = harness(phones, tokens, new Set(['phone-a']));
    const lifecycle = new PlayerLifecycle({
      adbState: async (target) => { try { await gateway.connect(target); return 'device'; } catch { return 'offline'; } },
      apkInstalled: (target) => gateway.apkInstalled(target),
      credentialPresent: (target) => gateway.hasCredential(target),
      status: async (target) => {
        const status = await gateway.withPlayer(target.imageId, (client) => client.request({ op: 'status' }));
        return { instanceId: status.instance_id, sessionId: status.session_id, state: status.state,
          cleanupOk: status.cleanup_ok, appliedSequence: status.applied_seq } satisfies PlayerStatusSummary;
      },
    });
    const [a, b] = await lifecycle.checkFleet(['phone-a', 'phone-b']);

    assert.equal(a!.code, 'UNREACHABLE');
    assert.equal(a!.ready, false);
    assert.equal(a!.endpoint, phoneA.endpoint);
    assert.equal(b!.code, 'READY');
    assert.equal(b!.ready, true);
    assert.equal(b!.instanceId, 'instance-b');
    // The failing phone is never answered through another phone's connection.
    assert.equal(calls.some((call) => call.imageId === 'phone-a' && call.endpoint !== phoneA.endpoint), false);
    assert.equal(calls.some((call) => call.imageId === 'phone-a' && call.op.startsWith('forward')), false);
  });
});

const summary = (extra: Partial<PlayerStatusSummary> = {}): PlayerStatusSummary =>
  ({ instanceId: 'instance-a', sessionId: '', state: 'IDLE', cleanupOk: true, appliedSequence: -1, ...extra });

test('each lifecycle state is reported distinctly instead of collapsing into one failure', () => {
  const cases: [Parameters<typeof evaluatePlayerReadiness>[2], string][] = [
    [{ step: 'TARGET', problem: null }, 'NOT_CONFIGURED'],
    [{ step: 'TARGET', problem: 'Player ADB endpoint is shared with another image' }, 'MISCONFIGURED'],
    [{ step: 'ENDPOINT', previousEndpoint: '10.0.0.9:5555' }, 'ENDPOINT_CHANGED'],
    [{ step: 'ADB', state: 'connecting' }, 'STARTING'],
    [{ step: 'ADB', state: 'offline' }, 'UNREACHABLE'],
    [{ step: 'ADB', state: 'unauthorized' }, 'UNAUTHENTICATED'],
    [{ step: 'APK' }, 'APK_MISSING'],
    [{ step: 'CREDENTIAL' }, 'UNAUTHENTICATED'],
    [{ step: 'CONNECT', failure: 'REFUSED' }, 'NOT_ACTIVATED'],
    [{ step: 'CONNECT', failure: 'AUTH_REJECTED' }, 'UNAUTHENTICATED'],
    [{ step: 'CONNECT', failure: 'TIMEOUT' }, 'UNREACHABLE'],
    [{ step: 'STATUS', status: summary({ cleanupOk: false }) }, 'BUSY'],
    [{ step: 'STATUS', status: summary({ state: 'PLAYING' }) }, 'BUSY'],
    [{ step: 'STATUS', status: summary({ state: 'COMPLETED' }) }, 'READY'],
    [{ step: 'STATUS', status: summary() }, 'READY'],
  ];
  for (const [outcome, code] of cases) {
    const readiness = evaluatePlayerReadiness('phone-a', phoneA.endpoint, outcome);
    assert.equal(readiness.code, code, `${outcome.step} should report ${code}`);
    assert.equal(readiness.ready, code === 'READY');
    assert.ok(readiness.detail.length > 0);
  }
});

test('a restarted player and a moved endpoint are reported, never absorbed', async () => {
  process.env.DUOMOVE_PLAYER_TARGETS = JSON.stringify([phoneA]);
  resetPlayerRegistry();
  try {
    let instanceId = 'instance-a';
    const steps: ReadinessSteps = {
      adbState: async () => 'device',
      apkInstalled: async () => true,
      credentialPresent: async () => true,
      status: async () => summary({ instanceId }),
    };
    const lifecycle = new PlayerLifecycle(steps);
    assert.equal((await lifecycle.check('phone-a')).code, 'READY');
    instanceId = 'instance-a-restarted';
    const restarted = await lifecycle.check('phone-a');
    assert.equal(restarted.code, 'RESTARTED');
    assert.equal(restarted.previousInstanceId, 'instance-a');
    assert.equal(restarted.ready, false);
    // The restart is recorded, so the next check reflects the new instance rather than repeating.
    assert.equal((await lifecycle.check('phone-a')).code, 'READY');

    process.env.DUOMOVE_PLAYER_TARGETS = JSON.stringify([{ imageId: 'phone-a', endpoint: '10.0.0.20:5555' }]);
    resetPlayerRegistry();
    const moved = await lifecycle.check('phone-a');
    assert.equal(moved.code, 'ENDPOINT_CHANGED');
    assert.equal(moved.endpoint, '10.0.0.20:5555');
    assert.equal(moved.ready, false);
    assert.equal((await lifecycle.check('phone-a')).code, 'READY');
  } finally {
    delete process.env.DUOMOVE_PLAYER_TARGETS;
    resetPlayerRegistry();
  }
});

test('credential provisioning is chosen per package, not assumed to be run-as', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'player-credentials-'));
  try {
    const pushed: { packageName: string; secret: string }[] = [];
    const tools = { pushViaRunAs: async (packageName: string, secret: string) => { pushed.push({ packageName, secret }); } };
    const slotFor = (mode: 'RUN_AS' | 'AGENT_MINTED' | 'OPERATOR_SUPPLIED', name: string) =>
      ({ imageId: 'phone-a', packageName: `net.stakeout.duomove.${name}`, path: join(directory, `${name}.token`), mode } as const);

    // The debuggable player: the controller mints the secret and pipes it in over run-as.
    const player = slotFor('RUN_AS', 'player');
    const minted = await provisionerFor('RUN_AS').provision(player, tools);
    assert.match(minted, CREDENTIAL_PATTERN);
    assert.deepEqual(pushed, [{ packageName: player.packageName, secret: minted }]);
    assert.equal(await provisionerFor('RUN_AS').provision(player, tools), minted, 'an existing credential is reused');
    const rotated = await provisionerFor('RUN_AS').provision(player, tools, { rotate: true });
    assert.notEqual(rotated, minted);
    assert.equal(pushed.at(-1)!.secret, rotated);

    // A release-signed agent has no run-as path: nothing is pushed, and the gap is explicit.
    const agent = slotFor('OPERATOR_SUPPLIED', 'radioagent');
    await assert.rejects(provisionerFor('OPERATOR_SUPPLIED').provision(agent, tools), /Provision it on the phone/);
    writeFileSync(agent.path, 'operator-supplied-token-aaaaaaaaaaaaaaaa');
    assert.equal(await provisionerFor('OPERATOR_SUPPLIED').provision(agent, tools), 'operator-supplied-token-aaaaaaaaaaaaaaaa');
    await assert.rejects(provisionerFor('OPERATOR_SUPPLIED').provision(agent, tools, { rotate: true }), /requires re-provisioning on the phone/);

    // The agent's own disclosure interface does not exist yet, and is not invented here.
    await assert.rejects(provisionerFor('AGENT_MINTED').provision(slotFor('AGENT_MINTED', 'radioagent2'), tools), /not delivered/);
    assert.equal(pushed.every((entry) => entry.packageName === player.packageName), true,
      'only the debuggable package is ever provisioned over run-as');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an unconfigured or misconfigured phone reports why, without a usable target', async () => {
  process.env.DUOMOVE_PLAYER_TARGETS = JSON.stringify([phoneA, { imageId: 'phone-b', endpoint: phoneA.endpoint }]);
  resetPlayerRegistry();
  try {
    const lifecycle = new PlayerLifecycle({
      adbState: async () => { throw new Error('no phone should be probed'); },
      apkInstalled: async () => true,
      credentialPresent: async () => true,
      status: async () => summary(),
    });
    const [shared, unknown] = await lifecycle.checkFleet(['phone-b', 'phone-z']);
    assert.equal(shared!.code, 'MISCONFIGURED');
    assert.match(shared!.detail, /shared with another image/);
    assert.equal(unknown!.code, 'NOT_CONFIGURED');
    assert.equal(unknown!.endpoint, null);
  } finally {
    delete process.env.DUOMOVE_PLAYER_TARGETS;
    resetPlayerRegistry();
  }
});
