import { HttpError } from "../http/errors.js";

export interface GpsPoint {
  lat: number;
  lng: number;
}

export interface ProviderGpsObservation {
  type: 1 | 2 | null;
  point: GpsPoint | null;
}

export function readGpsCoordinate(value: unknown, limit: 90 | 180): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
}

export function readProviderGps(info: unknown, imageId: string): ProviderGpsObservation {
  const data = info as { id?: unknown; gps?: { type?: unknown; lat?: unknown; lng?: unknown; latitude?: unknown; longitude?: unknown } } | null;
  if (!data || data.id !== imageId) throw new HttpError(502, "DuoPlus did not return details for the requested device");
  const gps = data.gps;
  const lat = readGpsCoordinate(gps?.latitude !== undefined ? gps.latitude : gps?.lat, 90);
  const lng = readGpsCoordinate(gps?.longitude !== undefined ? gps.longitude : gps?.lng, 180);
  const aliasLat = gps?.lat === undefined ? lat : readGpsCoordinate(gps.lat, 90);
  const aliasLng = gps?.lng === undefined ? lng : readGpsCoordinate(gps.lng, 180);
  return {
    type: gps?.type === 1 || gps?.type === "1" ? 1 : gps?.type === 2 || gps?.type === "2" ? 2 : null,
    point: lat !== null && lng !== null && lat === aliasLat && lng === aliasLng ? { lat, lng } : null,
  };
}
