import type { Device, DeviceWigleUpload, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { haversineMeters } from "../geo/haversine.js";
import { HttpError } from "../http/errors.js";
import { uploadSummary } from "../ops/wigleUpload.js";
import { parseObservedWifi, rankObservedWifi } from "./environmentData.js";

type SavedDevice = Pick<Device, "id" | "tenantId" | "anchorLat" | "anchorLng">;
export type SavedSelection = { uploadId: string; recordIndex: number };
const MAX_SOURCES = 10;
const MAX_RECORDS = 5000;
const text = z.string().max(1024).nullable();
const observation = z.object({
  kind: z.enum(["WIFI", "CELL", "BLUETOOTH"]), identifier: z.string().min(1).max(128), ssid: text,
  lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180),
  qos: z.number().int().min(0).max(7).nullable(),
  firstSeen: text, lastSeen: text, lastUpdated: text, radio: text, attributes: text,
  channel: z.number().int().nonnegative().nullable(), encryption: text,
  wifiType: z.string().max(32).optional(), frequencyMHz: z.number().finite().nonnegative().nullable().optional(),
  comment: z.string().max(1024).optional(),
  bluetooth: z.object({ name: text, manufacturerId: z.number().int().nonnegative().nullable(),
    deviceClass: z.number().int().nonnegative().nullable(), capabilities: z.array(z.string().max(256)).max(100).nullable() }).optional(),
});
type Observation = z.infer<typeof observation>;

function sourceRecords(upload: DeviceWigleUpload): unknown[] {
  try {
    if (upload.payloadJson.length > 2_000_000) return [];
    const data = JSON.parse(upload.payloadJson);
    return data?.version === 1 && Array.isArray(data.records) && data.records.length <= 1000 ? data.records : [];
  } catch { return []; }
}

function eligibility(record: Observation, device: SavedDevice) {
  const anchor = { lat: device.anchorLat, lng: device.anchorLng };
  const distanceM = haversineMeters(anchor.lat, anchor.lng, record.lat, record.lng);
  if (record.kind !== "WIFI") return { distanceM, wifi: null, reason: record.kind === "BLUETOOTH"
    ? "Nearby Bluetooth observation; not the phone's Bluetooth identity."
    : "Cell identifier mapping and SIM compatibility are unverified." };
  const wifi = parseObservedWifi({ netid: record.identifier, ssid: record.ssid,
    trilat: record.lat, trilong: record.lng, qos: record.qos,
    lasttime: record.lastSeen, lastupdt: record.lastUpdated, comment: record.comment,
    type: record.wifiType ?? "WIFI" }, anchor, config.wigleRadiusM);
  return { distanceM, wifi, reason: wifi ? null : distanceM > config.wigleRadiusM
    ? `Outside the ${config.wigleRadiusM} m Wi-Fi selection radius.`
    : "SSID, BSSID, observation quality, or fixed-network eligibility could not be validated." };
}

export async function loadSavedEnvironment(prisma: PrismaClient, device: SavedDevice, selection: SavedSelection) {
  const upload = await prisma.deviceWigleUpload.findFirst({ where: {
    id: selection.uploadId, deviceId: device.id, device: { tenantId: device.tenantId },
  } });
  if (!upload) throw new HttpError(404, "Saved WiGLE upload not found for this device");
  if (!Number.isSafeInteger(selection.recordIndex) || selection.recordIndex < 0) throw new HttpError(400, "Choose a saved observation first");
  const record = observation.safeParse(sourceRecords(upload)[selection.recordIndex]);
  if (!record.success) throw new HttpError(409, "This saved observation is unavailable or invalid");
  const candidate = eligibility(record.data, device);
  if (!candidate.wifi) throw new HttpError(409, candidate.reason!);
  const summary = uploadSummary(upload);
  const warnings = [summary.source === "WIGLE_QUERY"
    ? "Prepared from a saved WiGLE query, not a new search or live scan."
    : "Prepared from an uploaded historical observation, not a new WiGLE search or live scan.",
    summary.queriedAt ? "Preparing this profile preserves the original query and observation dates."
      : "Original query time is unknown. Preparing this profile does not refresh its observation dates.",
    "Bluetooth and cell observations remain reference data; their device settings will not be changed."];
  if (!candidate.wifi.lastSeen) warnings.push("Last-seen time is unavailable; observation recency is unknown.");
  else if (Date.now() - Date.parse(candidate.wifi.lastSeen) > 18 * 365.25 / 12 * 86400000) {
    warnings.push("This Wi-Fi observation is more than 18 months old and may no longer be present.");
  }
  return { wifi: candidate.wifi, cell: null, warnings, source: {
    type: "UPLOAD" as const, uploadId: upload.id, recordIndex: selection.recordIndex,
    filename: upload.filename, importedAt: upload.importedAt.toISOString(), queriedAt: summary.queriedAt,
  } };
}

