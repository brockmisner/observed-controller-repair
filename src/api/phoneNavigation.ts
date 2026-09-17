import { HttpError } from "../http/errors.js";
import { readGpsCoordinate, type GpsPoint } from "./providerGps.js";

export const PHONE_COMMAND_TIMEOUT_MS = 10_000;
export const PHONE_LOCATION_MAX_AGE_MS = 30_000;
export const PHONE_COMMAND_MAX_OUTPUT_LENGTH = 1_048_576;
export const PHONE_LOCATION_COMMAND = "cat /proc/uptime; dumpsys location";

export interface MapsLaunchObservation {
  source: "RUNTIME_COMMAND";
  state: "LAUNCH_ACCEPTED" | "UNKNOWN";
  navigationConfirmed: false;
  checkedAt: string;
  reason: string;
}

export interface PhoneLocationObservation {
  source: "RUNTIME_COMMAND";
  state: "OBSERVED" | "UNKNOWN";
  point: GpsPoint | null;
  provider: "gps" | "fused" | null;
  ageMs: number | null;
  fixElapsedRealtimeMs: number | null;
  deviceElapsedRealtimeMs: number | null;
  accuracyMeters: number | null;
  mock: boolean | null;
  checkedAt: string;
  reason: string;
}

export function buildMapsNavigationCommand(destination: GpsPoint): string {
  if (!destination || typeof destination.lat !== "number" || typeof destination.lng !== "number" ||
      readGpsCoordinate(destination.lat, 90) === null || readGpsCoordinate(destination.lng, 180) === null) {
    throw new HttpError(400, "Maps destination must contain finite latitude and longitude numbers within bounds");
  }
  return `am start -W -a android.intent.action.VIEW -d 'google.navigation:q=${destination.lat},${destination.lng}&mode=d' -p com.google.android.apps.maps`;
}

export function readPhoneCommandContent(result: unknown): string {
  const data = result as { success?: unknown; content?: unknown } | null;
  if (data?.success === false) throw new HttpError(502, "DuoPlus rejected the phone command execution.");
  if (data?.success !== true) throw new HttpError(502, "DuoPlus phone command response is missing its success flag.");
  if (typeof data.content !== "string") throw new HttpError(502, "DuoPlus phone command returned no text output.");
  if (data.content.length > PHONE_COMMAND_MAX_OUTPUT_LENGTH) throw new HttpError(502, "DuoPlus phone command output exceeded the size limit.");
  return data.content;
}

export function readMapsLaunch(content: string, checkedAt = new Date()): MapsLaunchObservation {
  const statuses = content.length <= PHONE_COMMAND_MAX_OUTPUT_LENGTH ? [...content.matchAll(/^Status:[^\r\n]*$/gmi)] : [];
  const accepted = statuses.length === 1 && /^Status:\s*ok\s*$/i.test(statuses[0]![0]) &&
    !/^\s*(?:Error:|Error type |Exception|SecurityException|java\.[\w.]*Exception)/mi.test(content);
  return {
    source: "RUNTIME_COMMAND", state: accepted ? "LAUNCH_ACCEPTED" : "UNKNOWN", navigationConfirmed: false,
    checkedAt: checkedAt.toISOString(),
    reason: accepted ? "Android accepted the Maps launch. Turn-by-turn navigation has not been verified." :
      "Android did not confirm the Maps launch.",
  };
}

function elapsedMilliseconds(value: string): number | null {
  if (value === "0") return 0;
  const match = /^\+?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/.exec(value);
  if (!match || !match.slice(1).some((part) => part !== undefined)) return null;
  const multipliers = [86_400_000, 3_600_000, 60_000, 1000, 1];
  const valueMs = match.slice(1).reduce((sum, part, index) => sum + Number(part ?? 0) * multipliers[index]!, 0);
  return Number.isSafeInteger(valueMs) ? valueMs : null;
}

