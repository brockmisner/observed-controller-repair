import { z } from "zod";

export const gpsRejectionReasonSchema = z.enum([
  "DEVICE_BUSY", "DEVICE_TRANSITIONING", "DEVICE_OFFLINE", "RATE_LIMITED",
  "AUTHORIZATION", "INVALID_LOCATION", "DEVICE_EXPIRED", "UNKNOWN",
]);
export type GpsRejectionReason = z.infer<typeof gpsRejectionReasonSchema>;

const messages: Record<GpsRejectionReason, string> = {
  DEVICE_BUSY: "DuoPlus rejected this GPS update: device busy [DEVICE_BUSY].",
  DEVICE_TRANSITIONING: "DuoPlus rejected this GPS update: device changing power state [DEVICE_TRANSITIONING].",
  DEVICE_OFFLINE: "DuoPlus rejected this GPS update: device not running [DEVICE_OFFLINE].",
  RATE_LIMITED: "DuoPlus rejected this GPS update: request frequency limit [RATE_LIMITED].",
  AUTHORIZATION: "DuoPlus rejected this GPS update: authorization denied [AUTHORIZATION].",
  INVALID_LOCATION: "DuoPlus rejected this GPS update: invalid location values [INVALID_LOCATION].",
  DEVICE_EXPIRED: "DuoPlus rejected this GPS update: device expired [DEVICE_EXPIRED].",
  UNKNOWN: "DuoPlus rejected this GPS update with an unrecognized device-specific reason [UNKNOWN].",
};

export function gpsRejectionMessage(reason: GpsRejectionReason): string { return messages[reason]; }

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

declare const safeDetailBrand: unique symbol;
export interface SafeGpsRejectionDetail { readonly text: string; readonly [safeDetailBrand]: true }
const safeDetails = new WeakMap<object, { imageId: string; text: string }>();
const updateDetails = new WeakMap<object, Map<string, SafeGpsRejectionDetail>>();
const updateReasons = new WeakMap<object, Map<string, GpsRejectionReason>>();

export function gpsRejectionDetailText(value: unknown, imageId?: string): string | undefined {
  const detail = value && typeof value === "object" ? safeDetails.get(value) : undefined;
  return detail && (imageId === undefined || detail.imageId === imageId) ? detail.text : undefined;
}

export function readGpsRejectionDetail(response: unknown, imageId: string): SafeGpsRejectionDetail | undefined {
  return response && typeof response === "object" ? updateDetails.get(response)?.get(imageId) : undefined;
}

export function sanitizeGpsRejectionText(raw: unknown, actualApiKey: string): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  if (raw.length > 65_536) return "Provider reason exceeded the safe size limit.";
  let text = raw;
  for (const secret of new Set([actualApiKey, encodeURIComponent(actualApiKey), JSON.stringify(actualApiKey).slice(1, -1)])) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi, "[redacted URL]")
    .replace(/\b(?:proxy[-_ ]?)?authorization\s*[:=]\s*[^;,]+/gi, "Authorization: [redacted]")
    .replace(/["']?\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|token|password|passwd|pwd|secret|client[-_ ]?secret|credentials?|proxy[-_ ]?(?:user(?:name)?|pass(?:word)?)|user(?:name)?)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi, "credential=[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted authorization]")
    .replace(/[^\s:;@]+:[^\s;@]+@[^\s,;]+/g, "[redacted proxy]")
    .replace(/\b(?:[a-z\d-]+\.)+[a-z\d-]+:\d{2,5}:[^\s:;,]+:[^\s;,]+/gi, "[redacted proxy]")
    .replace(/\beyJ[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+\b/gi, "[redacted token]")
    .replace(/\b(?:obs_trip_|sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-)[a-z\d_-]+\b/gi, "[redacted token]")
    .replace(/\b(?=[a-z\d_+\/-]{24,}\b)(?=[a-z\d_+\/-]*[a-z])(?=[a-z\d_+\/-]*\d)[a-z\d_+\/-]{24,}={0,2}/gi, "[redacted token]")
    .replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) : undefined;
}

// This boundary knows the actual credential and discards all unrelated response data.
export function sanitizeCloudPhoneUpdateResult(response: unknown, requestedImageIds: string[], actualApiKey: string) {
  const requested = new Set(requestedImageIds);
  const result: { success?: string[]; fail?: string[]; fail_reason: Record<string, string> } = { fail_reason: {} };
  for (const field of ["success", "fail"] as const) {
    const ids = ownValue(response, field);
    if (Array.isArray(ids) && ids.length <= 1000 && ids.every((id) => typeof id === "string")) {
      result[field] = ids.filter((id) => requested.has(id));
    }
  }
  const details = new Map<string, SafeGpsRejectionDetail>();
  const categories = new Map<string, GpsRejectionReason>();
  for (const imageId of requested) {
    const text = sanitizeGpsRejectionText(ownValue(ownValue(response, "fail_reason"), imageId), actualApiKey);
    if (!text) continue;
    Object.defineProperty(result.fail_reason, imageId, { value: text, enumerable: true });
    const detail = Object.freeze({ text }) as SafeGpsRejectionDetail;
    safeDetails.set(detail, { imageId, text });
    details.set(imageId, detail);
    const category = readGpsRejectionReason(response, imageId);
    if (category) categories.set(imageId, category);
  }
  updateDetails.set(result, details);
  updateReasons.set(result, categories);
  return result;
}

// Reduce only this device's reason to fixed vocabulary; never persist provider prose or identifiers.
export function readGpsRejectionReason(response: unknown, imageId: string): GpsRejectionReason | undefined {
  if (response && typeof response === "object") {
    const category = updateReasons.get(response)?.get(imageId);
    if (category) return category;
  }
  const raw = ownValue(ownValue(response, "fail_reason"), imageId);
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  if (raw.length > 4096) return "UNKNOWN";
  const reason = raw.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  if (/\b(?:unauthorized|forbidden|permission denied|access denied|invalid api key|authentication failed)\b/i.test(reason)) return "AUTHORIZATION";
  if (/\b(?:rate limit|too many requests|too frequent|frequency limit)\b/i.test(reason)) return "RATE_LIMITED";
  if (reason.trim() === "The cloud phone is being configured and cannot be operated, please wait and try again.") return "DEVICE_TRANSITIONING";
  if (/\b(?:powering on|powering off|booting|rebooting|restarting|shutting down|starting up)\b/i.test(reason)) return "DEVICE_TRANSITIONING";
  if (/\b(?:offline|powered off|not (?:powered|turned) on|not running|device is off)\b/i.test(reason)) return "DEVICE_OFFLINE";
  if (/\b(?:busy|operation in progress|modification in progress|being modified)\b/i.test(reason)) return "DEVICE_BUSY";
  if (/\binvalid\b.{0,40}\b(?:gps|coordinates?|latitude|longitude)\b|\b(?:gps|coordinates?|latitude|longitude)\b.{0,40}\b(?:invalid|out of range)\b/i.test(reason)) return "INVALID_LOCATION";
  if (/\b(?:device|phone|image)\b.{0,40}\bexpired\b/i.test(reason)) return "DEVICE_EXPIRED";
  return "UNKNOWN";
}
