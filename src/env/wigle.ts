import axios from "axios";
import { normalizedMac } from "../api/environmentWifi.js";
import { getWigleCredentials } from "../api/wigleKeys.js";
import { config } from "../config.js";
import { haversineMeters, METERS_PER_DEGREE_LAT, toRad } from "../geo/haversine.js";
import { logger } from "../logger.js";

export interface WigleNetwork {
  ssid: string;
  bssid: string;
  lat: number;
  lng: number;
  qos: number;
  channel?: number;
  encryption?: string;
  lastupdt?: string;
  distanceM: number;
}

export interface WigleCluster {
  primary: WigleNetwork;
  nearby: WigleNetwork[];
  queriedAt: string;
  radiusM: number;
}

interface WigleSearchRow {
  ssid?: string;
  netid?: string;
  trilat?: number;
  trilong?: number;
  qos?: number;
  channel?: number;
  encryption?: string;
  lastupdt?: string;
}

interface WigleSearchResponse {
  success?: boolean;
  results?: WigleSearchRow[];
  message?: string;
  error?: string;
}

export async function wigleConfigured(tenantId?: string): Promise<boolean> {
  return Boolean(await getWigleCredentials(tenantId));
}

export async function wigleGet<T>(path: string, params: Record<string, unknown>, tenantId?: string) {
  const credentials = await getWigleCredentials(tenantId);
  if (!credentials) {
    throw new Error("WiGLE credentials missing. Add your API name and API token in workspace settings.");
  }
  try {
    return await axios.get<T>(`https://api.wigle.net/api/v2/${path}`, {
      auth: { username: credentials.apiName, password: credentials.apiToken },
      params,
      timeout: 20_000,
      maxRedirects: 0,
      headers: { Accept: "application/json" },
      validateStatus: () => true,
    });
  } catch {
    throw new Error("WiGLE could not be reached. Try again later.");
  }
}

export function normalizeBssid(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!/^(?:[a-f\d]{12}|(?:[a-f\d]{2}:){5}[a-f\d]{2}|(?:[a-f\d]{2}-){5}[a-f\d]{2})$/.test(value)) return value;
  const hex = value.replace(/[:-]/g, "");
  return hex.match(/.{2}/g)!.join(":");
}

function isGloballyAdministeredUnicast(bssid: string): boolean {
  const mac = normalizedMac(bssid);
  if (!mac) return false;
  const first = parseInt(mac.slice(0, 2), 16);
  const multicast = (first & 0x01) === 0x01;
  const local = (first & 0x02) === 0x02;
  return !multicast && !local;
}

function bbox(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / METERS_PER_DEGREE_LAT;
  const dLng = radiusM / (METERS_PER_DEGREE_LAT * Math.max(0.2, Math.cos(toRad(lat))));
  return {
    latrange1: lat - dLat,
    latrange2: lat + dLat,
    longrange1: lng - dLng,
    longrange2: lng + dLng,
  };
}

