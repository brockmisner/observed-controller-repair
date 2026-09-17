import { prisma } from "../db.js";
import { usesPlayer } from "../trips/playerConnection.js";
import axios, { AxiosError, type AxiosInstance } from "axios";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  KeyDeadError,
  RateLimitError,
  type DeviceTelemetryPayload,
  type DuoPlusEnvelope,
} from "../types.js";
import { noteDuoPlusCall } from "../ops/qps.js";
import { type PooledKey, withKey } from "./keyPool.js";
import { withTenantKey } from "./tenantKeys.js";
import { HttpError } from "../http/errors.js";
import { fingerprintKey } from "../security/crypto.js";
import { duoPlusRateLimiter } from "./rateLimit.js";
import { readDeviceWifi, type SubmittedWifi } from "./environmentWifi.js";
import { buildDriftPayload, buildWifiApplyPayload, validateImageId } from "./duoPlusPayloads.js";
import { sanitizeCloudPhoneUpdateResult } from "./gpsRejectionReason.js";

export async function validateDuoPlusKey(rawKey: string): Promise<void> {
  try {
    const response = await duoPlusRateLimiter.run(fingerprintKey(rawKey.trim()), () =>
      clientFor({ id: "validation", label: "validation", key: rawKey.trim() })
        .post<DuoPlusEnvelope<unknown>>("/api/v1/cloudPhone/list", { page: 1, pagesize: 1 }));
    if (response.data?.code !== 200) {
      throw new HttpError(400, "DuoPlus rejected this API key");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 429) throw new HttpError(429, "DuoPlus is rate limited. Try again shortly.");
      if ([401, 403].includes(error.response?.status ?? 0)) throw new HttpError(400, "DuoPlus rejected this API key");
    }
    throw new HttpError(502, "Could not validate the key with DuoPlus. Try again shortly.");
  }
}

function clientFor(key: PooledKey): AxiosInstance {
  return axios.create({
    baseURL: config.duoPlusBaseUrl,
    timeout: 20_000,
    headers: {
      "Content-Type": "application/json",
      Lang: config.lang,
      "DuoPlus-API-Key": key.key,
    },
  });
}

function parseRetryAfter(err: AxiosError): number {
  const header = err.response?.headers?.["retry-after"];
  if (header) {
    const sec = Number(header);
    if (Number.isFinite(sec)) return Math.max(1000, sec * 1000);
  }
  return 2000;
}

async function requestOnKey<T>(key: PooledKey, path: string, body: unknown, tenantId?: string, requireAcceptanceEnvelope = false): Promise<T> {
    if (config.dryRun) {
      logger.info({ path, body, key: key.label }, "DRY_RUN DuoPlus POST");
      return { dryRun: true } as T;
    }
    try {
      noteDuoPlusCall(path, tenantId);
      const res = await clientFor(key).post<DuoPlusEnvelope<T>>(path, body,
        path === "/api/v1/cloudPhone/command" ? { timeout: 10_000, maxContentLength: 1_048_576 } : undefined);
      const payload = res.data;
      if (payload && typeof payload.code === "number" && payload.code !== 200) {
        if (payload.code === 401) {
          throw new KeyDeadError(`DuoPlus authentication failed on ${path}`);
        }
        if (payload.code === 429) {
          throw new RateLimitError(`DuoPlus 429 on ${path}`, 2000);
        }
        throw new HttpError(502, `DuoPlus request failed (code ${payload.code})`);
      }
      if (requireAcceptanceEnvelope && (res.status !== 200 || payload?.code !== 200)) {
        throw new HttpError(502, "DuoPlus did not return a valid acceptance response. Review the device before retrying.");
      }
      const result = payload?.data ?? payload;
      if (path === "/api/v1/cloudPhone/update") {
        const images = (body as { images?: Array<{ image_id?: unknown }> } | null)?.images;
        const ids = Array.isArray(images) ? images.map((image) => image.image_id).filter((id): id is string => typeof id === "string") : [];
        return sanitizeCloudPhoneUpdateResult(result, ids, key.key) as T;
      }
      return result as T;
    } catch (err) {
      if (err instanceof RateLimitError || err instanceof KeyDeadError || err instanceof HttpError) throw err;
      const ax = err as AxiosError;
      if (path === "/api/v1/cloudPhone/command" && ["ECONNABORTED", "ETIMEDOUT"].includes(ax.code ?? "")) {
        throw new HttpError(504, "DuoPlus phone command timed out after 10 seconds.");
      }
      const status = ax.response?.status;
      if (status === 429) throw new RateLimitError("HTTP 429", parseRetryAfter(ax));
      if (status === 401 || status === 403) {
        throw new KeyDeadError(`HTTP ${status} auth failure`);
      }
      throw new HttpError(502, "DuoPlus request failed. Check the connection and try again.");
    }
}

