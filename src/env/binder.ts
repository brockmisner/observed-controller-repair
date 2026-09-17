import type { Device } from "@prisma/client";
import type { DeviceTelemetryPayload } from "../types.js";

export function assertWifiLock(device: Device, incoming?: DeviceTelemetryPayload["wifi"]): void {
  if (!device.wifiLocked) return;
  if (!incoming) return;
  const same =
    incoming.bssid.toLowerCase() === device.wifiBssid.toLowerCase() &&
    incoming.ssid === device.wifiSsid;
  if (!same) {
    throw new Error(
      `Zero-leak violation: refused BSSID rotation on ${device.imageId} (${device.wifiBssid} → ${incoming.bssid})`,
    );
  }
}

export function hardwareFromDevice(device: Device): Pick<
  DeviceTelemetryPayload,
  "wifi" | "sim" | "station" | "bluetooth" | "timezone" | "language"
> {
  return {
    timezone: device.timezone,
    language: device.language,
    wifi: {
      ssid: device.wifiSsid,
      bssid: device.wifiBssid,
      mac: device.wifiMac,
    },
    sim: {
      mcc: device.mcc,
      mnc: device.mnc,
      operator: device.operator,
      country: device.simCountry,
      msisdn: device.msisdn,
      msin: device.msin,
      iccid: device.iccid,
      imsi: device.imsi,
      apn: device.apn,
      apnType: device.apnType,
    },
    station: {
      lac: device.lac,
      cid: device.cid,
    },
    ...(device.bluetoothName && device.bluetoothAddress
      ? { bluetooth: { name: device.bluetoothName, address: device.bluetoothAddress } }
      : {}),
  };
}