export async function searchWigleNear(
  lat: number,
  lng: number,
  radiusM = config.wigleRadiusM,
  tenantId?: string,
): Promise<WigleNetwork[]> {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) {
    throw new Error("A valid anchor latitude and longitude are required.");
  }
  if (!Number.isFinite(radiusM) || radiusM <= 0) throw new Error("WiGLE search radius must be a positive number.");
  const box = bbox(lat, lng, radiusM);
  const res = await wigleGet<WigleSearchResponse>("network/search", {
    onlymine: false,
    freenet: false,
    paynet: false,
    resultsPerPage: 100,
    closestLat: lat,
    closestLong: lng,
    ...box,
  }, tenantId);

  if (res.status === 401 || res.status === 403) {
    throw new Error("WiGLE authentication failed (check API name + token).");
  }
  if (res.status === 429) {
    throw new Error("WiGLE rate limited. Retry later.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`WiGLE HTTP ${res.status}. Try again later.`);
  }
  if (res.data?.success === false) {
    throw new Error("WiGLE search failed. Check your account's API access.");
  }

  const rows = res.data.results ?? [];
  const networks: WigleNetwork[] = [];
  for (const row of rows) {
    if (!row || typeof row.netid !== "string" || typeof row.ssid !== "string") continue;
    const bssid = normalizeBssid(row.netid);
    if (!isGloballyAdministeredUnicast(bssid)) continue;
    const ssid = (row.ssid ?? "").trim();
    if (!ssid || ssid === "_nomap" || ssid.toLowerCase() === "<hidden ssid>") continue;
    const nLat = row.trilat;
    const nLng = row.trilong;
    if (typeof nLat !== "number" || !Number.isFinite(nLat) || Math.abs(nLat) > 90 ||
        typeof nLng !== "number" || !Number.isFinite(nLng) || Math.abs(nLng) > 180) continue;
    const distanceM = haversineMeters(lat, lng, nLat, nLng);
    if (!Number.isFinite(distanceM) || distanceM > radiusM) continue;
    networks.push({
      ssid,
      bssid,
      lat: nLat,
      lng: nLng,
      qos: Number(row.qos ?? 0),
      channel: row.channel,
      encryption: row.encryption,
      lastupdt: row.lastupdt,
      distanceM,
    });
  }

  networks.sort((a, b) => a.distanceM - b.distanceM || b.qos - a.qos);
  logger.info({ lat, lng, hits: networks.length, radiusM }, "WiGLE search complete");
  return networks;
}

export type WifiClass = "residential" | "education" | "enterprise" | "unknown";

const RES_SSID =
  /\b(att|at&t|u-?verse|sbcglobal|spectrum|xfinity|comcast|cox|optimum|fios|verizon[- ]?fios|webpass|netgear|linksys|tp-?link|asus|eero|google wifi|nest wifi|arris|orbi|home[- ]?wifi|mywifi)\b/i;
const EDU_SSID =
  /\b(eduroam|university|college|campus|fiu|florida international|school|library|students?|dorm|edu)\b/i;
const ENT_SSID = /\b(corp|guest|office|enterprise|meraki|unifi|aruba|cisco|secure[- ]?wifi)\b/i;

export function classifySsid(ssid: string): WifiClass {
  if (EDU_SSID.test(ssid)) return "education";
  if (RES_SSID.test(ssid)) return "residential";
  if (ENT_SSID.test(ssid)) return "enterprise";
  return "unknown";
}

export function wifiClassFromIsp(isp?: string, kind?: string, org?: string): WifiClass {
  const blob = `${isp ?? ""} ${kind ?? ""} ${org ?? ""}`.toLowerCase();
  if (/\b(university|college|edu|school|campus|fiu)\b/.test(blob)) return "education";
  if (kind === "residential" || /\b(comcast|xfinity|spectrum|charter|cox|att|at&t|fios|webpass|frontier|optimum)\b/.test(blob)) {
    return "residential";
  }
  if (/\b(business|enterprise|datacenter|amazon|google cloud|microsoft)\b/.test(blob)) return "enterprise";
  return "unknown";
}

const TIER1_SSID =
  /\b(att[-_ ]?fiber|att[-_ ]?wifi|u-?verse|xfinity|xfinitywifi|spectrum|myspectrumwifi|webpass|fios|google fiber)\b/i;
const TIER2_SSID = /\b(netgear|linksys|tp-?link|asus|eero|orbi|arris|belkin|google wifi|nest wifi|home[- ]?wifi)\b/i;
const TIER2_OUI = new Set(["00:1d:d2", "20:3d:66", "28:80:23", "a0:63:91", "e4:f4:c6", "14:91:82", "b0:be:76", "c8:3a:35"]);

function tierOf(n: WigleNetwork): 1 | 2 | 3 {
  if (TIER1_SSID.test(n.ssid)) return 1;
  const oui = n.bssid.slice(0, 8);
  if (TIER2_SSID.test(n.ssid) || TIER2_OUI.has(oui)) return 2;
  return 3;
}

