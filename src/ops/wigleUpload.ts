import { createHash } from "node:crypto";
import type { DeviceWigleUpload, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { HttpError } from "../http/errors.js";

export const MAX_WIGLE_UPLOAD_BYTES = 1024 * 1024;
export const MAX_WIGLE_UPLOAD_RESULTS = 1000;
export const MAX_DEVICE_WIGLE_UPLOADS = 50;

export type WigleUploadRecord = {
  kind: "WIFI" | "CELL" | "BLUETOOTH";
  identifier: string;
  ssid: string | null;
  lat: number;
  lng: number;
  qos: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  lastUpdated: string | null;
  radio: string | null;
  attributes: string | null;
  channel: number | null;
  encryption: string | null;
  wifiType?: string;
  frequencyMHz?: number | null;
  comment?: string;
  bluetooth?: {
    name: string | null;
    manufacturerId: number | null;
    deviceClass: number | null;
    capabilities: string[] | null;
  };
};

export type WigleUploadData = {
  version: 1;
  records: WigleUploadRecord[];
  rejectedCount: number;
  duplicateCount: number;
  warnings: string[];
  page: {
    totalResults: number | null;
    resultCount: number | null;
    first: number | null;
    last: number | null;
    hasCursor: boolean;
  };
  queriedAt: null;
};

export type WigleQueryCache = {
  siteId?: string;
  queriedAt: string;
  endpoint: "network/search" | "cell/search";
  anchor: { lat: number; lng: number };
  radiusM?: number;
  rawResponses: unknown[];
};

const timestamp = z.string().datetime({ offset: true });
const queryMetadataSchema = z.object({
  siteId: z.string().trim().min(1).max(200).optional(),
  queriedAt: timestamp.refine((value) => Date.parse(value) <= Date.now()),
  endpoint: z.enum(["network/search", "cell/search"]),
  anchor: z.object({ lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) }),
  radiusM: z.number().finite().positive().optional(),
});
const cellRadios = new Set(["GSM", "LTE", "WCDMA", "NR", "CDMA", "5GNR"]);
const wifiTypes = new Set(["WIFI", "INFRA"]);
const bluetoothRadios = new Set(["BT", "BLE"]);
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizedBssid(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value)) return null;
  const firstOctet = Number.parseInt(value.slice(0, 2), 16);
  if ((firstOctet & 1) !== 0 || value === "00:00:00:00:00:00") return null;
  return value.toLowerCase();
}

function normalizedBluetoothAddress(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value)) return null;
  const address = value.toLowerCase();
  return address === "00:00:00:00:00:00" || address === "ff:ff:ff:ff:ff:ff" ? null : address;
}