export async function savedEnvironmentExplorer(prisma: PrismaClient, device: SavedDevice) {
  const owned = await prisma.device.findFirst({ where: { id: device.id, tenantId: device.tenantId }, select: { id: true } });
  if (!owned) throw new HttpError(404, "Device not found");
  const uploads = await prisma.deviceWigleUpload.findMany({ where: { deviceId: device.id, device: { tenantId: device.tenantId } },
    orderBy: [{ importedAt: "desc" }, { id: "asc" }], take: MAX_SOURCES });
  const totals = await prisma.deviceWigleUpload.aggregate({ where: { deviceId: device.id, device: { tenantId: device.tenantId } },
    _count: true, _sum: { wifiCount: true, cellCount: true, bluetoothCount: true } });
  const records: Array<Observation & { uploadId: string; recordIndex: number; filename: string; importedAt: string;
    distanceM: number; eligible: boolean; ineligibleReason: string | null; recommended: boolean }> = [];
  const candidates: Array<{ record: typeof records[number]; wifi: NonNullable<ReturnType<typeof eligibility>["wifi"]> }> = [];
  let omitted = 0;
  let limited = false;
  for (const upload of uploads) {
    const storedRecords = sourceRecords(upload);
    if (!storedRecords.length) omitted += upload.wifiCount + upload.cellCount + upload.bluetoothCount;
    for (const [recordIndex, value] of storedRecords.entries()) {
      const parsed = observation.safeParse(value);
      if (!parsed.success) { omitted++; continue; }
      if (records.length >= MAX_RECORDS) { limited = true; break; }
      const eligible = eligibility(parsed.data, device);
      const record = { ...parsed.data, uploadId: upload.id, recordIndex, filename: upload.filename,
        importedAt: upload.importedAt.toISOString(), distanceM: eligible.distanceM,
        eligible: Boolean(eligible.wifi), ineligibleReason: eligible.reason, recommended: false };
      records.push(record);
      if (eligible.wifi) candidates.push({ record, wifi: eligible.wifi });
    }
  }
  const best = rankObservedWifi(candidates.map((item) => item.wifi), config.wigleRadiusM)[0];
  const recommended = candidates.find((item) => item.wifi === best);
  if (recommended) recommended.record.recommended = true;
  records.sort((a, b) => a.distanceM - b.distanceM || a.uploadId.localeCompare(b.uploadId) || a.recordIndex - b.recordIndex);
  const totalRecords = (totals._sum.wifiCount ?? 0) + (totals._sum.cellCount ?? 0) + (totals._sum.bluetoothCount ?? 0);
  const truncated = limited || totals._count > MAX_SOURCES || omitted > 0;
  const warnings = ["Historical WiGLE observations, not a live scan or confirmed radio coverage.",
    "Source response totals may describe a broader query or catalogue; they are not counts near this device."];
  if (totals._count > MAX_SOURCES || limited) warnings.push(`Explorer is limited to the latest ${MAX_SOURCES} files and ${MAX_RECORDS} observations. Older files remain in Saved WiGLE data.`);
  if (omitted) warnings.push(`${omitted} invalid stored observation(s) were omitted.`);
  if (records.length && !recommended) warnings.push(`No eligible Wi-Fi observation is within ${config.wigleRadiusM} m of the saved anchor. The anchor was not moved.`);
  return { anchor: { lat: device.anchorLat, lng: device.anchorLng }, radiusM: config.wigleRadiusM,
    records, sources: uploads.map(uploadSummary), warnings, totalRecords, truncated };
}
