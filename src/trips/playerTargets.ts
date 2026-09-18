import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Per-image player targeting (B01). Every physical image that the controller may drive has its
 * own ADB endpoint, its own device-side ports and its own controller-held credential file.
 * There is no global endpoint and no fallback: an image without its own target is not drivable.
 */
export interface PlayerTarget {
  imageId: string;
  label: string;
  /** ADB serial (host:port) used for every command sent to this image. */
  endpoint: string;
  /** Device-side player control port. */
  controlPort: number;
  /** Device-side radio receiver port. The radio plugin is not shipped yet; see RADIO-IMPLEMENTATION.md. */
  radioPort: number;
  /** Controller-side file holding this image's control token. Never logged, never sent to a browser. */
  credentialPath: string;
}

export interface PlayerRegistry {
  targets: ReadonlyMap<string, PlayerTarget>;
  /** Images that were configured but cannot be used, with the reason a reader can act on. */
  problems: ReadonlyMap<string, string>;
}

export class PlayerTargetError extends Error {
  constructor(readonly imageId: string, message: string) { super(message); }
}

const DEFAULT_CONTROL_PORT = 9999;
const DEFAULT_RADIO_PORT = 9998;
const imageIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.DUOMOVE_STATE_DIR || '/app/data';
}

/** Deterministic, traversal-free credential path derived from the image identity. */
export function credentialPathFor(imageId: string, env: NodeJS.ProcessEnv = process.env): string {
  const digest = createHash('sha256').update(imageId).digest('hex').slice(0, 32);
  return `${stateDirectory(env)}/player-credentials/${digest}.token`;
}

function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const [host, port, extra] = value.split(':');
  return !extra && isIP(host ?? '') === 4 && /^\d+$/.test(port || '') && +port! >= 1 && +port! <= 65535;
}

function validPort(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null) return fallback;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535 ? value as number : null;
}

interface RawTarget { imageId?: unknown; endpoint?: unknown; label?: unknown; controlPort?: unknown; radioPort?: unknown }

function readConfiguredList(env: NodeJS.ProcessEnv): { entries: RawTarget[]; parseError: string | null } {
  const raw = (env.DUOMOVE_PLAYER_TARGETS || '').trim();
  if (!raw) return { entries: [], parseError: null };
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return { entries: [], parseError: 'DUOMOVE_PLAYER_TARGETS is not valid JSON' }; }
  if (Array.isArray(value)) return { entries: value as RawTarget[], parseError: null };
  if (value && typeof value === 'object') {
    return { entries: Object.entries(value as Record<string, unknown>).map(([imageId, endpoint]) => ({ imageId, endpoint })), parseError: null };
  }
  return { entries: [], parseError: 'DUOMOVE_PLAYER_TARGETS must be a JSON array or object' };
}

/**
 * Builds the registry without throwing: a misconfigured image becomes a visible problem for that
 * image alone, so one bad entry can never silently reassign or disable another phone.
 */
export function parsePlayerTargets(env: NodeJS.ProcessEnv = process.env): PlayerRegistry {
  const targets = new Map<string, PlayerTarget>();
  const problems = new Map<string, string>();
  const byEndpoint = new Map<string, string>();
  const { entries, parseError } = readConfiguredList(env);
  if (parseError) problems.set('*', parseError);

  const legacyImage = (env.DUOMOVE_IMAGE_ID || '').trim();
  if (legacyImage && !entries.some((entry) => typeof entry.imageId === 'string' && entry.imageId.trim() === legacyImage)) {
    entries.push({ imageId: legacyImage, endpoint: (env.ADB_PREFLIGHT_ENDPOINT || '').trim(), label: 'Configured player' });
  }

  for (const [index, entry] of entries.entries()) {
    const imageId = typeof entry.imageId === 'string' ? entry.imageId.trim() : '';
    const key = imageId || `#${index}`;
    if (!imageIdPattern.test(imageId)) { problems.set(key, 'Player target has an invalid image identifier'); continue; }
    if (targets.has(imageId) || problems.has(imageId)) {
      // Never guess which duplicate row is authoritative.
      targets.delete(imageId);
      problems.set(imageId, 'Player target is defined more than once');
      continue;
    }
    if (!validEndpoint(entry.endpoint)) { problems.set(imageId, 'Player ADB endpoint is invalid'); continue; }
    const endpoint = entry.endpoint;
    const controlPort = validPort(entry.controlPort, DEFAULT_CONTROL_PORT);
    const radioPort = validPort(entry.radioPort, DEFAULT_RADIO_PORT);
    if (controlPort === null || radioPort === null) { problems.set(imageId, 'Player device port is invalid'); continue; }
    const owner = byEndpoint.get(endpoint);
    if (owner) {
      // Two images on one endpoint would route one phone's commands to another phone.
      targets.delete(owner);
      problems.set(owner, 'Player ADB endpoint is shared with another image');
      problems.set(imageId, 'Player ADB endpoint is shared with another image');
      continue;
    }
    byEndpoint.set(endpoint, imageId);
    targets.set(imageId, { imageId, label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, 80) : imageId,
      endpoint, controlPort, radioPort, credentialPath: credentialPathFor(imageId, env) });
  }
  return { targets, problems };
}

let cached: { registry: PlayerRegistry; source: string } | undefined;

export function playerRegistry(env: NodeJS.ProcessEnv = process.env): PlayerRegistry {
  const source = `${env.DUOMOVE_PLAYER_TARGETS || ''}|${env.DUOMOVE_IMAGE_ID || ''}|${env.ADB_PREFLIGHT_ENDPOINT || ''}|${stateDirectory(env)}`;
  if (!cached || cached.source !== source) cached = { registry: parsePlayerTargets(env), source };
  return cached.registry;
}

export function resetPlayerRegistry(): void { cached = undefined; }

export function playerImageIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...playerRegistry(env).targets.keys()];
}

export function usesPlayer(imageId: string): boolean {
  return Boolean(imageId) && playerRegistry().targets.has(imageId);
}

export function findPlayerTarget(imageId: string, env: NodeJS.ProcessEnv = process.env): PlayerTarget | undefined {
  return playerRegistry(env).targets.get(imageId);
}

export function playerTargetProblem(imageId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const registry = playerRegistry(env);
  return registry.problems.get(imageId) ?? registry.problems.get('*') ?? null;
}

/** Resolves the only connection this image may use. It never falls back to another image's target. */
export function requirePlayerTarget(imageId: string, env: NodeJS.ProcessEnv = process.env): PlayerTarget {
  const target = findPlayerTarget(imageId, env);
  if (target) return target;
  const problem = playerTargetProblem(imageId, env);
  throw new PlayerTargetError(imageId, problem ?? 'This phone has no configured player connection');
}
