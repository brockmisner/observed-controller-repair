import { z } from "zod";
import { haversineMeters, METERS_PER_DEGREE_LAT, toRad } from "../geo/haversine.js";
import type { Position } from "../radio/schema.js";

/**
 * Query planning for a one-time area ingest.
 *
 * WiGLE returns 100 rows per page and paginates with `searchAfter`, and the account's daily query
 * allowance is a hard stop: a real response in this project's own captures is
 * `{"success": false, "message": "too many queries today"}`. So an area ingest is planned as a grid of
 * small bounding-box queries, each with its own cursor, and it is expected to span several days.
 *
 * `totalResults` on an unbounded query is the whole WiGLE corpus (a captured Wi-Fi response reported
 * 294,975,645), so it is only meaningful for capacity planning when the query is properly bounded by
 * latrange1/latrange2/longrange1/longrange2.
 */

export const WIGLE_PAGE_SIZE = 100;
export const ENDPOINTS = { WIFI: "network/search", CELL: "cell/search", BLUETOOTH: "bluetooth/search" } as const;

export const queryKindSchema = z.enum(["WIFI", "CELL", "BLUETOOTH"]);
export type QueryKind = z.infer<typeof queryKindSchema>;

export const planRequestSchema = z.object({
  center: z.object({ lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) }).strict(),
  radiusM: z.number().finite().min(100).max(30000),
  kinds: z.array(queryKindSchema).min(1).default(["WIFI", "CELL", "BLUETOOTH"]),
  /** Query-cell edge length. Smaller cells mean more queries but fewer pages per query. */
  cellSizeM: z.number().finite().min(100).max(5000).default(1000),
  dailyQueryBudget: z.number().int().min(1).max(100000).default(2000),
  /** Rows expected per square kilometre, per kind. Unverified until a bounded query is run. */
  densityPerKm2: z.object({
    WIFI: z.number().finite().min(0).default(2000),
    CELL: z.number().finite().min(0).default(15),
    BLUETOOTH: z.number().finite().min(0).default(400),
  }).partial().default({}),
}).strict();
export type PlanRequest = z.infer<typeof planRequestSchema>;

export type QueryCell = {
  cellKey: string;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  center: Position;
  areaKm2: number;
  distanceFromCentreM: number;
};

export type IngestPlan = {
  center: Position;
  radiusM: number;
  radiusMiles: number;
  areaKm2: number;
  cellSizeM: number;
  cells: QueryCell[];
  kinds: QueryKind[];
  estimate: {
    perKind: Record<QueryKind, { expectedRows: number; expectedPages: number; minimumQueries: number }>;
    totalQueries: number;
    dailyQueryBudget: number;
    daysAtBudget: number;
    assumptionsUnverified: string[];
  };
};

function cellKey(row: number, column: number): string {
  return `r${row}c${column}`;
}

/** Grid of bounding-box queries covering the service-area circle. Cells outside the circle are dropped. */
export function planQueryCells(center: Position, radiusM: number, cellSizeM: number): QueryCell[] {
  const latStep = cellSizeM / METERS_PER_DEGREE_LAT;
  const cosLat = Math.max(0.05, Math.cos(toRad(center.lat)));
  const lngStep = cellSizeM / (METERS_PER_DEGREE_LAT * cosLat);
  const rows = Math.ceil((2 * radiusM) / cellSizeM);
  const columns = Math.ceil((2 * radiusM) / cellSizeM);
  const startLat = center.lat - (rows / 2) * latStep;
  const startLng = center.lng - (columns / 2) * lngStep;
  const cells: QueryCell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const minLat = startLat + row * latStep;
      const maxLat = minLat + latStep;
      const minLng = startLng + column * lngStep;
      const maxLng = minLng + lngStep;
      const cellCentre = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
      const distanceFromCentreM = haversineMeters(center.lat, center.lng, cellCentre.lat, cellCentre.lng);
      // Half the cell diagonal, so a cell that only clips the circle is still queried.
      if (distanceFromCentreM > radiusM + cellSizeM * 0.71) continue;
      const height = haversineMeters(minLat, cellCentre.lng, maxLat, cellCentre.lng);
      const width = haversineMeters(cellCentre.lat, minLng, cellCentre.lat, maxLng);
      cells.push({
        cellKey: cellKey(row, column),
        minLat, maxLat, minLng, maxLng,
        center: cellCentre,
        areaKm2: (height * width) / 1_000_000,
        distanceFromCentreM: Math.round(distanceFromCentreM),
      });
    }
  }
  return cells;
}

/** Validates an area request and estimates its bounded query grid, page count, and budget duration. */
export function planAreaIngest(raw: unknown): IngestPlan {
  const request = planRequestSchema.parse(raw);
  const cells = planQueryCells(request.center, request.radiusM, request.cellSizeM);
  const areaKm2 = (Math.PI * request.radiusM ** 2) / 1_000_000;
  const density = { WIFI: 2000, CELL: 15, BLUETOOTH: 400, ...request.densityPerKm2 };
  const coveredKm2 = cells.reduce((total, cell) => total + cell.areaKm2, 0);
  const perKind = Object.fromEntries(request.kinds.map((kind) => {
    const expectedRows = Math.round(coveredKm2 * density[kind]);
    const expectedPages = Math.max(cells.length, Math.ceil(expectedRows / WIGLE_PAGE_SIZE));
    return [kind, { expectedRows, expectedPages, minimumQueries: cells.length }];
  })) as IngestPlan["estimate"]["perKind"];
  const totalQueries = Object.values(perKind).reduce((total, kind) => total + kind.expectedPages, 0);
  return {
    center: request.center,
    radiusM: request.radiusM,
    radiusMiles: Number((request.radiusM / 1609.344).toFixed(2)),
    areaKm2: Number(areaKm2.toFixed(1)),
    cellSizeM: request.cellSizeM,
    cells,
    kinds: request.kinds,
    estimate: {
      perKind,
      totalQueries,
      dailyQueryBudget: request.dailyQueryBudget,
      daysAtBudget: Math.ceil(totalQueries / request.dailyQueryBudget),
      assumptionsUnverified: [
        "Row density per square kilometre is an assumption until one properly bounded bbox query per kind reports totalResults for this area.",
        "totalResults from an unbounded query describes the whole WiGLE corpus and must not be used for capacity planning.",
        "The daily query allowance is enforced by WiGLE and has already been reached on this account at least once.",
      ],
    },
  };
}