export function parseWigleUpload(input: unknown, options?: { allowEmptyQueryResult?: boolean }): WigleUploadData {
  let serialized: string | undefined;
  try { serialized = typeof input === "string" ? input : JSON.stringify(input); }
  catch { throw new HttpError(400, "Upload must contain a WiGLE JSON search response"); }
  if (!serialized) throw new HttpError(400, "Upload must contain a WiGLE JSON search response");
  if (Buffer.byteLength(serialized, "utf8") > MAX_WIGLE_UPLOAD_BYTES) {
    throw new HttpError(413, "WiGLE JSON files must be 1 MiB or smaller");
  }
  let response: unknown;
  try { response = JSON.parse(serialized); }
  catch { throw new HttpError(400, "The uploaded file is not valid JSON"); }
  if (!isObject(response) || response.success !== true || !Array.isArray(response.results)) {
    throw new HttpError(400, "Upload a successful WiGLE search response with a results array");
  }
  if (response.results.length > MAX_WIGLE_UPLOAD_RESULTS) {
    throw new HttpError(400, "A WiGLE upload may contain at most 1,000 result rows");
  }

  const issues = new Map<string, number>();
  const issue = (message: string) => issues.set(message, (issues.get(message) ?? 0) + 1);
  const optionalText = (value: unknown, field: string, maxBytes: number): string | null => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string" || controlCharacters.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
      issue(`Invalid ${field} omitted`);
      return null;
    }
    return value;
  };
  const optionalInteger = (value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number | null => {
    if (value === null || value === undefined) return null;
    if (!finiteNumber(value, 0, max) || !Number.isSafeInteger(value)) {
      issue(`Invalid ${field} omitted`);
      return null;
    }
    return value;
  };
  const now = Date.now();
  const optionalTimestamp = (value: unknown, field: string): string | null => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = timestamp.safeParse(value);
    if (!parsed.success || !Number.isFinite(Date.parse(parsed.data)) || Date.parse(parsed.data) > now) {
      issue(`Invalid or future ${field} omitted`);
      return null;
    }
    return new Date(parsed.data).toISOString();
  };

  const records: WigleUploadRecord[] = [];
  const seen = new Set<string>();
  let rejectedCount = 0;
  let duplicateCount = 0;
  for (const value of response.results) {
    if (!isObject(value) || !finiteNumber(value.trilat, -90, 90) || !finiteNumber(value.trilong, -180, 180)) {
      rejectedCount++;
      continue;
    }
    const declaredType = typeof value.type === "string" ? value.type.toUpperCase() : null;
    const genericType = typeof value.gentype === "string" ? value.gentype.toUpperCase() : null;
    let kind: WigleUploadRecord["kind"];
    let identifier: string | null;
    let radio: string | null;
    if (value.netid !== undefined && value.netid !== null) {
      const bluetoothRadio = [declaredType, genericType].find((type) => type !== null && bluetoothRadios.has(type));
      if (bluetoothRadio) {
        kind = "BLUETOOTH";
        radio = bluetoothRadio;
        identifier = normalizedBluetoothAddress(value.netid);
        if ([declaredType, genericType].some((type) => type !== null && type !== bluetoothRadio)) identifier = null;
      } else {
        kind = "WIFI";
        identifier = normalizedBssid(value.netid);
        radio = null;
        if ([declaredType, genericType].some((type) => type !== null && !wifiTypes.has(type))) identifier = null;
      }
    } else {
      kind = "CELL";
      radio = genericType ?? declaredType;
      // Keep provider identifiers opaque; their components are not a verified station mapping.
      identifier = typeof value.id === "string" && /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(value.id)
        && radio !== null && cellRadios.has(radio) ? value.id : null;
    }
    if (!identifier) {
      rejectedCount++;
      continue;
    }
    const record: WigleUploadRecord = {
      kind, identifier,
      ssid: optionalText(value.ssid, "SSID or network name", kind === "WIFI" ? 32 : 256),
      lat: value.trilat,
      lng: value.trilong,
      qos: optionalInteger(value.qos, "QoS", 7),
      firstSeen: optionalTimestamp(value.firsttime, "first observation date"),
      lastSeen: optionalTimestamp(value.lasttime, "last observation date"),
      lastUpdated: optionalTimestamp(value.lastupdt, "last update date"),
      radio,
      attributes: optionalText(value.attributes, "attributes", 1024),
      channel: optionalInteger(value.channel, "channel"),
      encryption: optionalText(value.encryption, "encryption", 256),
    };
    if (kind === "WIFI") {
      if (typeof value.type === "string") record.wifiType = value.type;
      if (value.frequency !== undefined) record.frequencyMHz = optionalInteger(value.frequency, "frequency", 100_000);
      const comment = optionalText(value.comment, "Wi-Fi comment", 1024);
      if (comment !== null) record.comment = comment;
    }
    if (kind === "BLUETOOTH") {
      let capabilities: string[] | null = null;
      if (value.capabilities !== null && value.capabilities !== undefined) {
        if (!Array.isArray(value.capabilities) || value.capabilities.length > 64) issue("Invalid Bluetooth capabilities omitted");
        else capabilities = value.capabilities.flatMap((entry) => {
          const capability = optionalText(entry, "Bluetooth capability", 256);
          return capability === null ? [] : [capability];
        });
      }
      record.bluetooth = {
        name: optionalText(value.name, "Bluetooth name", 256),
        manufacturerId: optionalInteger(value.mfgrId, "Bluetooth manufacturer ID", 65_535),
        deviceClass: optionalInteger(value.device, "Bluetooth device class", 0xffffff),
        capabilities,
      };
    }
    const key = JSON.stringify(record);
    if (seen.has(key)) duplicateCount++;
    else {
      seen.add(key);
      records.push(record);
    }
  }
  if (!records.length && !options?.allowEmptyQueryResult) throw new HttpError(400, "No valid Wi-Fi, Bluetooth, or cell observations were found in this file");

  const page = {
    totalResults: optionalInteger(response.totalResults, "total result count"),
    resultCount: optionalInteger(response.resultCount, "page result count"),
    first: optionalInteger(response.first, "first result index"),
    last: optionalInteger(response.last, "last result index"),
    hasCursor: typeof response.searchAfter === "string" && response.searchAfter.length > 0,
  };
  const warnings = [...issues.entries()].sort(([a], [b]) => compareText(a, b))
    .map(([message, count]) => `${message} (${count})`);
  if (rejectedCount) warnings.push(`${rejectedCount} invalid result row(s) skipped`);
  if (duplicateCount) warnings.push(`${duplicateCount} identical observation(s) skipped`);
  if (page.resultCount !== null && page.resultCount !== response.results.length) {
    warnings.push("Reported page count differs from the number of uploaded rows");
  }
  if (page.hasCursor || (page.totalResults !== null && page.totalResults > response.results.length)) {
    warnings.push("The response may be one page of a larger search; only uploaded rows were saved");
  }
  warnings.push("Query time is unknown; import time is not the original WiGLE search time");
  if (records.some((record) => record.kind === "CELL")) {
    warnings.push("Cell observations are reference data only; station injection is disabled");
  }
  if (records.some((record) => record.kind === "BLUETOOTH")) {
    warnings.push("Bluetooth observations are reference data only; nearby device identities are not applied to this phone");
  }
  return { version: 1, records, rejectedCount, duplicateCount, warnings, page, queriedAt: null };
}