async function post<T>(path: string, body: unknown, tenantId?: string, beforeSend?: (key: PooledKey) => Promise<void>, requireAcceptanceEnvelope = false): Promise<T> {
  const exec = async (key: PooledKey) => {
    await beforeSend?.(key);
    return requestOnKey<T>(key, path, body, tenantId, requireAcceptanceEnvelope);
  };
  if (tenantId) return withTenantKey(tenantId, exec);
  if (config.authRequired) throw new HttpError(401, "Workspace required for DuoPlus requests");
  return withKey(exec);
}

interface PhoneStatusData {
  list?: Array<{ id?: string; status?: unknown }>;
}

function powerStatus(data: PhoneStatusData, imageId: string): number | null {
  const matches = Array.isArray(data?.list) ? data.list.filter((phone) => phone?.id === imageId) : [];
  if (matches.length !== 1 || typeof matches[0]?.status !== "number" || !Number.isInteger(matches[0].status)) {
    throw new HttpError(502, "DuoPlus did not return an unambiguous power status for this device");
  }
  const status = matches[0].status;
  return [0, 1, 2, 3, 4, 10, 11, 12].includes(status) ? status : null;
}

export function powerStatusMessage(status: number | null): string {
  if (status === 1) return "DuoPlus reports ON (status 1).";
  const labels: Record<number, string> = {
    0: "not configured", 2: "powered off", 3: "expired", 4: "renewal needed",
    10: "transitioning", 11: "configuring", 12: "configuration failed",
  };
  const label = status === null ? undefined : labels[status];
  return label ? `DuoPlus reports ${label} (status ${status}), not confirmed ON. No environment update was sent.` :
    "DuoPlus power status is unconfirmed. No environment update was sent.";
}

function requireOn(status: number | null): void {
  if (status !== 1) {
    throw new HttpError(409, powerStatusMessage(status));
  }
}

export async function fetchDevicePowerObservation(imageId: string, tenantId: string): Promise<{ status: number | null; checkedAt: Date }> {
  if (config.dryRun) throw new HttpError(409, "Power checks are disabled in dry-run mode");
  let checkedAt: Date | undefined;
  const data = await post<PhoneStatusData>("/api/v1/cloudPhone/status", { image_ids: [imageId] }, tenantId,
    async () => { checkedAt = new Date(); }, true);
  if (!checkedAt) throw new HttpError(502, "DuoPlus power check was not dispatched");
  return { status: powerStatus(data, imageId), checkedAt };
}

export async function fetchDevicePowerStatus(imageId: string, tenantId: string): Promise<number | null> {
  return (await fetchDevicePowerObservation(imageId, tenantId)).status;
}

export async function assertDeviceOn(imageId: string, tenantId: string): Promise<void> {
  if (config.dryRun) throw new HttpError(409, "Environment changes are disabled in dry-run mode");
  requireOn(await fetchDevicePowerStatus(imageId, tenantId));
}

export interface EnvironmentPatch {
  wifi?: { ssid: string; bssid: string; expectedMac?: string | null };
}