export function readPhoneLocation(content: string, checkedAt = new Date(), commandDurationMs = 0): PhoneLocationObservation {
  const unknown: PhoneLocationObservation = {
    source: "RUNTIME_COMMAND", state: "UNKNOWN", point: null, provider: null, ageMs: null,
    fixElapsedRealtimeMs: null, deviceElapsedRealtimeMs: null,
    accuracyMeters: null, mock: null, checkedAt: checkedAt.toISOString(),
    reason: "No current GPS or fused location with a verifiable age was returned by Android.",
  };
  if (content.length > PHONE_COMMAND_MAX_OUTPUT_LENGTH || !Number.isFinite(commandDurationMs) || commandDurationMs < 0 ||
      commandDurationMs > PHONE_COMMAND_TIMEOUT_MS) return unknown;
  if (/permission denied|permission denial|SecurityException/i.test(content)) {
    return { ...unknown, reason: "Android denied permission to read location diagnostics. Check DuoPlus command access for this phone." };
  }
  const lines = content.split(/\r?\n/);
  const uptime = /^\s*(\d+(?:\.\d+)?)\s+\d+(?:\.\d+)?\s*$/.exec(lines[0] ?? "");
  if (!uptime) return { ...unknown, reason: "Android uptime was missing from the command response, so location freshness cannot be verified." };
  const uptimeMs = Number(uptime[1]) * 1000;
  if (!Number.isFinite(uptimeMs) || uptimeMs <= 0 || uptimeMs > Number.MAX_SAFE_INTEGER) return unknown;
  unknown.deviceElapsedRealtimeMs = uptimeMs;

  const candidates: PhoneLocationObservation[] = [];
  let inLastKnownSection = false;
  let lastKnownIndent = 0;
  for (const line of lines.slice(1)) {
    const indent = line.length - line.trimStart().length;
    if (/^\s*Last Known Locations:\s*$/i.test(line)) {
      inLastKnownSection = true;
      lastKnownIndent = indent;
      continue;
    }
    if (line.trim() && indent <= lastKnownIndent) inLastKnownSection = false;
    // Only last-fix fields are evidence. Event history and registration logs also contain Location strings.
    if (!/^\s*(?:last location|mLastLocation)\s*[=:]\s*Location\[/i.test(line) &&
        !(inLastKnownSection && /^\s*(?:gps|fused):\s*Location\[/i.test(line))) continue;
    const fix = /Location\[(gps|fused)\s+([^\s,]+),([^\s,\]]+)([^\]\r\n]*)\]/i.exec(line);
    if (!fix) continue;
    const provider = fix[1]!.toLowerCase() as "gps" | "fused";
    const lat = readGpsCoordinate(fix[2], 90);
    const lng = readGpsCoordinate(fix[3], 180);
    const elapsed = /(?:^|\s)et=([^\s]+)/.exec(fix[4]!);
    const elapsedMs = elapsed ? elapsedMilliseconds(elapsed[1]!) : null;
    if (lat === null || lng === null || elapsedMs === null || elapsedMs <= 0 || elapsedMs > uptimeMs + commandDurationMs) {
      candidates.push({ ...unknown, provider });
      continue;
    }
    // Add the entire request duration to conservatively account for the age when the response arrives.
    const ageMs = Math.max(0, Math.ceil(uptimeMs + commandDurationMs - elapsedMs));
    const rawAccuracy = /(?:^|\s)hAcc=(\d+(?:\.\d+)?)(?:\s|$)/.exec(fix[4]!);
    const accuracy = rawAccuracy ? Number(rawAccuracy[1]) : null;
    candidates.push({
      ...unknown, state: ageMs <= PHONE_LOCATION_MAX_AGE_MS ? "OBSERVED" : "UNKNOWN",
      point: ageMs <= PHONE_LOCATION_MAX_AGE_MS ? { lat, lng } : null,
      provider, fixElapsedRealtimeMs: elapsedMs, ageMs,
      accuracyMeters: accuracy !== null && Number.isFinite(accuracy) ? accuracy : null,
      mock: /(?:^|\s)mock(?:\s|$|\{)/i.test(fix[4]!),
      reason: ageMs <= PHONE_LOCATION_MAX_AGE_MS ? "A recent Android last-location fix was observed." :
        "The Android last-location fix is older than 30 seconds; current location is unknown.",
    });
  }
  candidates.sort((a, b) => Number(b.provider === "fused") - Number(a.provider === "fused") ||
    (b.fixElapsedRealtimeMs ?? -1) - (a.fixElapsedRealtimeMs ?? -1));
  const latest = candidates[0];
  if (!latest) return unknown;
  if (candidates.some((candidate) => candidate.provider === latest.provider &&
      (candidate.point?.lat !== latest.point?.lat || candidate.point?.lng !== latest.point?.lng))) {
    return { ...unknown, provider: latest.provider, reason: "Android returned conflicting last-location fixes; current location is unknown." };
  }
  return latest;
}
