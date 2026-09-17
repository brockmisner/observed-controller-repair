import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

const date = z.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)));
const network = z.object({
  ssid: z.string().min(1).max(100),
  bssid: z.string().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  qos: z.number().int().min(0).max(7),
  distanceM: z.number().finite().nonnegative(),
  channel: z.number().int().optional(),
  encryption: z.string().max(100).optional(),
  lastupdt: date.optional(),
}).strict();
const clusterSchema = z.object({
  primary: network, nearby: z.array(network).min(1).max(100),
  queriedAt: date, radiusM: z.number().finite().positive().max(100_000),
}).strict();
const bundleSchema = z.object({
  version: z.literal(1),
  records: z.array(z.object({
    imageId: z.string().min(1).max(100), name: z.string().max(200),
    wifiClusterJson: z.string().min(1).max(250_000), wigleQueriedAt: date,
  }).strict()).min(1).max(100),
}).strict();

export function parseSavedWigleImport(input: unknown) {
  const bundle = bundleSchema.parse(input);
  const ids = new Set<string>();
  return bundle.records.map((record) => {
    if (ids.has(record.imageId)) throw new Error("Duplicate device in saved WiGLE import");
    ids.add(record.imageId);
    const cluster = clusterSchema.parse(JSON.parse(record.wifiClusterJson));
    const queriedAt = new Date(record.wigleQueriedAt);
    if (queriedAt.getTime() !== Date.parse(cluster.queriedAt) || queriedAt.getTime() > Date.now()) {
      throw new Error("Saved WiGLE query timestamps must agree and cannot be in the future");
    }
    const seen = new Map<string, string>();
    for (const ap of [cluster.primary, ...cluster.nearby]) {
      const key = ap.bssid.toLowerCase();
      const value = JSON.stringify({ ...ap, bssid: key });
      if (seen.has(key) && seen.get(key) !== value) throw new Error("Conflicting saved WiGLE AP records");
      seen.set(key, value);
    }
    if (!cluster.nearby.some((ap) => ap.bssid.toLowerCase() === cluster.primary.bssid.toLowerCase())) {
      throw new Error("The saved primary AP must be included in the cluster");
    }
    return { ...record, cluster, queriedAt, apCount: seen.size };
  });
}

export async function importSavedWigle(prisma: PrismaClient, input: unknown, apply = false) {
  const records = parseSavedWigleImport(input);
  return prisma.$transaction(async (tx) => {
    const devices = await tx.device.findMany({
      where: { imageId: { in: records.map((row) => row.imageId) } },
      select: { id: true, tenantId: true, imageId: true, name: true },
    });
    // Never fall back to the first workspace or import partial matches across tenants.
    const tenants = [...new Set(devices.map((device) => device.tenantId))].filter((tenantId) =>
      records.every((record) => devices.some((device) => device.tenantId === tenantId && device.imageId === record.imageId)));
    if (tenants.length !== 1) throw new Error("Saved WiGLE import requires exactly one workspace containing every source device; nothing imported");
    const tenantId = tenants[0]!;
    const results = [];
    for (const record of records) {
      const device = devices.find((row) => row.tenantId === tenantId && row.imageId === record.imageId)!;
      const sha256 = createHash("sha256").update(record.wifiClusterJson).digest("hex");
      const where = { deviceId_sha256: { deviceId: device.id, sha256 } };
      let saved = await tx.deviceWigleArchive.findUnique({ where });
      let status = saved ? "already_saved" : "would_import";
      if (!saved && apply) {
        saved = await tx.deviceWigleArchive.create({ data: {
          deviceId: device.id, sha256, clusterJson: record.wifiClusterJson,
          queriedAt: record.queriedAt, source: "LOCAL_IMPORT",
        } });
        status = "imported";
      }
      if (apply) saved = await tx.deviceWigleArchive.findUniqueOrThrow({ where });
      if (saved && (saved.clusterJson !== record.wifiClusterJson || saved.queriedAt.getTime() !== record.queriedAt.getTime())) {
        throw new Error("Saved WiGLE readback did not match; transaction rolled back");
      }
      results.push({ imageId: record.imageId, name: device.name, status,
        sourceSsid: record.cluster.primary.ssid, sourceApCount: record.apCount,
        sourceQueriedAt: record.queriedAt.toISOString(),
        savedSha256: saved ? createHash("sha256").update(saved.clusterJson).digest("hex") : null,
      });
    }
    return { event: "saved_wigle_archive_import", mode: apply ? "apply" : "dry_run", results };
  });
}
