import axios from "axios";
import { logger } from "../logger.js";
import type { LatLng } from "../types.js";

const OSRM = process.env.OSRM_URL?.trim() || "https://router.project-osrm.org";

export async function routePolyline(
  origin: LatLng,
  dest: LatLng,
  profile: "foot" | "driving" = "foot",
): Promise<LatLng[]> {
  const url = `${OSRM.replace(/\/$/, "")}/route/v1/${profile}/${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
  try {
    const { data } = await axios.get(url, {
      timeout: 12_000,
      params: { overview: "full", geometries: "geojson" },
    });
    const coords = data?.routes?.[0]?.geometry?.coordinates as [number, number][] | undefined;
    if (!coords?.length) throw new Error("OSRM returned no geometry");
    return coords.map(([lng, lat]) => ({ lat, lng }));
  } catch (err) {
    logger.warn({ err, origin, dest }, "OSRM route failed — using straight line");
    return [origin, dest];
  }
}
