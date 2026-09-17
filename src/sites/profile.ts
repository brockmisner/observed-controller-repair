import type { DeviceWigleUpload } from "@prisma/client";
import { normalizedMac, readDeviceWifi } from "../api/environmentWifi.js";
import { prisma } from "../db.js";
import { parseObservedWifi, rankObservedWifi, type ObservedWifi } from "../env/environmentData.js";
import { wigleGet } from "../env/wigle.js";
import { haversineMeters, toDeg, toRad } from "../geo/haversine.js";
import { HttpError } from "../http/errors.js";
import { MAX_DEVICE_WIGLE_UPLOADS, saveWigleUpload, type WigleQueryCache } from "../ops/wigleUpload.js";

export type SiteProfileTarget = {
  id: string;
  tenantId: string;
  deviceId: string;
  lat: number;
  lng: number;
  street?: string | null;
  zip?: string | null;
};

export type SiteProfile = {
  anchor: { lat: number; lng: number };
  wifi: { ssid: string; bssid: string; lat: number; lng: number; distanceM: number; lastSeen: string | null; qos: number } | null;
  cell: { mcc: string; mnc: string; lac: number; cid: number; radio: string; distanceM: number } | null;
  phoneWifiMac: string | null;
  sim: { mcc: string | null; mnc: string | null; operator: string | null };
  warnings: string[];
  source: {
    type: "SAVED_LIBRARY";
    siteId: string;
    wifiRadiusM: number;
    cellRadiusM: number;
    wifi: { sourceId: string; kind: string; freshnessField: "lasttime" | "lastupdt" } | null;
    cell: { sourceId: string; kind: string } | null;
    cellWritable: false;
    bluetooth: { name: string | null; address: string | null } | null;
    baselineVerified: boolean;
    addressVerified: false;
    checkedEndpoints: Partial<Record<WigleQueryCache["endpoint"], string>>;
    truncated: boolean;
  };
  records: { wifi: number; cell: number; bluetooth: number };
  checkedAt: string | null;
};

export type SiteLibraryRefresh = {
  checkedAt: string | null;
  cached: boolean;
  summary: { wifi: number; cell: number; bluetooth: number; queries: number; uploads: string[] };
  warnings: string[];
};

export const SITE_WIFI_RADIUS_M = 80;
export const SITE_LIBRARY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CELL_RADIUS_M = 2500;
const MAX_ARCHIVES = 50;
const MAX_RECORDS = 50_000;
const MAX_PAGES = 3;
const PAGE_SIZE = 100;
const MAX_QUERY_BYTES = 512 * 1024;
const ENDPOINTS = ["network/search", "cell/search"] as const;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function jsonObject(value: string | null, limit = 2_000_000): Record<string, unknown> | null {
  if (!value || value.length > limit) return null;
  try { return object(JSON.parse(value)); } catch { return null; }
}

function assertSite(site: SiteProfileTarget) {
  if (![site.id, site.tenantId, site.deviceId].every((value) => typeof value === "string" && value.trim())) {
    throw new HttpError(400, "A saved client, workspace, and device are required");
  }
  if (!Number.isFinite(site.lat) || !Number.isFinite(site.lng) || Math.abs(site.lat) > 90 || Math.abs(site.lng) > 180) {
    throw new HttpError(400, "The client needs valid coordinates before preparing its profile");
  }
}

function validTime(value: unknown, now = Date.now()): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now ? new Date(time).toISOString() : null;
}

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= max ? number : null;
}

function code(value: unknown, pattern: RegExp): string | null {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
  return pattern.test(text) ? text : null;
}

function text(value: unknown, max = 256): string | null {
  return typeof value === "string" && value.trim() && !CONTROL_CHARACTERS.test(value) && value.length <= max ? value : null;
}