export async function resolveWigleCluster(
  lat: number,
  lng: number,
  hint?: { isp?: string; kind?: string; org?: string },
  tenantId?: string,
): Promise<WigleCluster> {
  const all = await searchWigleNear(lat, lng, config.wigleRadiusM, tenantId);

  const want = wifiClassFromIsp(hint?.isp, hint?.kind, hint?.org);
  const ranked = [...all].sort((a, b) => {
    const classA = classifySsid(a.ssid) === want ? 0 : 1;
    const classB = classifySsid(b.ssid) === want ? 0 : 1;
    return tierOf(a) - tierOf(b) || classA - classB || a.distanceM - b.distanceM || b.qos - a.qos;
  });
  const nearby = ranked.slice(0, Math.max(config.wigleClusterSize, 1));
  const primary = nearby[0];
  if (!primary) {
    throw new Error(`WiGLE returned no usable BSSIDs within ${config.wigleRadiusM}m of ${lat},${lng}`);
  }
  logger.info(
    {
      want,
      tier: tierOf(primary),
      picked: primary.ssid,
      class: classifySsid(primary.ssid),
      distanceM: primary.distanceM,
      candidates: all.length,
    },
    "WiGLE SSID tier pick",
  );
  return {
    primary,
    nearby,
    queriedAt: new Date().toISOString(),
    radiusM: config.wigleRadiusM,
  };
}

export interface WigleCell {
  radio: string;
  mcc: string;
  mnc: string;
  lac: number;
  cid: number;
  lat: number;
  lng: number;
  distanceM: number;
}

export async function searchWigleCells(
  lat: number,
  lng: number,
  mcc: string,
  mnc: string,
  radiusM = config.wigleCellRadiusM,
  tenantId?: string,
): Promise<WigleCell[]> {
  if (!(await wigleConfigured(tenantId))) return [];
  const box = bbox(lat, lng, radiusM);
  const res = await wigleGet<{ results?: Record<string, unknown>[] }>("cell/search", {
    onlymine: false,
    resultsPerPage: 100,
    cell_op: mcc,
    mnc,
    ...box,
  }, tenantId);
  if (res.status < 200 || res.status >= 300) {
    logger.warn({ status: res.status, mcc, mnc }, "WiGLE cell search HTTP error");
    return [];
  }
  const rows = (res.data?.results ?? res.data ?? []) as Record<string, unknown>[];
  const cells: WigleCell[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const radio = String(row.radio ?? row.type ?? "LTE").toUpperCase();
    if (radio && radio !== "LTE" && radio !== "NR" && radio !== "WCDMA" && radio !== "GSM") continue;
    const rowMcc = String(row.mcc ?? row.cell_op ?? mcc);
    const rowMnc = String(row.mnc ?? mnc);
    const lac = Number(row.lac ?? row.tac ?? row.cell_net ?? 0);
    const cid = Number(row.cellid ?? row.cid ?? row.netid ?? 0);
    const cLat = Number(row.trilat ?? row.lat ?? row.latitude);
    const cLng = Number(row.trilong ?? row.lon ?? row.lng ?? row.longitude);
    if (!Number.isFinite(lac) || !Number.isFinite(cid) || lac <= 0 || cid <= 0) continue;
    if (!Number.isFinite(cLat) || !Number.isFinite(cLng)) continue;
    cells.push({
      radio: radio || "LTE",
      mcc: rowMcc,
      mnc: rowMnc,
      lac,
      cid,
      lat: cLat,
      lng: cLng,
      distanceM: haversineMeters(lat, lng, cLat, cLng),
    });
  }
  cells.sort((a, b) => a.distanceM - b.distanceM);
  logger.info({ lat, lng, mcc, mnc, hits: cells.length }, "WiGLE cell search complete");
  return cells;
}

export async function resolveWigleCell(
  lat: number,
  lng: number,
  mcc: string,
  mnc: string,
  tenantId?: string,
): Promise<WigleCell | null> {
  const cells = await searchWigleCells(lat, lng, mcc, mnc, config.wigleCellRadiusM, tenantId);
  const preferLte = cells.filter(
    (c) => c.radio === "LTE" || c.radio === "NR",
  );
  return preferLte[0] ?? cells[0] ?? null;
}
