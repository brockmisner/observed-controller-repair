export type DevicePhase = "STATIONARY" | "NAVIGATING" | "IDLE" | "EXPIRED";
export type TransitMode = "walk" | "drive";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface PhysicsSample {
  lat: number;
  lng: number;
  altitudeM: number;
  accuracyM: number;
  speedMps: number;
  bearing: number;
  elapsedMs: number;
}

export interface DeviceTelemetryPayload {
  imageId: string;
  lat: number;
  lng: number;
  altitudeM?: number;
  accuracyM?: number;
  speedMps?: number;
  bearing?: number;
  timezone?: string;
  language?: string;
  wifi?: {
    ssid: string;
    bssid: string;
    mac: string;
  };
  sim?: {
    mcc: string;
    mnc: string;
    operator: string;
    country: string;
    msisdn?: string | null;
    msin?: string | null;
    iccid?: string | null;
    imsi?: string | null;
    apn?: string | null;
    apnType?: string | null;
  };
  station?: {
    lac: number;
    cid: number;
  };
  bluetooth?: {
    name: string;
    address: string;
  };
  bindEnvironment?: boolean;
}

export interface TelemetryJobData {
  tenantId: string;
  deviceId: string;
  imageId: string;
  bindEnvironment: boolean;
}

export interface RpaJobData {
  rpaJobId: string;
  tenantId: string;
  deviceId: string;
  imageId: string;
  templateId: string;
  templateType: 1 | 2;
  name: string;
  variables: Record<string, unknown>;
  issueAt?: string;
}

export interface DuoPlusEnvelope<T> {
  code: number;
  data: T;
  message: string;
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class KeyDeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyDeadError";
  }
}
