import "dotenv/config";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number env: ${name}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

const fleetPulseMs = num("FLEET_PULSE_MS", 60_000);

export const config = {
  production: process.env.NODE_ENV === "production",
  duoPlusBaseUrl: req("DUOPLUS_BASE_URL", "https://openapi.duoplus.net").replace(/\/$/, ""),
  apiKeys: (process.env.DUOPLUS_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k && k !== "CHANGE_ME"),
  lang: req("DUOPLUS_LANG", "en"),
  redisUrl: process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || "",
  redisHost: req("REDIS_HOST", "127.0.0.1"),
  redisPort: num("REDIS_PORT", 6379),
  redisPassword: process.env.REDIS_PASSWORD || undefined,
  databaseUrl: req("DATABASE_URL", "file:../data/observatory.db"),
  httpPort: Number(process.env.PORT || process.env.HTTP_PORT || 8787),
  logLevel: req("LOG_LEVEL", "info"),
  dryRun: bool("DRY_RUN", false),
  // Compatibility field for snapshots; the documented API supports coordinates only.
  sendExtendedGps: false,
  stationaryTickMinMs: num("STATIONARY_TICK_MIN_MS", 5000),
  stationaryTickMaxMs: num("STATIONARY_TICK_MAX_MS", 10000),
  navTickMinMs: num("NAV_TICK_MIN_MS", 5000),
  navTickMaxMs: num("NAV_TICK_MAX_MS", 8000),
  driftMinM: num("STATIONARY_DRIFT_MIN_M", 0.5),
  driftMaxM: num("STATIONARY_DRIFT_MAX_M", 1.5),
  stationaryMaxSpeedMps: num("STATIONARY_MAX_SPEED_MPS", 0.8),
  boundM: num("STATIONARY_BOUND_M", 15),
  restorativePull: num("RESTORATIVE_PULL", 0.2),
  walkSpeedMps: num("WALK_SPEED_MPS", 1.2),
  driveMinMps: num("DRIVE_SPEED_MIN_MPS", 6.7),
  driveMaxMps: num("DRIVE_SPEED_MAX_MPS", 13.4),
  defaultCampaignDays: num("DEFAULT_CAMPAIGN_DAYS", 30),
  wigleApiName: process.env.WIGLE_API_NAME?.trim() ?? "",
  wigleApiToken: process.env.WIGLE_API_TOKEN?.trim() ?? "",
  wigleRadiusM: num("WIGLE_SEARCH_RADIUS_M", 120),
  wigleClusterSize: num("WIGLE_CLUSTER_SIZE", 3),
  wigleAutoOnRegister: bool("WIGLE_AUTO_ON_REGISTER", true),
  telemetryOnlyWhenPowered: bool("TELEMETRY_ONLY_WHEN_POWERED", true),
  fleetPulseMs,
  powerStatusMaxAgeMs: fleetPulseMs + 15_000,
  jitterMs: num("JITTER_MS", 7_000),
  autoImportDevices: bool("AUTO_IMPORT_DEVICES", true),
  autoImportPerPulse: num("AUTO_IMPORT_PER_PULSE", 2),
  matchProxyIsp: bool("MATCH_PROXY_ISP", true),
  residentialCarrier: process.env.RESIDENTIAL_CARRIER?.trim() || "T-Mobile",
  wigleCellRadiusM: num("WIGLE_CELL_RADIUS_M", 2500),
  authSecret: process.env.AUTH_SECRET?.trim() || "dev-auth-secret-change-me",
  encryptionKey: process.env.ENCRYPTION_KEY?.trim() || "",
  signupsOpen: bool("SIGNUPS_OPEN", true),
  authRequired: bool("AUTH_REQUIRED", true),
  /** B06. LOCAL_SCHEDULE (recommended) or DELIVERED. Not signed off; selectable rather than hard-wired. */
  radioScheduleMode: process.env.DUOMOVE_RADIO_SCHEDULE_MODE?.trim() || "LOCAL_SCHEDULE",
};

if (config.production) {
  if (!config.authRequired) throw new Error("AUTH_REQUIRED must be true in production");
  for (const [name, value] of [["AUTH_SECRET", config.authSecret], ["ENCRYPTION_KEY", config.encryptionKey]]) {
    if (!value || value.length < 32 || /change.?me|placeholder/i.test(value)) {
      throw new Error(`${name} must contain at least 32 random characters in production`);
    }
  }
  if (config.authSecret === config.encryptionKey) {
    throw new Error("AUTH_SECRET and ENCRYPTION_KEY must be different");
  }
}