function publicOrMobileHint(row: Record<string, unknown>) {
  const ssid = typeof row.ssid === "string" ? row.ssid.trim() : "";
  return /^(?:hidden(?: ssid)?|<hidden(?: ssid)?>|\[hidden\]|\(hidden\))$/i.test(ssid) ||
    /^(?:xfinity(?:wifi| mobile)?|attwifi|cablewifi|optimumwifi|spectrumwifi(?: plus)?|eduroam|google starbucks|starbucks(?: wifi)?|mcdonalds(?: free)? wifi)$/i.test(ssid) ||
    /(?:^|[\s_-])(?:guest|public|hotspot|free[\s_-]?wi-?fi|mobile|mifi|jetpack|tether)(?:$|[\s_-])/i.test(ssid);
}

function queryMetadata(payload: Record<string, unknown> | null, site: SiteProfileTarget) {
  const query = object(payload?.query);
  const anchor = object(query?.anchor);
  if (!query || query.siteId !== site.id || anchor?.lat !== site.lat || anchor?.lng !== site.lng ||
      !ENDPOINTS.includes(query.endpoint as typeof ENDPOINTS[number])) return null;
  const queriedAt = validTime(query.queriedAt);
  return queriedAt ? { endpoint: query.endpoint as typeof ENDPOINTS[number], queriedAt } : null;
}

function checkedEndpoints(uploads: DeviceWigleUpload[], site: SiteProfileTarget) {
  const checks: SiteProfile["source"]["checkedEndpoints"] = {};
  for (const upload of uploads) {
    const query = queryMetadata(jsonObject(upload.payloadJson), site);
    if (query && (!checks[query.endpoint] || query.queriedAt > checks[query.endpoint]!)) checks[query.endpoint] = query.queriedAt;
  }
  return checks;
}

function completedCheck(checks: SiteProfile["source"]["checkedEndpoints"]) {
  return checks["network/search"] && checks["cell/search"]
    ? [checks["network/search"], checks["cell/search"]].sort()[0]!
    : null;
}

function normalizedObservation(row: Record<string, unknown>) {
  return { netid: row.identifier, ssid: row.ssid, trilat: row.lat, trilong: row.lng,
    qos: row.qos, lasttime: row.lastSeen, lastupdt: row.lastUpdated, comment: row.comment,
    type: row.wifiType ?? "WIFI" };
}

function cellCandidate(value: unknown, site: SiteProfileTarget, sim: SiteProfile["sim"]): SiteProfile["cell"] {
  const row = object(value);
  if (!row || !sim.mcc || !sim.mnc) return null;
  const radioValue = typeof row.gentype === "string" ? row.gentype : typeof row.radio === "string" ? row.radio : row.type;
  const radio = typeof radioValue === "string" ? radioValue.toUpperCase() : "";
  if (!["LTE", "NR", "5GNR", "GSM", "WCDMA"].includes(radio)) return null;
  // Only explicit components are reference candidates. Opaque provider IDs are never decoded.
  const operator = code(row.operator ?? row.cell_op, /^\d{5,6}$/);
  const explicitMcc = code(row.mcc ?? (operator ? operator.slice(0, 3) : row.cell_op), /^\d{3}$/);
  const explicitMnc = code(row.mnc ?? operator?.slice(3), /^\d{2,3}$/);
  if (!explicitMcc || !explicitMnc || explicitMcc !== sim.mcc || explicitMnc !== sim.mnc) return null;
  if (operator && (operator.slice(0, 3) !== explicitMcc || operator.slice(3) !== explicitMnc)) return null;
  const nr = radio === "NR" || radio === "5GNR";
  const lac = integer(row.lac ?? row.tac, nr ? 0xffffff : 0xffff);
  const cid = integer(row.cid ?? row.cellid, nr ? 2 ** 36 - 1 : radio === "GSM" ? 0xffff : 2 ** 28 - 1);
  if (row.lac !== undefined && row.tac !== undefined && integer(row.lac) !== integer(row.tac)) return null;
  if (row.cid !== undefined && row.cellid !== undefined && integer(row.cid) !== integer(row.cellid)) return null;
  if (lac === null || cid === null || typeof row.trilat !== "number" || typeof row.trilong !== "number" ||
      !Number.isFinite(row.trilat) || !Number.isFinite(row.trilong) || Math.abs(row.trilat) > 90 || Math.abs(row.trilong) > 180) return null;
  const distanceM = haversineMeters(site.lat, site.lng, row.trilat, row.trilong);
  return distanceM <= CELL_RADIUS_M ? { mcc: explicitMcc, mnc: explicitMnc, lac, cid, radio: nr ? "NR" : radio, distanceM } : null;
}

