import { createHash } from "node:crypto";
import { config } from "../config.js";
import { haversineMeters, toDeg, toRad } from "../geo/haversine.js";
import { wigleGet } from "./wigle.js";
import type { WigleQueryCache } from "../ops/wigleUpload.js";

interface Anchor {
  lat: number;
  lng: number;
}

export interface ObservedWifi extends Anchor {
  ssid: string;
  bssid: string;
  distanceM: number;
  lastSeen: string | null;
  lastUpdated: string | null;
  qos: number;
}

export interface ObservedCell extends Anchor {
  radio: string;
  mcc: string;
  mnc: string;
  lac: number;
  cid: number;
  distanceM: number;
}

export interface EnvironmentData {
  wifi: ObservedWifi | null;
  cell: ObservedCell | null;
  warnings: string[];
}

export interface EnvironmentSearch {
  anchor: Anchor;
  radiusM: number;
  startedAt: string;
  pagesLoaded: number;
  observationsLoaded: number;
  nextCursor: string | null;
  cursorHashes: string[];
  stopReason: "END" | "REPEATED_CURSOR" | null;
}

export const CELL_SUPPORT = {
  status: "UNSUPPORTED" as const,
  message: "Cell updates are unsupported: WiGLE's id/gentype fields do not provide a verified operator/LAC/CID mapping. Existing cell settings are preserved.",
};

