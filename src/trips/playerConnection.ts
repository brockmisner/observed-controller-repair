import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { PlayerSocket } from './playerProtocol.js';
import { logger } from '../logger.js';
import { readPhoneLocation, PHONE_LOCATION_COMMAND } from '../api/phoneNavigation.js';
import { installedPlayerInfo, playerApkPath, PLAYER_PACKAGE } from '../ops/playerVerification.js';
import { playerImageIds, playerRegistry, requirePlayerTarget, findPlayerTarget, PlayerTargetError, type PlayerTarget } from './playerTargets.js';
import { connectLoopback, createAuthenticatedRadioTransport, type RadioTransport } from './radioTransport.js';
import { previewRadioCodec, type RadioWireCodec } from './radioWire.js';
import { playerCredentialSlot, provisionerFor, radioAgentCredentialSlot, requireCredential,
  type CredentialSlot, type CredentialTools } from './playerCredentials.js';
import { ensureAdbClientIdentity, type AdbIdentity } from './adbIdentity.js';

export { playerImageIds, findPlayerTarget, requirePlayerTarget, PlayerTargetError, usesPlayer, playerTargetProblem, type PlayerTarget } from './playerTargets.js';

const exec = promisify(execFile);

/** Every device-side command is addressed to one image's own endpoint. Injectable for tests. */
export interface PlayerAdbDriver {
  connect(target: PlayerTarget): Promise<void>;
  state(target: PlayerTarget): Promise<string>;
  shell(target: PlayerTarget, args: string[], timeoutMs?: number): Promise<string>;
  forward(target: PlayerTarget, devicePort: number): Promise<number>;
  removeForward(target: PlayerTarget, localPort: number): Promise<void>;
  /** Pipes a secret into one package's private files on stdin. Debuggable packages only. */
  pushControlToken(target: PlayerTarget, packageName: string, token: string): Promise<void>;
}

async function adb(endpoint: string, args: string[], timeout = 12000): Promise<string> {
  try { return (await exec('adb', ['-s', endpoint, ...args], { timeout, maxBuffer: 65536 })).stdout.trim(); }
  catch { throw new Error('Player ADB command failed; check the phone connection'); }
}

