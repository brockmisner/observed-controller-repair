import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CredentialMode, PlayerTarget } from './playerTargets.js';

/**
 * Credential provisioning for one image's device-side channel.
 *
 * The shipped GPS player is debug-signed and `debuggable="true"`, which is the only reason the
 * controller can pipe its token in over `adb shell run-as`. The radio agent is intended to be
 * release-signed, so that path will not exist for it. Provisioning is therefore chosen per
 * credential slot rather than assumed.
 */
export const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export interface CredentialSlot {
  imageId: string;
  /** Device-side package that reads this credential. */
  packageName: string;
  /** Controller-side file that holds it. Mode 0600, never logged, never sent to a browser. */
  path: string;
  /** Pre-registry location for this credential, adopted once so a running phone keeps working. */
  legacyPath?: string | null;
  mode: CredentialMode;
}

export interface CredentialTools {
  /** Pipes a secret into the package's private files over `adb shell run-as`, on stdin only. */
  pushViaRunAs(packageName: string, secret: string): Promise<void>;
}

export interface CredentialProvisioner {
  readonly mode: CredentialMode;
  /** Ensures the credential exists on both sides and returns the controller-held secret. */
  provision(slot: CredentialSlot, tools: CredentialTools, options?: { rotate?: boolean }): Promise<string>;
}

export class CredentialProvisioningError extends Error {}

export const playerCredentialSlot = (target: PlayerTarget): CredentialSlot =>
  ({ imageId: target.imageId, packageName: target.playerPackage, path: target.credentialPath,
    legacyPath: target.legacyCredentialPath, mode: target.credentialMode });

export const radioAgentCredentialSlot = (target: PlayerTarget): CredentialSlot =>
  ({ imageId: target.imageId, packageName: target.radioAgent.packageName, path: target.radioAgent.credentialPath,
    mode: target.radioAgent.credentialMode });

export async function readCredentialFile(path: string): Promise<string | null> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    return CREDENTIAL_PATTERN.test(value) ? value : null;
  } catch { return null; }
}

/**
 * Reads the slot, adopting the pre-registry file once when only that exists. The phone already
 * holds that token, so a deployment that upgrades into per-image credentials keeps working.
 */
export async function readCredentialSlot(slot: CredentialSlot): Promise<string | null> {
  const current = await readCredentialFile(slot.path);
  if (current) return current;
  if (!slot.legacyPath) return null;
  const legacy = await readCredentialFile(slot.legacyPath);
  if (!legacy) return null;
  await writeCredentialFile(slot.path, legacy);
  return legacy;
}

async function writeCredentialFile(path: string, secret: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, secret, { mode: 0o600 });
}

/** Debuggable packages only. The controller mints the secret and pushes it in over stdin. */
export const runAsProvisioner: CredentialProvisioner = {
  mode: 'RUN_AS',
  async provision(slot, tools, options = {}) {
    const existing = options.rotate ? null : await readCredentialSlot(slot);
    const secret = existing ?? randomBytes(32).toString('base64url');
    if (!existing) await writeCredentialFile(slot.path, secret);
    await tools.pushViaRunAs(slot.packageName, secret);
    return secret;
  },
};

/**
 * A release-signed package cannot be provisioned over `run-as`. The operator places the secret the
 * package already holds on the controller; nothing is pushed to the phone, and rotation is the
 * operator's action, not something the controller can fake.
 */
export const operatorSuppliedProvisioner: CredentialProvisioner = {
  mode: 'OPERATOR_SUPPLIED',
  async provision(slot, _tools, options = {}) {
    if (options.rotate) {
      throw new CredentialProvisioningError(
        `Rotating ${slot.packageName} on ${slot.imageId} requires re-provisioning on the phone and replacing ${slot.path}`);
    }
    const secret = await readCredentialSlot(slot);
    if (!secret) {
      throw new CredentialProvisioningError(
        `No credential for ${slot.packageName} on ${slot.imageId}. Provision it on the phone and place it at ${slot.path}`);
    }
    return secret;
  },
};

/**
 * The agent mints its own credential and discloses it once to a caller holding shell. The
 * disclosure interface belongs to the agent APK, which has not been delivered, so this mode
 * reports that it is unavailable instead of inventing a handshake.
 */
export const agentMintedProvisioner: CredentialProvisioner = {
  mode: 'AGENT_MINTED',
  async provision(slot) {
    const existing = await readCredentialSlot(slot);
    if (existing) return existing;
    throw new CredentialProvisioningError(
      `Agent-minted credentials need the radio agent's disclosure interface, which is not delivered. ` +
      `Supply ${slot.packageName}'s credential at ${slot.path} on ${slot.imageId} in the meantime`);
  },
};

const provisioners = new Map<CredentialMode, CredentialProvisioner>(
  [runAsProvisioner, operatorSuppliedProvisioner, agentMintedProvisioner].map((provisioner) => [provisioner.mode, provisioner]));

export function provisionerFor(mode: CredentialMode): CredentialProvisioner {
  const provisioner = provisioners.get(mode);
  if (!provisioner) throw new CredentialProvisioningError(`Unsupported credential mode ${mode}`);
  return provisioner;
}

/** Reads an already-provisioned credential. Never provisions as a side effect of a read. */
export async function requireCredential(slot: CredentialSlot): Promise<string> {
  const secret = await readCredentialSlot(slot);
  if (!secret) {
    throw new CredentialProvisioningError(slot.mode === 'RUN_AS'
      ? `${slot.packageName} setup is incomplete on ${slot.imageId}`
      : `No credential for ${slot.packageName} on ${slot.imageId}. Provision it and place it at ${slot.path}`);
  }
  return secret;
}
