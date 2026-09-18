import { haversineMeters } from "../geo/haversine.js";
import type { Position } from "../radio/schema.js";

/**
 * Web-Mercator tile grid. A client service area is stored as tiles so a phone reads only the
 * neighbourhood it can actually hear, instead of one document per area.
 * Zoom 15 is roughly 1.2 km x 1.1 km at Miami Beach latitude.
 */
export const DEFAULT_TILE_ZOOM = 15;
export const MIN_TILE_ZOOM = 10;
export const MAX_TILE_ZOOM = 18;
const MAX_MERCATOR_LAT = 85.05112878;

/**
 * Cell observations are orders of magnitude sparser than Wi-Fi but are needed out to a 3 km radius, so
 * they are stored on a coarser grid. Without this, a single window would have to enumerate hundreds of
 * mostly empty cell tile keys.
 */
export const CELL_ZOOM_OFFSET = 3;

/** Uses the configured zoom for dense observations and a coarser zoom for cellular observations. */
export function zoomForKind(kind: "WIFI" | "CELL" | "BLUETOOTH", baseZoom: number): number {
  return kind === "CELL" ? Math.max(MIN_TILE_ZOOM, baseZoom - CELL_ZOOM_OFFSET) : baseZoom;
}

export type TileRef = { zoom: number; x: number; y: number; key: string };
export type TileBounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };

/** Formats a stable Web-Mercator tile identifier. */
export function tileKey(zoom: number, x: number, y: number): string {
  return `${zoom}/${x}/${y}`;
}

function assertZoom(zoom: number): void {
  if (!Number.isInteger(zoom) || zoom < MIN_TILE_ZOOM || zoom > MAX_TILE_ZOOM) throw new Error("Unsupported tile zoom");
}

function clampLat(lat: number): number {
  return Math.min(MAX_MERCATOR_LAT, Math.max(-MAX_MERCATOR_LAT, lat));
}

/** Locates a position in the supported Web-Mercator grid, clamping coordinates to grid bounds. */
export function tileFor(position: Position, zoom: number): TileRef {
  assertZoom(zoom);
  const count = 2 ** zoom;
  const lat = clampLat(position.lat);
  const x = Math.min(count - 1, Math.max(0, Math.floor(((position.lng + 180) / 360) * count)));
  const sin = Math.sin((lat * Math.PI) / 180);
  const yFraction = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  const y = Math.min(count - 1, Math.max(0, Math.floor(yFraction * count)));
  return { zoom, x, y, key: tileKey(zoom, x, y) };
}

/** Converts a supported tile coordinate to its geographic bounds. */
export function tileBounds(zoom: number, x: number, y: number): TileBounds {
  assertZoom(zoom);
  const count = 2 ** zoom;
  const lngAt = (tileX: number) => (tileX / count) * 360 - 180;
  const latAt = (tileY: number) => {
    const n = Math.PI - (2 * Math.PI * tileY) / count;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  };
  return { minLng: lngAt(x), maxLng: lngAt(x + 1), maxLat: latAt(y), minLat: latAt(y + 1) };
}

/**
 * Every tile whose bounds can hold a point within `radiusM` of `center`. The candidate rectangle is
 * padded by one tile on each side so a phone sitting on a tile edge still loads the neighbour, and
 * longitude wrap is handled by the tile-index modulo rather than by clipping the range.
 */
export function tilesWithin(center: Position, radiusM: number, zoom: number): TileRef[] {
  assertZoom(zoom);
  if (!Number.isFinite(radiusM) || radiusM < 0) throw new Error("Invalid tile search radius");
  const count = 2 ** zoom;
  const latDegrees = radiusM / 111_139;
  const cosLat = Math.max(0.01, Math.cos((clampLat(center.lat) * Math.PI) / 180));
  const lngDegrees = radiusM / (111_139 * cosLat);
  const north = tileFor({ lat: clampLat(center.lat + latDegrees), lng: center.lng }, zoom);
  const south = tileFor({ lat: clampLat(center.lat - latDegrees), lng: center.lng }, zoom);
  const centerTile = tileFor({ lat: clampLat(center.lat), lng: center.lng }, zoom);
  const spanX = Math.min(count, Math.ceil((lngDegrees / 360) * count) + 1);
  const refs: TileRef[] = [];
  for (let y = Math.max(0, north.y - 1); y <= Math.min(count - 1, south.y + 1); y++) {
    for (let offset = -spanX; offset <= spanX; offset++) {
      const x = ((centerTile.x + offset) % count + count) % count;
      const ref = { zoom, x, y, key: tileKey(zoom, x, y) };
      if (!refs.some((existing) => existing.key === ref.key)) refs.push(ref);
    }
  }
  return refs.filter((ref) => tileIntersectsCircle(ref, center, radiusM))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Closest-point test against the tile rectangle, so no tile holding in-radius records is skipped. */
export function tileIntersectsCircle(ref: TileRef, center: Position, radiusM: number): boolean {
  const bounds = tileBounds(ref.zoom, ref.x, ref.y);
  const lat = Math.min(bounds.maxLat, Math.max(bounds.minLat, center.lat));
  const lngCandidates = [Math.min(bounds.maxLng, Math.max(bounds.minLng, center.lng))];
  // A wrapped area can be nearer across the anti-meridian than the raw longitude comparison suggests.
  for (const shift of [-360, 360]) {
    lngCandidates.push(Math.min(bounds.maxLng, Math.max(bounds.minLng, center.lng + shift)) - shift);
  }
  return lngCandidates.some((lng) => haversineMeters(center.lat, center.lng, lat, lng) <= radiusM);
}

/** Approximates a tile's surface area in square kilometers at the tile row's latitude. */
export function tileAreaKm2(zoom: number, y: number): number {
  const bounds = tileBounds(zoom, 0, y);
  const height = haversineMeters(bounds.minLat, 0, bounds.maxLat, 0);
  const width = haversineMeters((bounds.minLat + bounds.maxLat) / 2, bounds.minLng, (bounds.minLat + bounds.maxLat) / 2, bounds.maxLng);
  return (height * width) / 1_000_000;
}