const MONTH_MS = 365.25 / 12 * 24 * 60 * 60 * 1000;
const STALE_AFTER_MS = 18 * MONTH_MS;
const VERY_STALE_AFTER_MS = 24 * MONTH_MS;
const PAGE_SIZE = 100;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numeric(value: unknown): number | null {
  if (typeof value !== "number" &&
      !(typeof value === "string" && /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function observationTime(value: unknown, nowMs: number): string | null {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== value.slice(0, 10) ||
      Number(value.slice(11, 13)) > 23) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= nowMs ? new Date(timestamp).toISOString() : null;
}

function hasMobilityHint(ssid: string, comment: unknown): boolean {
  // These names suggest portable devices; they do not prove that an AP is moving.
  if (/(?:^|[\s_-])(?:iphone|galaxy)(?:$|[\s_-])|^androidap|^direct-/i.test(ssid.trim())) return true;
  // WiGLE documents free-text comments, not a structured mobility flag.
  return typeof comment === "string" && /^(?:in[ -]motion|mobile[ -]hotspot|moving access point)$/i.test(comment.trim());
}

export function parseObservedWifi(
  value: unknown,
  anchor: Anchor,
  radiusM: number,
  nowMs = Date.now(),
): ObservedWifi | null {
  const row = record(value);
  if (!row || typeof row.netid !== "string" || typeof row.ssid !== "string") return null;
  // network/search is Wi-Fi-specific; do not invent an undocumented type query parameter.
  if (row.type !== undefined && (typeof row.type !== "string" || !["WIFI", "INFRA"].includes(row.type.toUpperCase()))) return null;
  const rawBssid = row.netid.trim();
  if (!/^(?:[a-f\d]{12}|(?:[a-f\d]{2}:){5}[a-f\d]{2}|(?:[a-f\d]{2}-){5}[a-f\d]{2})$/i.test(rawBssid)) return null;
  const hex = rawBssid.replace(/[:-]/g, "").toLowerCase();
  if (hex === "000000000000" || (parseInt(hex.slice(0, 2), 16) & 1) !== 0) return null;
  const bssid = hex.match(/.{2}/g)!.join(":");
  if (!row.ssid.trim() || Buffer.byteLength(row.ssid, "utf8") > 32 ||
      /[\x00-\x1f\x7f]/.test(row.ssid) || /^(?:_nomap|<hidden ssid>)$/i.test(row.ssid.trim())) return null;
  if (hasMobilityHint(row.ssid, row.comment)) return null;
  const lat = numeric(row.trilat);
  const lng = numeric(row.trilong);
  const qos = numeric(row.qos);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180 ||
      qos === null || !Number.isSafeInteger(qos) || qos < 0 || qos > 7) return null;
  const distanceM = haversineMeters(anchor.lat, anchor.lng, lat, lng);
  if (!Number.isFinite(distanceM) || !Number.isFinite(radiusM) || radiusM <= 0 || distanceM > radiusM) return null;
  return {
    ssid: row.ssid, bssid, lat, lng, distanceM,
    lastSeen: observationTime(row.lasttime, nowMs),
    lastUpdated: observationTime(row.lastupdt, nowMs), qos,
  };
}

export function rankObservedWifi(candidates: ObservedWifi[], radiusM: number, nowMs = Date.now()): ObservedWifi[] {
  // Selection weights are heuristics, not measured positioning accuracy.
  const score = (candidate: ObservedWifi) => {
    const age = candidate.lastSeen ? Math.max(0, nowMs - Date.parse(candidate.lastSeen)) : VERY_STALE_AFTER_MS;
    const freshnessPenalty = age <= STALE_AFTER_MS ? 0.5 * age / STALE_AFTER_MS :
      0.5 + 0.5 * Math.min(1, (age - STALE_AFTER_MS) / (VERY_STALE_AFTER_MS - STALE_AFTER_MS));
    return 0.65 * candidate.distanceM / radiusM +
      0.25 * freshnessPenalty + 0.1 / (1 + candidate.qos);
  };
  return [...candidates].sort((a, b) => score(a) - score(b) || a.distanceM - b.distanceM ||
    b.qos - a.qos || a.bssid.localeCompare(b.bssid));
}

function searchBounds(anchor: Anchor, radiusM: number) {
  const angular = radiusM / 6_371_000;
  const latitudeDelta = toDeg(angular);
  const reachesPole = Math.abs(anchor.lat) + latitudeDelta >= 90;
  const longitudeDelta = reachesPole ? 180 : toDeg(Math.asin(Math.min(1, Math.sin(angular) / Math.cos(toRad(anchor.lat)))));
  const crossesDateLine = anchor.lng - longitudeDelta < -180 || anchor.lng + longitudeDelta > 180;
  return {
    latrange1: Math.max(-90, anchor.lat - latitudeDelta),
    latrange2: Math.min(90, anchor.lat + latitudeDelta),
    longrange1: reachesPole || crossesDateLine ? -180 : anchor.lng - longitudeDelta,
    longrange2: reachesPole || crossesDateLine ? 180 : anchor.lng + longitudeDelta,
  };
}

function nextCursor(response: Record<string, unknown>): string | null {
  const cursor = response.searchAfter ?? response.search_after;
  if (typeof cursor === "string" && cursor.trim() && cursor.length <= 2048) return cursor;
  return typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor > 0 ? String(cursor) : null;
}

export async function resolveEnvironmentData(
  anchor: Anchor,
  _sim: { mcc: string; mnc: string },
  tenantId: string,
  continuation?: { search: EnvironmentSearch; wifi: ObservedWifi | null },
): Promise<EnvironmentData & { search: EnvironmentSearch; observations: unknown[]; query: WigleQueryCache }> {
  const radiusM = continuation?.search.radiusM ?? config.wigleRadiusM;
  const savedAnchor = { lat: anchor.lat, lng: anchor.lng };
  if (!tenantId.trim()) throw new Error("A workspace is required for a WiGLE environment lookup.");
  if (!Number.isFinite(savedAnchor.lat) || !Number.isFinite(savedAnchor.lng) || Math.abs(savedAnchor.lat) > 90 || Math.abs(savedAnchor.lng) > 180) {
    throw new Error("A valid anchor latitude and longitude are required.");
  }
  if (!Number.isFinite(radiusM) || radiusM <= 0) throw new Error("WiGLE search radius must be a positive number.");
  if (continuation && (!continuation.search.nextCursor || continuation.search.anchor.lat !== savedAnchor.lat ||
      continuation.search.anchor.lng !== savedAnchor.lng)) {
    throw new Error("This WiGLE search cannot be continued. Prepare a new environment.");
  }
  const nowMs = Date.now();
  const candidates: ObservedWifi[] = continuation?.wifi ? [continuation.wifi] : [];
  const observations: unknown[] = [];
  const rawResponses: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const cursor = continuation?.search.nextCursor;
  // One provider page per explicit user action. Continuations come only from the saved preview.
  const response = await wigleGet<unknown>("network/search", {
    ...searchBounds(savedAnchor, radiusM),
    closestLat: savedAnchor.lat,
    closestLong: savedAnchor.lng,
    resultsPerPage: PAGE_SIZE,
    ...(cursor ? { searchAfter: cursor } : {}),
  }, tenantId);
  if (response.status === 401 || response.status === 403) throw new Error("WiGLE authentication failed. Check your API name and token.");
  if (response.status === 429) throw new Error("WiGLE is rate limited. Try the environment lookup again later.");
  const data = record(response.data);
  if (response.status < 200 || response.status >= 300 || !data || data.success !== true || !Array.isArray(data.results) || data.results.length > PAGE_SIZE) {
    throw new Error("WiGLE could not return valid environment observations. Try again later.");
  }
  rawResponses.push(data);
  for (const row of data.results) {
    const candidate = parseObservedWifi(row, savedAnchor, radiusM, nowMs);
    if (candidate) candidates.push(candidate);
    observations.push(candidate ? { ...record(row), netid: candidate.bssid,
      trilat: candidate.lat, trilong: candidate.lng, qos: candidate.qos } : row);
  }
  let followingCursor = nextCursor(data);
  const cursorHashes = [...(continuation?.search.cursorHashes ?? [])];
  let stopReason: EnvironmentSearch["stopReason"] = followingCursor ? null : "END";
  if (followingCursor) {
    const hash = createHash("sha256").update(followingCursor).digest("hex");
    if (cursorHashes.includes(hash)) {
      followingCursor = null;
      stopReason = "REPEATED_CURSOR";
      warnings.push("WiGLE repeated a pagination cursor. Start a new preview to retry the search; the retrieved observations remain saved.");
    } else cursorHashes.push(hash);
  }
  const search: EnvironmentSearch = {
    anchor: savedAnchor, radiusM, startedAt: continuation?.search.startedAt ?? new Date(nowMs).toISOString(),
    pagesLoaded: (continuation?.search.pagesLoaded ?? 0) + 1,
    observationsLoaded: (continuation?.search.observationsLoaded ?? 0) + data.results.length,
    nextCursor: followingCursor, cursorHashes, stopReason,
  };
  // Keep the ranking clock fixed so retaining the best earlier match is sufficient across pages.
  const wifi = rankObservedWifi(candidates, radiusM, Date.parse(search.startedAt))[0] ?? null;
  if (!wifi) warnings.push(`No valid Wi-Fi observations were found within ${radiusM} m. Existing Wi-Fi settings will be preserved.`);
  else if (!wifi.lastSeen) warnings.push("The selected Wi-Fi network has no valid observation time; its recency is unknown.");
  else if (nowMs - Date.parse(wifi.lastSeen) >= VERY_STALE_AFTER_MS) {
    warnings.push("The selected Wi-Fi network's lasttime is at least 24 months old. This historical record is not evidence of its current presence.");
  }
  else if (nowMs - Date.parse(wifi.lastSeen) > STALE_AFTER_MS) {
    warnings.push("The selected Wi-Fi network's lasttime is more than 18 months old and its location may be stale.");
  }
  return { wifi, cell: null, warnings, search, observations, query: {
    queriedAt: new Date(nowMs).toISOString(), endpoint: "network/search", anchor: savedAnchor, radiusM, rawResponses,
  } };
}