export const realAdbDriver: PlayerAdbDriver = {
  async connect(target) {
    try { await exec('adb', ['connect', target.endpoint], { timeout: 12000, maxBuffer: 65536 }); }
    catch { throw new Error('Player ADB command failed; check the phone connection'); }
  },
  state: (target) => adb(target.endpoint, ['get-state']),
  shell: (target, args, timeoutMs) => adb(target.endpoint, ['shell', ...args], timeoutMs),
  async forward(target, devicePort) {
    const port = await adb(target.endpoint, ['forward', 'tcp:0', `tcp:${devicePort}`]);
    if (!/^\d+$/.test(port)) throw new Error('Player tunnel was not created');
    return Number(port);
  },
  async removeForward(target, localPort) { await adb(target.endpoint, ['forward', '--remove', `tcp:${localPort}`]); },
  // Fixed commands only. Token is passed on stdin into app-private storage, never in argv/logs.
  pushControlToken(target, packageName, token) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn('adb', ['-s', target.endpoint, 'shell', 'run-as', packageName, 'sh', '-c', "'umask 077; mkdir -p files; cat > files/control-token'"], { stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Player token setup timed out')); }, 12000);
      child.on('error', () => { clearTimeout(timer); reject(new Error('Player token setup failed')); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Player token setup failed')); });
      child.stdin.on('error', () => {}); child.stdin.end(token);
    });
  },
};

export interface PlayerGatewayDeps {
  adb: PlayerAdbDriver;
  /** Reads an already-provisioned credential for one slot on one image. */
  readCredential(slot: CredentialSlot): Promise<string>;
  /** Provisions a slot through the mode that slot declares. */
  provisionCredential(slot: CredentialSlot, tools: CredentialTools, options?: { rotate?: boolean }): Promise<string>;
  connectSocket(localPort: number, token: string): Promise<PlayerSocket>;
}

export const fileCredentials = {
  readCredential: requireCredential,
  provisionCredential: (slot: CredentialSlot, tools: CredentialTools, options?: { rotate?: boolean }) =>
    provisionerFor(slot.mode).provision(slot, tools, options),
};

/**
 * Per-image player transport (B01). Each call resolves the image's own endpoint and its own
 * credential; there is no shared endpoint and no fallback to another image's connection.
 */
export class PlayerGateway {
  private inspections = new Map<string, Promise<PlayerInspection>>();
  constructor(private readonly deps: PlayerGatewayDeps) {}

  target(imageId: string): PlayerTarget { return requirePlayerTarget(imageId); }

  async connect(target: PlayerTarget): Promise<void> {
    await this.deps.adb.connect(target);
    if (await this.deps.adb.state(target) !== 'device') throw new Error('Player phone is not connected');
  }

  /** Reports the phone's own ADB state rather than collapsing every failure into one word. */
  async probeState(target: PlayerTarget): Promise<string> {
    try { await this.deps.adb.connect(target); }
    catch { return 'unreachable'; }
    try { return await this.deps.adb.state(target); }
    catch { return 'unreachable'; }
  }

  async withPlayer<T>(imageId: string, work: (client: PlayerSocket, target: PlayerTarget) => Promise<T>): Promise<T> {
    const target = this.target(imageId);
    await this.connect(target);
    const token = await this.deps.readCredential(playerCredentialSlot(target));
    const port = await this.deps.adb.forward(target, target.controlPort);
    let client: PlayerSocket | undefined;
    try { client = await this.deps.connectSocket(port, token); return await work(client, target); }
    finally { client?.close(); await this.deps.adb.removeForward(target, port).catch(() => {}); }
  }

  shell(target: PlayerTarget, args: string[], timeoutMs?: number): Promise<string> {
    return this.deps.adb.shell(target, args, timeoutMs);
  }

  async apkInstalled(target: PlayerTarget, packageName: string = target.playerPackage): Promise<boolean> {
    return (await this.deps.adb.shell(target, ['pm', 'path', packageName])).startsWith('package:');
  }

  async hasCredential(target: PlayerTarget, slot: CredentialSlot = playerCredentialSlot(target)): Promise<boolean> {
    try { return Boolean(await this.deps.readCredential(slot)); } catch { return false; }
  }

  async observe(imageId: string) {
    const target = this.target(imageId);
    const startedAt = Date.now();
    const content = await this.deps.adb.shell(target, [PHONE_LOCATION_COMMAND], 2500);
    return readPhoneLocation(content, new Date(), Date.now() - startedAt);
  }

  /**
   * Opens this image's own authenticated radio channel. The radio APK is not delivered yet, so in
   * production this reports an unreachable receiver rather than pretending a frame was applied.
   */
  async openRadioTransport(imageId: string, codec: RadioWireCodec = previewRadioCodec): Promise<OpenRadioTransport> {
    const target = this.target(imageId);
    await this.connect(target);
    const localPort = await this.deps.adb.forward(target, target.radioAgent.port);
    const transport = createAuthenticatedRadioTransport({
      imageId, codec,
      connect: () => connectLoopback(localPort),
      credential: () => this.deps.readCredential(radioAgentCredentialSlot(target)),
    });
    return {
      transport, target,
      close: async () => { transport.close(); await this.deps.adb.removeForward(target, localPort).catch(() => {}); },
    };
  }

  /** Provisions one image. Never touches another image's endpoint, token file or app data. */
  async initialize(imageId: string): Promise<void> {
    const target = this.target(imageId);
    await this.connect(target);
    const pkg = target.playerPackage;
    if (!(await this.deps.adb.shell(target, ['pm', 'path', pkg])).startsWith('package:')) throw new Error('DuoMove Player is not installed');
    await this.deps.adb.shell(target, ['am', 'force-stop', pkg]);
    await this.deps.provisionCredential(playerCredentialSlot(target), {
      pushViaRunAs: (packageName, secret) => this.deps.adb.pushControlToken(target, packageName, secret),
    });
    for (const permission of ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'POST_NOTIFICATIONS']) {
      await this.deps.adb.shell(target, ['pm', 'grant', pkg, `android.permission.${permission}`]);
    }
    await this.deps.adb.shell(target, ['appops', 'set', pkg, 'android:mock_location', 'allow']);
    await this.deps.adb.shell(target, ['am', 'start', '-W', '-n', `${pkg}/.MainActivity`]);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const status = await this.withPlayer(imageId, c => c.request({ op: 'status' }));
        if (status.cleanup_ok === true && status.state === 'IDLE') return;
      } catch { /* The phone may still be starting the player. */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Player did not become ready; check location permissions');
  }

  /** Shares concurrent checks per image. Status never starts, cancels or heartbeats a route. */
  inspect(imageId: string): Promise<PlayerInspection> {
    const existing = this.inspections.get(imageId);
    if (existing) return existing;
    const pending = this.runInspection(imageId).finally(() => { this.inspections.delete(imageId); });
    this.inspections.set(imageId, pending);
    return pending;
  }

  private async runInspection(imageId: string): Promise<PlayerInspection> {
    return this.withPlayer(imageId, async (client, target) => {
      const status = await client.request({ op: 'status' });
      const [installed, location] = await Promise.allSettled([
        (async () => {
          const path = playerApkPath(await this.deps.adb.shell(target, ['pm', 'path', PLAYER_PACKAGE]));
          const [dump, checksum] = await Promise.all([
            this.deps.adb.shell(target, ['dumpsys', 'package', PLAYER_PACKAGE]),
            this.deps.adb.shell(target, ['sha256sum', path]),
          ]);
          return installedPlayerInfo(dump, checksum);
        })(),
        this.observe(imageId),
      ]);
      const sequence = (value: unknown) => Number.isInteger(value) && Number(value) >= -1 ? Number(value) : null;
      return {
        imageId, checkedAt: new Date().toISOString(), readOnly: true,
        installed: installed.status === 'fulfilled' ? installed.value : null,
        installedError: installed.status === 'rejected' ? 'Installed APK identity could not be read' : null,
        player: { connected: true, state: status.state, cleanupOk: status.cleanup_ok,
          appliedSequence: sequence(status.applied_seq), frameworkObservedSequence: sequence(status.framework_observed_seq),
          fusedObservedSequence: sequence(status.fused_observed_seq),
          synthetic: typeof status.synthetic === 'boolean' ? status.synthetic : null,
          observationScope: status.observer_scope === 'player_app' ? 'player_app' : 'UNKNOWN' },
        observation: location.status === 'fulfilled' ? location.value : null,
        locationError: location.status === 'rejected' ? 'Android location readback was unavailable' : null,
        radios: { wifi: 'NOT_OBSERVED', cell: 'NOT_OBSERVED', bluetooth: 'NOT_OBSERVED' },
      };
    });
  }
}

