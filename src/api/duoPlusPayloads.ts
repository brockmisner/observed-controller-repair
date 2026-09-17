import { HttpError } from "../http/errors.js";
import { preservedWifiPatch, type DeviceWifiState, type SubmittedWifi } from "./environmentWifi.js";

interface DriftImage {
  image_id: string;
  gps: { type: 2; latitude: string; longitude: string };
}

interface WifiImage {
  image_id: string;
  wifi: SubmittedWifi;
}

export function validateImageId(imageId: string): void {
  if (typeof imageId !== "string" || !imageId || imageId.trim() !== imageId || /[\x00-\x1f\x7f-\x9f]/.test(imageId)) {
    throw new HttpError(400, "A valid DuoPlus image ID is required");
  }
}

export function buildDriftPayload(imageId: string, latitude: number, longitude: number): { images: DriftImage[] } {
  validateImageId(imageId);
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new HttpError(400, "GPS coordinates must be finite numbers within latitude/longitude bounds");
  }
  return { images: [{ image_id: imageId, gps: { type: 2, latitude: String(latitude), longitude: String(longitude) } }] };
}

export function buildWifiApplyPayload(
  imageId: string,
  current: DeviceWifiState,
  selected: { ssid: string; bssid: string; expectedMac?: string | null },
): { images: WifiImage[] } {
  validateImageId(imageId);
  return { images: [{ image_id: imageId, wifi: preservedWifiPatch(selected, current) }] };
}
