import { HttpError } from '../http/errors.js';

export const UPLOADED_PLAYER_SHA256 = '620d7714280e98048a16d7fcd0320fed3d8925c7377997eadad4b99adfcd5dbf';
export const PLAYER_PACKAGE = 'net.stakeout.duomove.player';

export function playerApkPath(output: string): string {
  const paths = output.trim().split(/\r?\n/);
  if (paths.length !== 1 || !/^package:\/data\/app\/[A-Za-z0-9_~+=.\/-]+\/base\.apk$/.test(paths[0]!)) {
    throw new Error('Installed player APK path was not recognized');
  }
  return paths[0]!.slice('package:'.length);
}

export function installedPlayerInfo(dump: string, checksum: string) {
  const sha256 = /^([a-f0-9]{64})\s+\S+\s*$/i.exec(checksum.trim())?.[1]?.toLowerCase();
  const versionCode = /^\s*versionCode=(\d+)\b/m.exec(dump)?.[1];
  const versionName = /^\s*versionName=([^\r\n]{1,80})/m.exec(dump)?.[1]?.trim();
  if (!sha256 || !versionCode || !versionName) throw new Error('Installed player metadata was incomplete');
  return { packageName: PLAYER_PACKAGE, versionCode: Number(versionCode), versionName, sha256,
    matchesUploadedApk: sha256 === UPLOADED_PLAYER_SHA256 };
}

interface Identity { id: string; tenantId: string; imageId: string }
interface Dependencies<T> {
  getDevice(id: string, tenantId: string): Promise<Identity | null>;
  otherTenantHasImage(imageId: string, tenantId: string): Promise<boolean>;
  configuredImage(): string;
  inspect(): Promise<T>;
}

/** Fixed read-only inspection; rechecks identity before releasing any phone data. */
export async function verifyPlayer<T>(id: string, tenantId: string, deps: Dependencies<T>) {
  if (!tenantId) throw new HttpError(401, 'Workspace required');
  const check = async (expected?: string) => {
    const device = await deps.getDevice(id, tenantId);
    if (!device || device.id !== id || device.tenantId !== tenantId || expected && expected !== device.imageId) {
      throw new HttpError(404, 'Device not found');
    }
    if (!device.imageId || device.imageId !== deps.configuredImage()) {
      throw new HttpError(409, 'Direct player verification is not configured for this phone');
    }
    if (await deps.otherTenantHasImage(device.imageId, tenantId)) {
      throw new HttpError(409, 'Resolve the shared physical-phone assignment before inspecting this phone');
    }
    return device;
  };
  const device = await check();
  const result = await deps.inspect();
  await check(device.imageId);
  return { deviceId: id, imageId: device.imageId, ...result };
}
