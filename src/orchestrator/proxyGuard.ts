import { getDeviceStatus } from "../api/duoPlusClient.js";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { asnKey, lookupProxyIsp } from "../env/ispMatch.js";
import { logger } from "../logger.js";
import type { Device } from "@prisma/client";

interface InfoProxy {
  proxy?: { ip?: string };
}

export async function checkProxyOnWake(device: Device): Promise<Device> {
  if (!config.matchProxyIsp || !device.proxyAsn && !device.proxyIp) return device;
  try {
    const info = (await getDeviceStatus(device.imageId, device.tenantId)) as InfoProxy;
    const ip = info.proxy?.ip;
    if (!ip) return device;
    const hint = await lookupProxyIsp(ip, config.residentialCarrier);
    if (!hint) return device;

    const locked = asnKey(device.proxyAsn ?? "");
    const seen = asnKey(hint.asn);
    const ipChanged = Boolean(device.proxyIp && device.proxyIp !== hint.ip);
    const asnChanged = Boolean(locked && seen && locked !== seen);

    if (asnChanged || ipChanged) {
      const alert = asnChanged
        ? `ASN changed ${locked} → ${seen} (${hint.isp}). Radio lock kept.`
        : `Proxy IP changed ${device.proxyIp} → ${hint.ip}. ASN same; radio lock kept.`;
      logger.warn({ imageId: device.imageId, alert }, "proxy mismatch — not rotating cell/wifi");
      return prisma.device.update({
        where: { id: device.id },
        data: {
          proxyMismatch: true,
          proxyAlert: alert,
          lastSeenProxyIp: hint.ip,
          lastSeenProxyAsn: hint.asn,
        },
      });
    }

    if (device.proxyMismatch) {
      return prisma.device.update({
        where: { id: device.id },
        data: {
          proxyMismatch: false,
          proxyAlert: null,
          lastSeenProxyIp: hint.ip,
          lastSeenProxyAsn: hint.asn,
        },
      });
    }

    return prisma.device.update({
      where: { id: device.id },
      data: { lastSeenProxyIp: hint.ip, lastSeenProxyAsn: hint.asn },
    });
  } catch (err) {
    logger.warn({ err, imageId: device.imageId }, "proxy guard skipped");
    return device;
  }
}