export const CELL_UPDATE_UNAVAILABLE = "Cell injection is disabled: carrier ownership and radio-field mapping have not been verified.";

function rejectUnverifiedStation(station: unknown): void {
  if (station !== undefined) throw new HttpError(409, CELL_UPDATE_UNAVAILABLE);
}

function requireGpsOnly(payload: DeviceTelemetryPayload): void {
  rejectUnverifiedStation(payload.station);
  if (payload.bindEnvironment) {
    throw new HttpError(409, "Movement updates are GPS-only. Prepare and apply Wi-Fi through the environment workflow.");
  }
}

export async function applyDeviceEnvironment(
  imageId: string,
  patch: EnvironmentPatch,
  tenantId: string,
  beforeDispatch: (powerConfirmed?: boolean) => Promise<void>,
  beforeUpdate?: () => Promise<void>,
  onConfirmedOn?: (checkedAt: Date) => Promise<void>,
): Promise<SubmittedWifi> {
  if (config.dryRun) throw new HttpError(409, "Environment changes are disabled in dry-run mode");
  validateImageId(imageId);
  if ("station" in patch) rejectUnverifiedStation(patch.station);
  if (!patch.wifi) throw new HttpError(400, "No supported environment values to apply");
  const selectedWifi = patch.wifi;
  const body: ReturnType<typeof buildWifiApplyPayload> = { images: [] };
  const result = await post<{ success?: string[]; fail?: string[] }>(
    "/api/v1/cloudPhone/update", body, tenantId,
    async (key) => {
      // These checks run inside the key's reserved turn, after rate-limit waits.
      if (usesPlayer(imageId) && await prisma.device.count({ where: { imageId, activeTripId: { not: null } } })) throw new HttpError(409, "A player trip owns this phone. Cancel it before changing its environment.");
      await beforeDispatch(false);
      const info = await requestOnKey<unknown>(key, "/api/v1/cloudPhone/info", { image_id: imageId }, tenantId);
      body.images = buildWifiApplyPayload(imageId, readDeviceWifi(info, imageId), selectedWifi).images;
      const checkedAt = new Date();
      requireOn(powerStatus(await requestOnKey<PhoneStatusData>(key, "/api/v1/cloudPhone/status", { image_ids: [imageId] }, tenantId, true), imageId));
      await onConfirmedOn?.(checkedAt);
      await beforeDispatch(true);
      await beforeUpdate?.();
    },
    true,
  );
  if (!Array.isArray(result?.success) || !Array.isArray(result?.fail) ||
      result.fail.includes(imageId) || !result.success.includes(imageId)) {
    throw new HttpError(502, "DuoPlus did not confirm acceptance for this device. Review its settings before retrying.");
  }
  return body.images[0]!.wifi;
}

export async function modifyDeviceParams(payload: DeviceTelemetryPayload, tenantId?: string, beforeSend?: () => Promise<void>): Promise<unknown> {
  if (usesPlayer(payload.imageId)) throw new HttpError(409, "This phone uses DuoMove Player. Start a trip from Driving; REST GPS updates are disabled for this phone.");
  requireGpsOnly(payload);
  const body = buildDriftPayload(payload.imageId, payload.lat, payload.lng);
  return post("/api/v1/cloudPhone/update", body, tenantId, beforeSend, true);
}

export async function modifyDeviceBatch(
  payloads: DeviceTelemetryPayload[],
  tenantId?: string,
  beforeSend?: () => Promise<void>,
): Promise<unknown> {
  if (payloads.length === 0) return { skipped: true };
  if (payloads.length > 20) throw new HttpError(400, "DuoPlus updates support at most 20 devices per batch");
  const imageIds = new Set<string>();
  const images = payloads.map((payload) => {
    if (usesPlayer(payload.imageId)) throw new HttpError(409, "This phone uses DuoMove Player. Start a trip from Driving; REST GPS updates are disabled for this phone.");
  requireGpsOnly(payload);
    const image = buildDriftPayload(payload.imageId, payload.lat, payload.lng).images[0]!;
    if (imageIds.has(image.image_id)) throw new HttpError(400, "DuoPlus update batches must not contain duplicate image IDs");
    imageIds.add(image.image_id);
    return image;
  });
  return post("/api/v1/cloudPhone/update", { images }, tenantId, beforeSend, true);
}

