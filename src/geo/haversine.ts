const EARTH_RADIUS_M = 6_371_000;
export const METERS_PER_DEGREE_LAT = 111_139;

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function destinationPoint(
  lat: number,
  lng: number,
  distanceM: number,
  bearingRad: number,
): { lat: number; lng: number } {
  const deltaLat = (Math.sin(bearingRad) * distanceM) / METERS_PER_DEGREE_LAT;
  const metersPerDegLng = METERS_PER_DEGREE_LAT * Math.cos(toRad(lat));
  const deltaLng = (Math.cos(bearingRad) * distanceM) / Math.max(1e-9, metersPerDegLng);
  return { lat: lat + deltaLat, lng: lng + deltaLng };
}

export function bearingDegrees(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  const deg = toDeg(Math.atan2(y, x));
  return (deg + 360) % 360;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

export function offsetMeters(
  lat: number,
  lng: number,
  eastM: number,
  northM: number,
): { lat: number; lng: number } {
  const metersPerDegLng = METERS_PER_DEGREE_LAT * Math.cos(toRad(lat));
  return {
    lat: lat + northM / METERS_PER_DEGREE_LAT,
    lng: lng + eastM / Math.max(1e-9, metersPerDegLng),
  };
}