export async function prepareSiteProfile(site: SiteProfileTarget, baseline: unknown): Promise<SiteProfile> {
  assertSite(site);
  const device = await prisma.device.findFirst({ where: { id: site.deviceId, tenantId: site.tenantId },
    select: { id: true, imageId: true, wifiClusterJson: true } });
  if (!device) throw new HttpError(404, "Device not found");
  const [uploads, archives] = await Promise.all([
    prisma.deviceWigleUpload.findMany({ where: { deviceId: site.deviceId, device: { tenantId: site.tenantId } },
      orderBy: [{ importedAt: "desc" }, { id: "asc" }], take: MAX_DEVICE_WIGLE_UPLOADS }),
    prisma.deviceWigleArchive.findMany({ where: { deviceId: site.deviceId, device: { tenantId: site.tenantId } },
      orderBy: [{ queriedAt: "desc" }, { id: "asc" }], take: MAX_ARCHIVES + 1 }),
  ]);
  const warnings = ["Historical WiGLE observations are not a live scan or confirmed coverage.",
    "Distance, QoS, freshness, and SSID filters are selection heuristics; they do not measure RSSI or prove that a network is private.",
    "Cell settings are unavailable until the provider field mapping and write capability are verified; matching cells are reference data only.",
    "Nearby Bluetooth observations never become this phone's Bluetooth identity."];
  if (!site.street?.trim() || !site.zip?.trim()) warnings.push("Street or ZIP metadata is missing. The address is unverified; the saved coordinates were used without geocoding.");
  else warnings.push("Street and ZIP are saved labels; their correspondence with the coordinates is unverified.");
  const info = object(baseline);
  const baselineVerified = info?.id === device.imageId;
  const actualSim = baselineVerified ? object(info?.sim) : null;
  const sim = { mcc: code(actualSim?.mcc, /^\d{3}$/), mnc: code(actualSim?.mnc, /^\d{2,3}$/), operator: text(actualSim?.operator) };
  const phoneWifiMac = baselineVerified ? readDeviceWifi(info, device.imageId).mac : null;
  const actualBluetooth = baselineVerified ? object(info?.bluetooth) : null;
  const bluetooth = actualBluetooth ? { name: text(actualBluetooth.name), address: normalizedMac(actualBluetooth.address) } : null;
  if (!baselineVerified) warnings.push("A verified /info baseline for this device is unavailable. Phone identities and SIM details were not inferred.");
  if (!phoneWifiMac) warnings.push("The phone's existing Wi-Fi MAC is unavailable; applying Wi-Fi requires a fresh valid baseline.");
  if (!sim.mcc || !sim.mnc) warnings.push("The actual SIM MCC/MNC is unavailable; no carrier or cell was inferred.");
  const checks = checkedEndpoints(uploads, site);
  const sources = new Map<ObservedWifi, { sourceId: string; kind: string; freshnessField: "lasttime" | "lastupdt" }>();
  const wifiCandidates: ObservedWifi[] = [];
  const cells: Array<{ cell: NonNullable<SiteProfile["cell"]>; sourceId: string; kind: string }> = [];
  const identities = { wifi: new Set<string>(), cell: new Set<string>(), bluetooth: new Set<string>() };
  const now = Date.now();
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);
  let scanned = 0;
  let invalidSources = 0;
  let truncated = archives.length > MAX_ARCHIVES;
  const consume = (value: unknown, kind: string, sourceId: string, sourceKind: string) => {
    if (scanned >= MAX_RECORDS) { truncated = true; return; }
    scanned++;
    const row = object(value);
    if (!row) return;
    const lat = row.trilat;
    const lng = row.trilong;
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    const distance = haversineMeters(site.lat, site.lng, lat, lng);
    if (distance > (kind === "CELL" ? CELL_RADIUS_M : SITE_WIFI_RADIUS_M)) return;
    if (kind === "WIFI") {
      const identifier = normalizedMac(row.netid);
      if (!identifier) return;
      identities.wifi.add(identifier);
      if (publicOrMobileHint(row) || normalizedMac(phoneWifiMac) === identifier) return;
      const candidate = parseObservedWifi(row, site, SITE_WIFI_RADIUS_M, now);
      if (!candidate) return;
      const freshness = candidate.lastSeen ?? candidate.lastUpdated;
      if (!freshness || Date.parse(freshness) < cutoff.getTime()) return;
      wifiCandidates.push(candidate);
      sources.set(candidate, { sourceId, kind: sourceKind, freshnessField: candidate.lastSeen ? "lasttime" : "lastupdt" });
    } else if (kind === "CELL") {
      const identifier = text(row.id, 128);
      if (identifier) identities.cell.add(identifier);
      const candidate = cellCandidate(row, site, sim);
      if (candidate) {
        identities.cell.add(identifier ?? `${candidate.radio}:${candidate.mcc}:${candidate.mnc}:${candidate.lac}:${candidate.cid}`);
        cells.push({ cell: candidate, sourceId, kind: sourceKind });
      }
    } else if (kind === "BLUETOOTH") {
      const identifier = normalizedMac(row.netid);
      if (identifier) identities.bluetooth.add(identifier);
    }
  };
  for (const upload of uploads) {
    const data = jsonObject(upload.payloadJson);
    if (!data || data.version !== 1 || !Array.isArray(data.records)) { invalidSources++; continue; }
    for (const value of data.records.slice(0, 1000)) {
      const row = object(value);
      if (!row) continue;
      consume(row.kind === "WIFI" ? normalizedObservation(row) : {
        id: row.identifier, netid: row.identifier, trilat: row.lat, trilong: row.lng,
      }, String(row.kind), upload.id, "UPLOAD");
    }
    // The normalized upload keeps cell IDs opaque; complete responses may include explicit components.
    if (Array.isArray(data.rawResponses)) for (const page of data.rawResponses.slice(0, MAX_PAGES)) {
      const response = object(page);
      if (response?.success !== true || !Array.isArray(response.results)) continue;
      for (const value of response.results.slice(0, PAGE_SIZE)) {
        const row = object(value);
        const declared = String(row?.gentype ?? row?.radio ?? row?.type ?? "").toUpperCase();
        if (["LTE", "NR", "5GNR", "GSM", "WCDMA"].includes(declared)) consume(value, "CELL", upload.id, "CACHED_RESPONSE");
      }
    }
  }
  const clusters = archives.slice(0, MAX_ARCHIVES).map((archive) => ({ id: archive.id, json: archive.clusterJson, kind: "ARCHIVE" }));
  if (device.wifiClusterJson) clusters.push({ id: device.id, json: device.wifiClusterJson, kind: "DEVICE_SAVED_CLUSTER" });
  for (const cluster of clusters) {
    const data = jsonObject(cluster.json, 250_000);
    if (!data || !Array.isArray(data.nearby)) { invalidSources++; continue; }
    for (const value of [data.primary, ...data.nearby.slice(0, 100)]) {
      const row = object(value);
      if (row) consume({ ...row, netid: row.bssid, trilat: row.lat, trilong: row.lng }, "WIFI", cluster.id, cluster.kind);
    }
  }
  const wifi = rankObservedWifi(wifiCandidates, SITE_WIFI_RADIUS_M, now)[0] ?? null;
  const matchedCell = cells.sort((a, b) => a.cell.distanceM - b.cell.distanceM || a.sourceId.localeCompare(b.sourceId))[0] ?? null;
  if (!wifi) warnings.push(`No eligible Wi-Fi observation with a date within 24 months was saved within ${SITE_WIFI_RADIUS_M} m of this client.`);
  else if (!wifi.lastSeen) warnings.push("The selected Wi-Fi record has no lasttime. Its lastupdt is a catalogue update date used as a freshness proxy, not proof of a recent observation.");
  if (!matchedCell) warnings.push("No saved cell with explicit, valid identifiers matched the actual SIM MCC/MNC within 2,500 m.");
  if (invalidSources) warnings.push(`${invalidSources} saved source(s) could not be parsed.`);
  if (truncated) warnings.push(`Library preparation was limited to ${MAX_DEVICE_WIGLE_UPLOADS} uploads, ${MAX_ARCHIVES} archives, and ${MAX_RECORDS} records.`);
  if (!completedCheck(checks)) warnings.push("A complete client WiGLE query time is unavailable. Preparing this profile does not refresh the library.");
  return { anchor: { lat: site.lat, lng: site.lng },
    wifi: wifi ? { ssid: wifi.ssid, bssid: wifi.bssid, lat: wifi.lat, lng: wifi.lng, distanceM: wifi.distanceM, lastSeen: wifi.lastSeen, qos: wifi.qos } : null,
    cell: matchedCell?.cell ?? null, phoneWifiMac, sim, warnings,
    source: { type: "SAVED_LIBRARY", siteId: site.id, wifiRadiusM: SITE_WIFI_RADIUS_M, cellRadiusM: CELL_RADIUS_M,
      wifi: wifi ? sources.get(wifi)! : null, cell: matchedCell ? { sourceId: matchedCell.sourceId, kind: matchedCell.kind } : null,
      cellWritable: false, bluetooth, baselineVerified, addressVerified: false, checkedEndpoints: checks, truncated },
    records: { wifi: identities.wifi.size, cell: identities.cell.size, bluetooth: identities.bluetooth.size }, checkedAt: completedCheck(checks) };
}