export interface OpenRadioTransport {
  transport: RadioTransport;
  target: PlayerTarget;
  close(): Promise<void>;
}

export interface PlayerInspection {
  imageId: string; checkedAt: string; readOnly: true;
  installed: ReturnType<typeof installedPlayerInfo> | null;
  installedError: string | null;
  player: { connected: boolean; state: string; cleanupOk: boolean; appliedSequence: number | null;
    frameworkObservedSequence: number | null; fusedObservedSequence: number | null;
    synthetic: boolean | null; observationScope: string };
  observation: Awaited<ReturnType<typeof readPhoneLocation>> | null;
  locationError: string | null;
  radios: { wifi: string; cell: string; bluetooth: string };
}

export const players = new PlayerGateway({
  adb: realAdbDriver,
  readCredential: fileCredentials.readCredential,
  provisionCredential: fileCredentials.provisionCredential,
  connectSocket: (port, token) => PlayerSocket.connect(port, token),
});

export function withPlayer<T>(imageId: string, work: (client: PlayerSocket) => Promise<T>): Promise<T> {
  return players.withPlayer(imageId, work);
}
export function observePlayerPhone(imageId: string) { return players.observe(imageId); }
export function inspectPlayerPhone(imageId: string) { return players.inspect(imageId); }

/** Provisions every configured image independently and reports each result on its own. */
export async function initializePlayers(): Promise<void> {
  const identity = await ensureAdbClientIdentity().catch((error): AdbIdentity =>
    ({ source: 'EPHEMERAL', path: null, detail: error instanceof Error ? error.message : 'ADB client identity could not be resolved' }));
  logger[identity.source === 'EPHEMERAL' ? 'warn' : 'info'](
    { event: 'adb_identity', source: identity.source, reason: identity.detail }, 'ADB client identity');
  const registry = playerRegistry();
  for (const [imageId, problem] of registry.problems) {
    logger.warn({ event: 'duomove_setup', imageId, state: 'MISCONFIGURED', reason: problem }, 'DuoMove target requires attention');
  }
  for (const imageId of playerImageIds()) {
    try {
      await players.initialize(imageId);
      logger.info({ event: 'duomove_setup', imageId, state: 'READY' }, 'DuoMove Player connected');
    } catch (error) {
      logger.warn({ event: 'duomove_setup', imageId, state: 'FAILED',
        reason: error instanceof Error ? error.message : 'Setup failed' }, 'DuoMove setup requires attention');
    }
  }
}
