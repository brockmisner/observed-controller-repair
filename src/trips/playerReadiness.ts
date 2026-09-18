import { PlayerTargetError, findPlayerTarget, playerTargetProblem, type PlayerTarget } from './playerTargets.js';
import { terminal } from './playerProtocol.js';
import type { PlayerGateway } from './playerConnection.js';
import { players } from './playerConnection.js';

/**
 * Per-phone connectivity and readiness lifecycle (B02).
 *
 * Each image is evaluated only from its own target, so one unreachable phone can never be answered
 * by another phone's connection and never silently degrades into a partly working mode.
 */
export type PlayerReadinessCode =
  | 'READY'
  | 'NOT_CONFIGURED'
  | 'MISCONFIGURED'
  | 'ENDPOINT_CHANGED'
  | 'UNREACHABLE'
  | 'STARTING'
  | 'APK_MISSING'
  | 'NOT_ACTIVATED'
  | 'UNAUTHENTICATED'
  | 'RESTARTED'
  | 'FOREIGN_SESSION'
  | 'BUSY';

export interface PlayerStatusSummary {
  instanceId: string;
  sessionId: string;
  state: string;
  cleanupOk: boolean;
  appliedSequence: number;
}

export type PhonePowerState = 'ON' | 'OFF' | 'STARTING' | 'UNKNOWN';

export type PlayerProbeOutcome =
  | { step: 'TARGET'; problem: string | null }
  | { step: 'ENDPOINT'; previousEndpoint: string }
  | { step: 'POWER'; state: Exclude<PhonePowerState, 'ON'> }
  | { step: 'ADB'; state: string }
  | { step: 'APK' }
  | { step: 'CREDENTIAL' }
  | { step: 'CONNECT'; failure: 'REFUSED' | 'AUTH_REJECTED' | 'TIMEOUT' | 'CLOSED' }
  | { step: 'STATUS'; status: PlayerStatusSummary };

export interface RememberedPlayer {
  endpoint: string;
  instanceId: string | null;
  sessionId: string | null;
}

export interface PlayerReadiness {
  imageId: string;
  endpoint: string | null;
  code: PlayerReadinessCode;
  ready: boolean;
  detail: string;
  checkedAt: string;
  instanceId: string | null;
  sessionId: string | null;
  previousInstanceId: string | null;
  appliedSequence: number | null;
}

const result = (
  imageId: string,
  endpoint: string | null,
  code: PlayerReadinessCode,
  detail: string,
  checkedAt: string,
  extra: Partial<PlayerReadiness> = {},
): PlayerReadiness => ({
  imageId, endpoint, code, ready: code === 'READY', detail, checkedAt,
  instanceId: null, sessionId: null, previousInstanceId: null, appliedSequence: null, ...extra,
});

export interface ReadinessContext {
  remembered?: RememberedPlayer;
  /** Sessions this controller opened. Anything else on the phone is somebody else's writer. */
  authorizedSessions?: string[];
  checkedAt?: string;
}