function bounds(site: SiteProfileTarget, radiusM: number) {
  const angular = radiusM / 6_371_000;
  const deltaLat = toDeg(angular);
  const pole = Math.abs(site.lat) + deltaLat >= 90;
  const deltaLng = pole ? 180 : toDeg(Math.asin(Math.min(1, Math.sin(angular) / Math.cos(toRad(site.lat)))));
  const dateLine = site.lng - deltaLng < -180 || site.lng + deltaLng > 180;
  return { latrange1: Math.max(-90, site.lat - deltaLat), latrange2: Math.min(90, site.lat + deltaLat),
    longrange1: pole || dateLine ? -180 : site.lng - deltaLng, longrange2: pole || dateLine ? 180 : site.lng + deltaLng };
}

const refreshing = new Map<string, Promise<SiteLibraryRefresh>>();

export async function refreshSiteLibrary(site: SiteProfileTarget): Promise<SiteLibraryRefresh> {
  assertSite(site);
  const key = `${site.tenantId}:${site.deviceId}:${site.id}:${site.lat}:${site.lng}`;
  const active = refreshing.get(key);
  if (active) return active;
  const pending = performRefresh(site);
  refreshing.set(key, pending);
  try { return await pending; } finally { refreshing.delete(key); }
}

async function performRefresh(site: SiteProfileTarget): Promise<SiteLibraryRefresh> {
  const device = await prisma.device.findFirst({ where: { id: site.deviceId, tenantId: site.tenantId }, select: { id: true } });
  if (!device) throw new HttpError(404, "Device not found");
  const uploads = await prisma.deviceWigleUpload.findMany({ where: { deviceId: site.deviceId, device: { tenantId: site.tenantId } },
    orderBy: [{ importedAt: "desc" }, { id: "asc" }], take: MAX_DEVICE_WIGLE_UPLOADS });
  const checks = checkedEndpoints(uploads, site);
  const result: SiteLibraryRefresh = { checkedAt: completedCheck(checks), cached: true,
    summary: { wifi: 0, cell: 0, bluetooth: 0, queries: 0, uploads: [] }, warnings: [] };
  const missing = ENDPOINTS.filter((endpoint) => !checks[endpoint] || Date.now() - Date.parse(checks[endpoint]!) >= SITE_LIBRARY_TTL_MS);
  if (!missing.length) return result;
  if (uploads.length + missing.length > MAX_DEVICE_WIGLE_UPLOADS) throw new HttpError(409, "The device's saved WiGLE library has no room for this refresh");
  for (const endpoint of missing) {
    const pages: Record<string, unknown>[] = [];
    let rows: unknown[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    const queriedAt = new Date().toISOString();
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await wigleGet<unknown>(endpoint, {
        ...bounds(site, endpoint === "network/search" ? SITE_WIFI_RADIUS_M : CELL_RADIUS_M),
        resultsPerPage: PAGE_SIZE, ...(endpoint === "network/search" ? { closestLat: site.lat, closestLong: site.lng } : {}),
        ...(cursor ? { searchAfter: cursor } : {}),
      }, site.tenantId);
      result.summary.queries++;
      if (response.status === 401 || response.status === 403) throw new HttpError(502, "WiGLE authentication or API access failed. Check the workspace credentials.");
      if (response.status === 429) throw new HttpError(429, "WiGLE is rate limited. No further searches were attempted.");
      const data = object(response.data);
      if (response.status < 200 || response.status >= 300 || data?.success !== true || !Array.isArray(data.results)) {
        throw new HttpError(502, "WiGLE did not return a successful search response; no further searches were attempted");
      }
      if (data.results.length > PAGE_SIZE) throw new HttpError(502, "WiGLE returned more rows than the requested bounded page size");
      if (Buffer.byteLength(JSON.stringify([...pages, data]), "utf8") > MAX_QUERY_BYTES) {
        if (!pages.length) throw new HttpError(413, "The complete WiGLE response exceeds the client's cache limit");
        result.warnings.push(`${endpoint} was limited by the cache size; the last response was not saved.`);
        break;
      }
      pages.push(data);
      rows = rows.concat(data.results);
      cursor = typeof data.searchAfter === "string" && data.searchAfter.trim() && data.searchAfter.length <= 2048 ? data.searchAfter : null;
      if (!cursor || !data.results.length) break;
      if (seenCursors.has(cursor)) { result.warnings.push(`${endpoint} repeated a cursor; pagination stopped.`); break; }
      seenCursors.add(cursor);
      if (page === MAX_PAGES - 1) result.warnings.push(`${endpoint} was limited to ${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE} rows).`);
    }
    const saved = await saveWigleUpload(prisma, site.deviceId, site.tenantId,
      `site-${site.id}-${endpoint === "network/search" ? "wifi" : "cell"}-${queriedAt.slice(0, 10)}.json`,
      { ...pages[0], success: true, results: rows, resultCount: rows.length, searchAfter: cursor },
      { siteId: site.id, queriedAt, endpoint, anchor: { lat: site.lat, lng: site.lng }, rawResponses: pages });
    result.summary.wifi += saved.upload.wifiCount;
    result.summary.cell += saved.upload.cellCount;
    result.summary.bluetooth += saved.upload.bluetoothCount;
    result.summary.uploads.push(saved.upload.id);
    result.cached = false;
    checks[endpoint] = queriedAt;
  }
  result.checkedAt = completedCheck(checks);
  return result;
}