export function uploadSummary(row: Pick<DeviceWigleUpload,
  "id" | "filename" | "importedAt" | "wifiCount" | "cellCount" | "rejectedCount" | "duplicateCount">
  & { bluetoothCount?: number; payloadJson?: string }) {
  let query: z.infer<typeof queryMetadataSchema> | null = null;
  if (row.payloadJson && row.payloadJson.length <= 2_000_000) {
    try {
      const parsed = queryMetadataSchema.safeParse(JSON.parse(row.payloadJson)?.query);
      if (parsed.success) query = parsed.data;
    } catch { /* A damaged saved payload has no verified query metadata. */ }
  }
  return {
    id: row.id, filename: row.filename, importedAt: row.importedAt.toISOString(),
    wifiCount: row.wifiCount, cellCount: row.cellCount, bluetoothCount: row.bluetoothCount ?? 0,
    rejectedCount: row.rejectedCount, duplicateCount: row.duplicateCount,
    source: row.payloadJson === undefined ? null : query ? "WIGLE_QUERY" as const : "UPLOAD" as const,
    queriedAt: query?.queriedAt ?? null,
  };
}

function safeFilename(input: string): string {
  const basename = input.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const cleaned = basename.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? Array.from(cleaned).slice(0, 120).join("") : "wigle-upload.json";
}

export async function saveWigleUpload(prisma: PrismaClient | Prisma.TransactionClient, deviceId: string, tenantId: string, filename: string, input: unknown,
  queryCache?: WigleQueryCache) {
  const query = queryCache ? queryMetadataSchema.extend({
    rawResponses: z.array(z.object({ success: z.literal(true), results: z.array(z.unknown()).max(MAX_WIGLE_UPLOAD_RESULTS) }).passthrough()).min(1).max(3),
  }).parse(queryCache) : null;
  const parsed = parseWigleUpload(input, { allowEmptyQueryResult: query !== null });
  // Canonical record ordering makes whitespace, object-key order, and result order immaterial.
  parsed.records.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  const payloadJson = JSON.stringify(query ? { ...parsed, queriedAt: query.queriedAt,
    warnings: parsed.warnings.filter((warning) => warning !== "Query time is unknown; import time is not the original WiGLE search time"),
    query: { siteId: query.siteId, queriedAt: query.queriedAt, endpoint: query.endpoint, anchor: query.anchor, radiusM: query.radiusM },
    rawResponses: query.rawResponses } : parsed);
  if (query && Buffer.byteLength(payloadJson, "utf8") > 2_000_000) {
    throw new HttpError(413, "The complete WiGLE query cache exceeds the saved-data size limit");
  }
  const sha256 = createHash("sha256").update(payloadJson).digest("hex");
  const persist = async (tx: Prisma.TransactionClient) => {
    const device = await tx.device.findFirst({ where: { id: deviceId, tenantId }, select: { id: true } });
    if (!device) throw new HttpError(404, "Device not found");
    const existing = await tx.deviceWigleUpload.findUnique({ where: { deviceId_sha256: { deviceId, sha256 } } });
    if (existing) return { upload: uploadSummary(existing), duplicate: true };
    if (await tx.deviceWigleUpload.count({ where: { deviceId } }) >= MAX_DEVICE_WIGLE_UPLOADS) {
      throw new HttpError(409, "This device has reached its limit of 50 saved WiGLE uploads");
    }
    const wifiCount = parsed.records.filter((record) => record.kind === "WIFI").length;
    const cellCount = parsed.records.filter((record) => record.kind === "CELL").length;
    const bluetoothCount = parsed.records.filter((record) => record.kind === "BLUETOOTH").length;
    const saved = await tx.deviceWigleUpload.create({ data: {
      deviceId, sha256, filename: safeFilename(filename), payloadJson,
      wifiCount, cellCount, bluetoothCount,
      rejectedCount: parsed.rejectedCount, duplicateCount: parsed.duplicateCount,
    } });
    return { upload: uploadSummary(saved), duplicate: false };
  };
  return "$transaction" in prisma ? prisma.$transaction(persist) : persist(prisma);
}
