import { HttpError } from "../http/errors.js";

export interface DeviceWifiState {
  name: string | null;
  bssid: string | null;
  mac: string | null;
  status: 1 | 2 | null;
}

export interface SubmittedWifi {
  name: string;
  bssid: string;
  mac: string;
  status: 1 | 2;
}

export function normalizedMac(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:[a-f\d]{2}:){5}[a-f\d]{2}$/i.test(value)) return null;
  const mac = value.toLowerCase();
  return mac === "00:00:00:00:00:00" || mac === "ff:ff:ff:ff:ff:ff" ? null : mac;
}

export function readDeviceWifi(info: unknown, imageId: string): DeviceWifiState {
  const data = info as { id?: unknown; wifi?: { name?: unknown; bssid?: unknown; mac?: unknown; status?: unknown } } | null;
  if (!data || data.id !== imageId) throw new HttpError(502, "DuoPlus did not return details for the requested device");
  return {
    name: typeof data.wifi?.name === "string" ? data.wifi.name : null,
    bssid: normalizedMac(data.wifi?.bssid),
    mac: normalizedMac(data.wifi?.mac) ? data.wifi!.mac as string : null,
    status: data.wifi?.status === 1 || data.wifi?.status === 2 ? data.wifi.status : null,
  };
}

export function preservedWifiPatch(
  selected: { ssid: string; bssid: string; expectedMac?: string | null },
  current: DeviceWifiState,
): SubmittedWifi {
  if (!current.mac || !normalizedMac(current.mac)) throw new HttpError(409, "The device Wi-Fi MAC is unavailable. Refresh device details before applying.");
  if (current.status !== 1) throw new HttpError(409, "Wi-Fi is not reported as enabled. Configure the device in DuoPlus and prepare a new preview.");
  if (selected.expectedMac !== undefined && normalizedMac(selected.expectedMac) !== normalizedMac(current.mac)) {
    throw new HttpError(409, "The device Wi-Fi MAC changed after preview. Prepare a new environment.");
  }
  if (!selected.ssid.trim() || Buffer.byteLength(selected.ssid, "utf8") > 32 || /[\x00-\x1f\x7f]/.test(selected.ssid) ||
      !normalizedMac(selected.bssid) || (parseInt(selected.bssid.slice(0, 2), 16) & 1) !== 0) {
    throw new HttpError(400, "The selected Wi-Fi observation is invalid");
  }
  if (normalizedMac(selected.bssid) === normalizedMac(current.mac)) {
    throw new HttpError(409, "The selected AP BSSID matches the device Wi-Fi MAC. Prepare a different environment.");
  }
  return { status: current.status, name: selected.ssid, bssid: selected.bssid, mac: current.mac };
}

export function wifiReadbackMatches(expected: SubmittedWifi, observed: DeviceWifiState): boolean {
  return Boolean(normalizedMac(expected.mac) && normalizedMac(expected.bssid)) &&
    observed.name === expected.name && observed.status === expected.status &&
    normalizedMac(observed.bssid) === normalizedMac(expected.bssid) &&
    normalizedMac(observed.mac) === normalizedMac(expected.mac);
}
