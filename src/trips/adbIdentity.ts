import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { stateDirectory } from './playerTargets.js';

/**
 * ADB client identity for this controller.
 *
 * `adb` mints its keypair at `$HOME/.android/adbkey`, which in the deployed image is `/root/.android`
 * and not on the persistent volume, so every redeploy presents a new public key to every phone. That
 * is invisible only while the provider endpoint accepts unauthorized keys. The identity therefore
 * belongs with the per-image credential registry: injected from a secret or persisted on the volume,
 * never regenerated per deploy. A sibling deployment already pins `ADB_PRIVATE_KEY_BASE64`, so the
 * same variable name is accepted here.
 */
export type AdbIdentitySource = 'INJECTED' | 'PERSISTED' | 'EPHEMERAL';

export interface AdbIdentity {
  source: AdbIdentitySource;
  /** Key file handed to adb through `ADB_VENDOR_KEYS`, or null when the identity is ephemeral. */
  path: string | null;
  detail: string;
}

const PRIVATE_KEY_PATTERN = /^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/;

export const adbKeyDirectory = (env: NodeJS.ProcessEnv = process.env) => `${stateDirectory(env)}/adb`;
export const adbKeyPath = (env: NodeJS.ProcessEnv = process.env) => `${adbKeyDirectory(env)}/adbkey`;

function decodeKey(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const decoded = PRIVATE_KEY_PATTERN.test(value) ? value : Buffer.from(value, 'base64').toString('utf8');
  return PRIVATE_KEY_PATTERN.test(decoded.trim()) ? `${decoded.trim()}\n` : null;
}

async function readIfValid(path: string): Promise<string | null> {
  try {
    const value = await readFile(path, 'utf8');
    return PRIVATE_KEY_PATTERN.test(value.trim()) ? value : null;
  } catch { return null; }
}

/**
 * Resolves the key once, before any adb command runs: the adb server inherits `ADB_VENDOR_KEYS`
 * from the first invocation, so a later change would not be picked up without restarting it.
 */
export async function ensureAdbClientIdentity(env: NodeJS.ProcessEnv = process.env): Promise<AdbIdentity> {
  const path = adbKeyPath(env);
  const injected = decodeKey(env.ADB_CLIENT_KEY_BASE64) ?? decodeKey(env.ADB_PRIVATE_KEY_BASE64);
  let source: AdbIdentitySource = 'EPHEMERAL';
  if (injected) {
    await mkdir(adbKeyDirectory(env), { recursive: true, mode: 0o700 });
    if (await readIfValid(path) !== injected) await writeFile(path, injected, { mode: 0o600 });
    source = 'INJECTED';
  } else if (await readIfValid(path)) {
    source = 'PERSISTED';
  }
  if (source === 'EPHEMERAL') {
    return { source, path: null,
      detail: 'No ADB client key is injected or persisted. adb will mint one per deploy, so this controller presents a new public key to every phone after each redeploy.' };
  }
  const publicKey = (env.ADB_CLIENT_KEY_PUB ?? '').trim();
  if (publicKey) await writeFile(`${path}.pub`, `${publicKey}\n`, { mode: 0o644 });
  env.ADB_VENDOR_KEYS = path;
  return { source, path,
    detail: source === 'INJECTED'
      ? 'ADB client key was injected from the environment and persisted for this deployment.'
      : 'ADB client key was reused from the persistent volume.' };
}