/** Pure mapping from one probe outcome to one truthful readiness result. */
export function evaluatePlayerReadiness(
  imageId: string,
  endpoint: string | null,
  outcome: PlayerProbeOutcome,
  context: ReadinessContext = {},
): PlayerReadiness {
  const { remembered, authorizedSessions = [] } = context;
  const checkedAt = context.checkedAt ?? new Date().toISOString();
  switch (outcome.step) {
    case 'TARGET':
      return outcome.problem
        ? result(imageId, null, 'MISCONFIGURED', outcome.problem, checkedAt)
        : result(imageId, null, 'NOT_CONFIGURED', 'This phone has no configured player connection', checkedAt);
    case 'ENDPOINT':
      return result(imageId, endpoint, 'ENDPOINT_CHANGED',
        `The player endpoint changed from ${outcome.previousEndpoint}. Re-check this phone before driving it.`, checkedAt);
    case 'POWER':
      if (outcome.state === 'STARTING') return result(imageId, endpoint, 'STARTING', 'The phone is still starting', checkedAt);
      return result(imageId, endpoint, 'UNREACHABLE', outcome.state === 'OFF'
        ? 'The phone is powered off' : 'The phone\'s power state is not confirmed', checkedAt);
    case 'ADB':
      if (outcome.state === 'unauthorized') {
        return result(imageId, endpoint, 'UNAUTHENTICATED', 'ADB access is not authorized on this phone', checkedAt);
      }
      if (['connecting', 'bootloader', 'recovery', 'sideload', 'booting'].includes(outcome.state)) {
        return result(imageId, endpoint, 'STARTING', 'The phone is powering on or still booting', checkedAt);
      }
      return result(imageId, endpoint, 'UNREACHABLE',
        `The phone is not reachable over ADB at ${endpoint ?? 'its endpoint'} (${outcome.state})`, checkedAt);
    case 'APK':
      return result(imageId, endpoint, 'APK_MISSING', 'DuoMove Player is not installed on this phone', checkedAt);
    case 'CREDENTIAL':
      return result(imageId, endpoint, 'UNAUTHENTICATED', 'This phone has no provisioned player credential', checkedAt);
    case 'CONNECT':
      if (outcome.failure === 'AUTH_REJECTED') {
        return result(imageId, endpoint, 'UNAUTHENTICATED', 'The player rejected this phone\'s credential', checkedAt);
      }
      if (outcome.failure === 'TIMEOUT') {
        return result(imageId, endpoint, 'UNREACHABLE', 'The player did not answer on this phone', checkedAt);
      }
      return result(imageId, endpoint, 'NOT_ACTIVATED',
        'DuoMove Player is installed but not running on this phone. Activate it before driving.', checkedAt);
    case 'STATUS': {
      const { status } = outcome;
      const identity = { instanceId: status.instanceId, sessionId: status.sessionId || null,
        previousInstanceId: remembered?.instanceId ?? null, appliedSequence: status.appliedSequence };
      // Other deployments reach these phones over ADB without seeing this controller's lease, so a
      // session we did not open is reported as a foreign writer rather than as our own busy phone.
      if (status.sessionId && !authorizedSessions.includes(status.sessionId)) {
        return result(imageId, endpoint, 'FOREIGN_SESSION',
          'A player session this controller did not authorize is running on this phone. Another system or an earlier controller process owns it.',
          checkedAt, identity);
      }
      if (remembered?.instanceId && remembered.instanceId !== status.instanceId) {
        return result(imageId, endpoint, 'RESTARTED',
          'The player restarted on this phone. No session was replayed; start explicitly.', checkedAt, identity);
      }
      if (!status.cleanupOk) {
        return result(imageId, endpoint, 'BUSY', 'Player provider cleanup is unconfirmed on this phone', checkedAt, identity);
      }
      if (status.state !== 'IDLE' && !terminal(status)) {
        return result(imageId, endpoint, 'BUSY', `The player is ${status.state} on this phone`, checkedAt, identity);
      }
      return result(imageId, endpoint, 'READY', 'The player answered on this phone and is idle', checkedAt, identity);
    }
  }
}

export interface LifecycleDeps {
  /** Sessions this controller owns for an image, including ones opened before a restart. */
  authorizedSessions?(imageId: string): Promise<string[]>;
}

export interface ReadinessSteps {
  adbState(target: PlayerTarget): Promise<string>;
  apkInstalled(target: PlayerTarget): Promise<boolean>;
  credentialPresent(target: PlayerTarget): Promise<boolean>;
  status(target: PlayerTarget): Promise<PlayerStatusSummary>;
}

export function classifyConnectFailure(error: unknown): Extract<PlayerProbeOutcome, { step: 'CONNECT' }>['failure'] {
  const message = error instanceof Error ? error.message : '';
  if (/rejected the command|invalid response/i.test(message)) return 'AUTH_REJECTED';
  if (/timed out/i.test(message)) return 'TIMEOUT';
  if (/connection closed/i.test(message)) return 'CLOSED';
  return 'REFUSED';
}

/** Readiness steps backed by one image's own gateway connection. */
export function gatewaySteps(gateway: PlayerGateway = players): ReadinessSteps {
  return {
    adbState: (target) => gateway.probeState(target),
    apkInstalled: (target) => gateway.apkInstalled(target),
    credentialPresent: (target) => gateway.hasCredential(target),
    async status(target) {
      const status = await gateway.withPlayer(target.imageId, c => c.request({ op: 'status' }));
      return { instanceId: status.instance_id, sessionId: status.session_id, state: status.state,
        cleanupOk: status.cleanup_ok, appliedSequence: status.applied_seq };
    },
  };
}

/** Remembers each image's endpoint and player instance so changes are reported, never absorbed. */
export class PlayerLifecycle {
  private memory = new Map<string, RememberedPlayer>();
  private last = new Map<string, PlayerReadiness>();
  private authorized = new Map<string, Set<string>>();
  constructor(private readonly steps: ReadinessSteps, private readonly deps: LifecycleDeps = {},
    private readonly clock: () => Date = () => new Date()) {}