export async function getDeviceStatus(imageId: string, tenantId?: string): Promise<unknown> {
  return post("/api/v1/cloudPhone/info", { image_id: imageId }, tenantId);
}

export async function launchDeviceMaps(
  imageId: string,
  destination: import("./providerGps.js").GpsPoint,
  tenantId: string,
  beforeSend?: () => Promise<void>,
): Promise<import("./phoneNavigation.js").MapsLaunchObservation> {
  if (config.dryRun) throw new HttpError(409, "Phone navigation is disabled in dry-run mode");
  validateImageId(imageId);
  if (!tenantId?.trim()) throw new HttpError(401, "Workspace required for phone navigation");
  const { buildMapsNavigationCommand, readPhoneCommandContent, readMapsLaunch } = await import("./phoneNavigation.js");
  const command = buildMapsNavigationCommand(destination);
  const result = await post<unknown>("/api/v1/cloudPhone/command", { image_id: imageId, command }, tenantId, beforeSend, true);
  return readMapsLaunch(readPhoneCommandContent(result));
}

export async function observeDeviceLocation(
  imageId: string,
  tenantId: string,
  beforeSend?: () => Promise<void>,
): Promise<import("./phoneNavigation.js").PhoneLocationObservation> {
  if (config.dryRun) throw new HttpError(409, "Phone location checks are disabled in dry-run mode");
  validateImageId(imageId);
  if (!tenantId?.trim()) throw new HttpError(401, "Workspace required for phone location checks");
  const { PHONE_LOCATION_COMMAND, readPhoneCommandContent, readPhoneLocation } = await import("./phoneNavigation.js");
  let startedAt = 0;
  const result = await post<unknown>("/api/v1/cloudPhone/command", { image_id: imageId, command: PHONE_LOCATION_COMMAND }, tenantId,
    async () => {
      await beforeSend?.();
      startedAt = Date.now();
    }, true);
  return readPhoneLocation(readPhoneCommandContent(result), new Date(), Date.now() - startedAt);
}

export async function listCloudPhones(page = 1, pagesize = 50, tenantId?: string): Promise<unknown> {
  return post("/api/v1/cloudPhone/list", { page, pagesize }, tenantId);
}

export async function triggerRpaTask(
  imageId: string,
  templateId: string,
  variables: Record<string, unknown>,
  opts?: { name?: string; templateType?: 1 | 2; issueAt?: string; remark?: string; tenantId?: string; beforeSend?: () => Promise<void>; requireAcceptance?: boolean },
): Promise<unknown> {
  const issueAt =
    opts?.issueAt ??
    new Date(Date.now() + 15_000)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");

  const configMap: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variables)) {
    const type =
      typeof value === "boolean"
        ? "boolean"
        : typeof value === "number"
          ? "number"
          : Array.isArray(value)
            ? "textarea"
            : "string";
    configMap[key] = {
      key,
      value: Array.isArray(value) ? value.join("\n") : String(value),
      type,
      required: false,
    };
  }

  return post("/api/v1/automation/addTask", {
    template_id: templateId,
    template_type: opts?.templateType ?? 2,
    name: opts?.name ?? `observatory-${imageId}-${Date.now()}`,
    remark: opts?.remark ?? "observatory-controller",
    images: [
      {
        image_id: imageId,
        config: configMap,
        issue_at: issueAt,
      },
    ],
  }, opts?.tenantId, opts?.beforeSend, opts?.requireAcceptance ?? false);
}
