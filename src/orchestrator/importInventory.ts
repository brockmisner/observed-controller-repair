import { getDeviceStatus } from "../api/duoPlusClient.js";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { bluetoothProfile } from "../env/bluetooth.js";
import { lookupProxyIsp } from "../env/ispMatch.js";
import { carrierByName } from "../env/carriers.js";
import { carrierForUnknownIsp, simIdentifiers } from "../env/sim.js";
import { resolveWigleCell } from "../env/wigle.js";
import { logger } from "../logger.js";
import { registerDevice } from "./registry.js";

const attemptsByTenant = new Map<string, Map<string, number>>();
let attemptSequence = 0;

export function isExpiredStatus(status: number | null | undefined): boolean {
  return status === 3 || status === 4;
}

interface RemotePhone {
  id?: string;
  image_id?: string;
  name?: string;
  status?: number;
  gps?: { latitude?: number; longitude?: number; lat?: number; lng?: number };
  latitude?: number;
  longitude?: number;
  proxy?: { ip?: string; country?: string; region?: string; city?: string; isp?: string };
}

function imageIdOf(row: RemotePhone): string | null {
  return row.id ?? row.image_id ?? null;
}

function coordsOf(row: RemotePhone): { lat: number; lng: number } | null {
  const rawLat: unknown = row.gps?.latitude ?? row.gps?.lat ?? row.latitude;
  const rawLng: unknown = row.gps?.longitude ?? row.gps?.lng ?? row.longitude;
  if (![rawLat, rawLng].every((value) =>
    typeof value === "number" || typeof value === "string" && value.trim() !== "")) return null;
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

export async function importRemotePhones(
  tenantId: string,
  remote: RemotePhone[],
): Promise<{ imported: number; skippedExpired: number }> {
  if (!config.autoImportDevices) return { imported: 0, skippedExpired: 0 };

  let imported = 0;
  let skippedExpired = 0;
  let budget = config.autoImportPerPulse;
  const imageIds = remote.map(imageIdOf).filter((id): id is string => Boolean(id));
  const currentImageIds = new Set(imageIds);
  const attempts = attemptsByTenant.get(tenantId) ?? new Map<string, number>();
  for (const id of attempts.keys()) {
    if (!currentImageIds.has(id)) attempts.delete(id);
  }
  if (imageIds.length > 0) attemptsByTenant.set(tenantId, attempts);
  else attemptsByTenant.delete(tenantId);
  const devices = await prisma.device.findMany({
    where: { tenantId, imageId: { in: imageIds } },
  });
  const existingByImage = new Map(devices.map((device) => [device.imageId, device]));
  const priority = (row: RemotePhone) => {
    if (row.status !== 1) return 3;
    if (existingByImage.has(imageIdOf(row) ?? "")) return 2;
    return coordsOf(row) ? 0 : 1;
  };
  const ordered = [...remote].sort((a, b) => priority(a) - priority(b) ||
    (attempts.get(imageIdOf(a) ?? "") ?? 0) - (attempts.get(imageIdOf(b) ?? "") ?? 0));

  async function importPhone(row: RemotePhone): Promise<void> {
    const imageId = imageIdOf(row);
    if (!imageId) return;

    if (isExpiredStatus(row.status)) {
      skippedExpired += 1;
      await prisma.device.updateMany({
        // This inventory batch may predate a newer ON observation.
        where: { tenantId, imageId, duoPlusStatus: row.status, poweredOn: false },
        data: { active: false, phase: "EXPIRED", poweredOn: false },
      });
      return;
    }

    const existing = existingByImage.get(imageId);
    if (existing) {
      if (row.name && row.name !== existing.name) {
        await prisma.device.update({ where: { id: existing.id }, data: { name: row.name } });
      }
      if (!existing.bluetoothAddress || !existing.imsi || !existing.iccid || !existing.apn) {
        const bt = bluetoothProfile(imageId);
        const sim = simIdentifiers(imageId, carrierByName(existing.mnc));
        await prisma.device.update({
          where: { id: existing.id },
          data: {
            ...(existing.bluetoothAddress
              ? {}
              : { bluetoothName: bt.name, bluetoothAddress: bt.address }),
            imsi: existing.imsi ?? sim.imsi,
            iccid: existing.iccid ?? sim.iccid,
            msin: existing.msin ?? sim.msin,
            apn: existing.apn ?? carrierByName(existing.mnc).apn,
            apnType: existing.apnType ?? carrierByName(existing.mnc).apnType,
          },
        });
      }
      if (!existing.proxyIsp && budget > 0 && config.matchProxyIsp) {
        attempts.set(imageId, ++attemptSequence);
        budget -= 1;
        try {
          const info = (await getDeviceStatus(imageId, tenantId)) as RemotePhone;
          const hint = info.proxy?.ip
            ? await lookupProxyIsp(info.proxy.ip, config.residentialCarrier)
            : null;
          if (hint) {
            const tower = await resolveWigleCell(
              existing.anchorLat,
              existing.anchorLng,
              hint.carrier.mcc,
              hint.carrier.mnc,
              tenantId,
            );
            await prisma.device.update({
              where: { id: existing.id },
              data: {
                mcc: hint.carrier.mcc,
                mnc: hint.carrier.mnc,
                operator: hint.carrier.operator,
                proxyIp: hint.ip,
                proxyIsp: hint.isp,
                proxyAsn: hint.asn,
                proxyKind: hint.kind,
                timezone: hint.timezone,
                language: hint.language,
                ...(tower
                  ? { lac: tower.lac, cid: tower.cid, cellRadio: tower.radio, wigleCellQueriedAt: new Date() }
                  : {}),
              },
            });
            logger.info({ imageId, carrier: hint.carrier.name, isp: hint.isp }, "backfilled ISP + cell lock");
          }
        } catch (err) {
          logger.warn({ err, imageId }, "ISP backfill skipped");
        }
      }
      return;
    }

    if (budget <= 0) return;
    attempts.set(imageId, ++attemptSequence);
    budget -= 1;

    let info: RemotePhone = row;
    let pin = coordsOf(row);
    try {
      info = ((await getDeviceStatus(imageId, tenantId)) as RemotePhone) ?? row;
      pin = coordsOf(info) ?? pin;
    } catch (err) {
      logger.warn({ err, imageId }, "info lookup failed during import");
    }
    if (!pin) {
      logger.warn({ imageId }, "skip import — no GPS on DuoPlus record; set a pin later");
      return;
    }

    const proxyIp = info.proxy?.ip ?? "";
    let carrierName = config.residentialCarrier;
    let proxyIsp = info.proxy?.isp ?? "";
    let proxyAsn = "";
    let proxyKind = "unknown";
    let tz = "America/New_York";
    let lang = "en-US";
    if (config.matchProxyIsp && proxyIp) {
      const hint = await lookupProxyIsp(proxyIp, config.residentialCarrier);
      if (hint) {
        proxyIsp = hint.isp;
        proxyAsn = hint.asn;
        proxyKind = hint.kind;
        tz = hint.timezone;
        lang = hint.language;
        carrierName =
          hint.normalize === "geo" || hint.kind === "unknown"
            ? carrierForUnknownIsp(pin.lat, pin.lng).name
            : hint.carrier.name;
      } else {
        carrierName = carrierForUnknownIsp(pin.lat, pin.lng).name;
      }
    } else {
      carrierName = carrierForUnknownIsp(pin.lat, pin.lng).name;
    }

    const registered = await registerDevice({
      tenantId,
      imageId,
      name: row.name ?? imageId,
      anchorLat: pin.lat,
      anchorLng: pin.lng,
      lookupWigle: true,
      carrier: carrierName,
      campaignDays: 365,
      proxyIp,
      proxyIsp,
      proxyAsn,
      proxyKind,
      timezone: tz,
      language: lang,
    });
    existingByImage.set(imageId, registered);
    imported += 1;
    logger.info(
      { imageId, name: row.name, carrier: carrierName, proxyIsp, proxyKind, timezone: tz, lat: pin.lat, lng: pin.lng },
      "auto-imported DuoPlus phone",
    );
  }

  for (const row of ordered) {
    try {
      await importPhone(row);
    } catch (err) {
      logger.warn({ err, tenantId, imageId: imageIdOf(row) }, "phone import skipped");
    }
  }

  return { imported, skippedExpired };
}