  remembered(imageId: string): RememberedPlayer | undefined { return this.memory.get(imageId); }
  lastReadiness(imageId: string): PlayerReadiness | undefined { return this.last.get(imageId); }
  forget(imageId: string): void { this.memory.delete(imageId); this.last.delete(imageId); }

  /** Records a session this controller opened, before any command is sent under it. */
  authorize(imageId: string, sessionId: string): void {
    const sessions = this.authorized.get(imageId) ?? new Set<string>();
    sessions.add(sessionId);
    this.authorized.set(imageId, sessions);
  }
  release(imageId: string, sessionId: string): void { this.authorized.get(imageId)?.delete(sessionId); }

  private async authorizedSessions(imageId: string): Promise<string[]> {
    const own = [...this.authorized.get(imageId) ?? []];
    const persisted = await this.deps.authorizedSessions?.(imageId).catch(() => []) ?? [];
    return [...new Set([...own, ...persisted])];
  }

  async check(imageId: string, context: { power?: PhonePowerState } = {}): Promise<PlayerReadiness> {
    const checkedAt = this.clock().toISOString();
    let target: PlayerTarget;
    try {
      const found = findPlayerTarget(imageId);
      if (!found) throw new PlayerTargetError(imageId, 'missing');
      target = found;
    } catch {
      return this.record(imageId, evaluatePlayerReadiness(imageId, null, { step: 'TARGET', problem: playerTargetProblem(imageId) }, { checkedAt }));
    }
    const remembered = this.memory.get(imageId);
    if (remembered && remembered.endpoint !== target.endpoint) {
      this.memory.set(imageId, { endpoint: target.endpoint, instanceId: null, sessionId: null });
      return this.record(imageId, evaluatePlayerReadiness(imageId, target.endpoint,
        { step: 'ENDPOINT', previousEndpoint: remembered.endpoint }, { checkedAt }));
    }
    // A phone that is off or still starting is reported as such rather than probed into a timeout.
    if (context.power && context.power !== 'ON') {
      return this.record(imageId, evaluatePlayerReadiness(imageId, target.endpoint,
        { step: 'POWER', state: context.power }, { remembered, checkedAt }));
    }
    const outcome = await this.probe(target);
    const readiness = evaluatePlayerReadiness(imageId, target.endpoint, outcome,
      { remembered, checkedAt, authorizedSessions: await this.authorizedSessions(imageId) });
    if (outcome.step === 'STATUS') {
      this.memory.set(imageId, { endpoint: target.endpoint, instanceId: outcome.status.instanceId, sessionId: outcome.status.sessionId || null });
    } else if (!this.memory.has(imageId)) {
      this.memory.set(imageId, { endpoint: target.endpoint, instanceId: null, sessionId: null });
    }
    return this.record(imageId, readiness);
  }

  private async probe(target: PlayerTarget): Promise<PlayerProbeOutcome> {
    const state = await this.steps.adbState(target);
    if (state !== 'device') return { step: 'ADB', state };
    if (!await this.steps.apkInstalled(target)) return { step: 'APK' };
    if (!await this.steps.credentialPresent(target)) return { step: 'CREDENTIAL' };
    try { return { step: 'STATUS', status: await this.steps.status(target) }; }
    catch (error) { return { step: 'CONNECT', failure: classifyConnectFailure(error) }; }
  }

  private record(imageId: string, readiness: PlayerReadiness): PlayerReadiness {
    this.last.set(imageId, readiness);
    return readiness;
  }

  /** Independent checks: one phone's failure never changes another phone's result. */
  async checkFleet(imageIds: string[]): Promise<PlayerReadiness[]> {
    return Promise.all(imageIds.map(imageId => this.check(imageId)));
  }
}

/** Trips persist the sessions this controller opened, so a restart does not forget its own work. */
async function persistedSessions(imageId: string): Promise<string[]> {
  const { prisma } = await import('../db.js');
  const trips = await prisma.drivingTrip.findMany({
    where: { imageId, status: { in: ['RUNNING', 'ARRIVING', 'PAUSED'] } },
    select: { phoneSyncJson: true },
  });
  return trips.flatMap((trip) => {
    try {
      const sessionId = JSON.parse(trip.phoneSyncJson || '{}').player?.sessionId;
      return typeof sessionId === 'string' && sessionId ? [sessionId] : [];
    } catch { return []; }
  });
}

export const playerLifecycle = new PlayerLifecycle(gatewaySteps(), { authorizedSessions: persistedSessions });
