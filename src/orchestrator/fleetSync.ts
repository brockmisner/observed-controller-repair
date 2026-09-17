import { syncFolders } from "./folders.js";
import { listCloudPhones } from "../api/duoPlusClient.js";
import { tenantKeyCount } from "../api/tenantKeys.js";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { recordDeviceEvent } from "../ops/events.js";
import { dropSidecar } from "./sidecar.js";

export const DUOPLUS_STATUS = {
  UNCONFIGURED: 0,
  POWERED_ON: 1,
  POWERED_OFF: 2,
  EXPIRED: 3,
  EXPIRED_RENEW: 4,
  POWERING_ON: 10,
  CONFIGURING: 11,
  CONFIG_FAILED: 12,
} as const;

export function isPoweredOn(status: number | null | undefined): boolean {
  return status === DUOPLUS_STATUS.POWERED_ON;
}

function observedStatus(value: unknown): number | null {
  return typeof value === "number" && Object.values(DUOPLUS_STATUS).some((status) => status === value) ? value : null;
}

function isActualOff(status: number | null): boolean {
  return status === DUOPLUS_STATUS.POWERED_OFF || status === DUOPLUS_STATUS.EXPIRED || status === DUOPLUS_STATUS.EXPIRED_RENEW;
}

export function statusLabel(status: number | null | undefined): string {
  switch (status) {
    case 0:
      return "unconfigured";
    case 1:
      return "on";
    case 2:
      return "off";
    case 3:
      return "expired";
    case 4:
      return "renew";
    case 10:
      return "booting";
    case 11:
      return "configuring";
    case 12:
      return "config-fail";
    default:
      return "unknown";
  }
}

interface CloudPhoneRow {
  id?: string;
  image_id?: string;
  name?: string;
  status?: number;
}

interface CloudPhoneListData {
  list?: CloudPhoneRow[];
  total_page?: number;
}

export interface DiscoveredDevice {
  imageId: string;
  name?: string;
  status: 1;
}

function createRuntime() {
  return {
    lastSyncAt: null as Date | null,
    lastError: null as string | null,
    poweredOn: 0,
    tracked: 0,
    nextSyncMs: config.fleetPulseMs,
    onlineDevices: [] as DiscoveredDevice[],
    darkMsToday: 0,
    darkDay: "",
    lastPulseAt: null as Date | null,
  };
}

export const fleetRuntime = createRuntime();
const tenantRuntimes = new Map<string, ReturnType<typeof createRuntime>>();
type SyncResult = { poweredOn: number; tracked: number };
const syncingTenants = new Map<string | undefined, Promise<SyncResult>>();
const backgroundWork = new Map<string | undefined, Promise<void>>();

export function getFleetRuntime(tenantId?: string) {
  if (!tenantId) return fleetRuntime;
  let runtime = tenantRuntimes.get(tenantId);
  if (!runtime) {
    runtime = createRuntime();
    tenantRuntimes.set(tenantId, runtime);
  }
  return runtime;
}

function updateAggregate(): SyncResult {
  const runtimes = [...tenantRuntimes.values()];
  fleetRuntime.poweredOn = runtimes.reduce((sum, runtime) => sum + runtime.poweredOn, 0);
  fleetRuntime.tracked = runtimes.reduce((sum, runtime) => sum + runtime.tracked, 0);
  fleetRuntime.lastError = runtimes.some((runtime) => runtime.lastError) ? "A workspace fleet sync failed" : null;
  fleetRuntime.nextSyncMs = config.fleetPulseMs;
  return { poweredOn: fleetRuntime.poweredOn, tracked: fleetRuntime.tracked };
}

export async function fetchAllCloudPhones(tenantId?: string): Promise<CloudPhoneRow[]> {
  const rows: CloudPhoneRow[] = [];
  let page = 1;
  let expectedPages: number | undefined;
  const pagesize = 100;
  for (;;) {
    const data = (await listCloudPhones(page, pagesize, tenantId)) as CloudPhoneListData;
    if (!data || !Array.isArray(data.list) || data.list.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error("DuoPlus returned an invalid fleet page");
    }
    const batch = data.list;
    const totalPages = data.total_page ?? 1;
    if (!Number.isInteger(totalPages) || totalPages < 0 || (totalPages === 0 && batch.length > 0) ||
        (expectedPages !== undefined && expectedPages !== totalPages) || (totalPages > 1 && batch.length === 0)) {
      throw new Error("DuoPlus returned incomplete fleet pagination");
    }
    expectedPages = totalPages;
    rows.push(...batch);
    if (page >= totalPages) break;
    page += 1;
  }
  return rows;
}

export function syncPowerState(tenantId?: string): Promise<SyncResult> {
  if (tenantId) return syncTenantOnce(tenantId);
  return syncAllTenants();
}

async function syncAllTenants(): Promise<SyncResult> {
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  const tenantIds = new Set(tenants.map((tenant) => tenant.id));
  for (const id of tenantRuntimes.keys()) {
    if (!tenantIds.has(id)) tenantRuntimes.delete(id);
  }
  if (tenants.length === 0 && !config.authRequired && config.apiKeys.length > 0) {
    return syncTenantOnce(undefined);
  }
  await Promise.all(tenants.map(async (tenant) => {
    try {
      await syncTenantOnce(tenant.id);
    } catch (err) {
      logger.warn({ tenantId: tenant.id, err }, "tenant fleet sync skipped");
    }
  }));
  fleetRuntime.lastSyncAt = new Date();
  return updateAggregate();
}

function syncTenantOnce(tenantId?: string): Promise<SyncResult> {
  const running = syncingTenants.get(tenantId);
  if (running) return running;
  const runtime = getFleetRuntime(tenantId);
  const task = (async () => {
    if (tenantId && await tenantKeyCount(tenantId) === 0) {
      runtime.poweredOn = 0;
      runtime.onlineDevices = [];
      runtime.tracked = await prisma.device.count({ where: { tenantId } });
      runtime.lastError = null;
      updateAggregate();
      return { poweredOn: 0, tracked: runtime.tracked };
    }
    try {
      return await syncPowerStateForTenant(tenantId);
    } catch (error) {
      runtime.lastError = error instanceof Error ? error.message : "Fleet sync failed";
      if (tenantId) updateAggregate();
      throw error;
    }
  })().finally(() => { syncingTenants.delete(tenantId); });
  syncingTenants.set(tenantId, task);
  return task;
}

async function syncPowerStateForTenant(tenantId?: string): Promise<{ poweredOn: number; tracked: number }> {
  const scanStartedAt = new Date();
  const remote = await fetchAllCloudPhones(tenantId);
  if (tenantId) await syncFolders(tenantId, remote).catch(() => logger.warn({ tenantId }, "Folder sync failed; saved inventory retained"));
  const byId = new Map<string, CloudPhoneRow>();
  for (const row of remote) {
    const id = row.id ?? row.image_id;
    if (id) byId.set(id, row);
  }

  const runtime = getFleetRuntime(tenantId);
  runtime.onlineDevices = [...byId.entries()]
    .filter(([, row]) => isPoweredOn(row.status))
    .map(([imageId, row]) => ({ imageId, name: row.name, status: 1 }));

  const devices = await prisma.device.findMany({
    where: tenantId ? { tenantId } : undefined,
  });
  let poweredOn = 0;
  for (const device of devices) {
    const row = byId.get(device.imageId);
    const status = observedStatus(row?.status);
    const on = isPoweredOn(status);
    const wasOn = device.poweredOn;
    const written = await prisma.device.updateMany({
      where: { id: device.id, tenantId, OR: [{ lastPowerSyncAt: null }, { lastPowerSyncAt: { lte: scanStartedAt } }] },
      data: {
        duoPlusStatus: status,
        poweredOn: status === null ? wasOn : on,
        lastPowerSyncAt: scanStartedAt,
        ...(on ? { lastSeenOnAt: scanStartedAt } : {}),
      },
    });
    const updated = await prisma.device.findFirst({ where: { id: device.id, tenantId } });
    if (!updated) continue;
    if (updated.poweredOn && isPoweredOn(updated.duoPlusStatus)) poweredOn += 1;
    // A newer manual observation can finish while this inventory request waits.
    if (!written.count || updated.lastPowerSyncAt?.getTime() !== scanStartedAt.getTime() || updated.duoPlusStatus !== status) continue;
    if (device.duoPlusStatus !== status) {
      logger.info({ tenantId, imageId: device.imageId, previousStatus: device.duoPlusStatus, status }, "DuoPlus fleet status transition");
    }
    // Inventory is observational. Returning from a provider configuration is not a new boot.
    if (on && !wasOn) {
      const lastPowerEvent = await prisma.deviceEvent.findFirst({
        where: { deviceId: device.id, kind: { in: ["ON", "OFF"] } }, orderBy: { createdAt: "desc" },
      });
      if (isActualOff(device.duoPlusStatus) || !device.lastSeenOnAt || lastPowerEvent?.kind === "OFF") {
        await recordDeviceEvent(device.id, "ON");
      }
    }
    if (isActualOff(status)) {
      dropSidecar(device.id);
      if (wasOn || (!isActualOff(device.duoPlusStatus) && device.lastSeenOnAt)) {
        await recordDeviceEvent(device.id, "OFF");
        logger.info({ imageId: device.imageId }, "sidecar dropped — device off");
      }
    }
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (runtime.darkDay !== day) {
    runtime.darkDay = day;
    runtime.darkMsToday = 0;
  }
  if (runtime.lastPulseAt && poweredOn === 0) {
    runtime.darkMsToday += now.getTime() - Math.max(runtime.lastPulseAt.getTime(), Date.parse(`${day}T00:00:00Z`));
  }
  runtime.lastPulseAt = now;
  runtime.lastSyncAt = now;
  runtime.lastError = null;
  runtime.poweredOn = poweredOn;
  runtime.tracked = devices.length;
  runtime.nextSyncMs = config.fleetPulseMs;
  if (tenantId) updateAggregate();

  logger.info(
    {
      tenantId,
      poweredOn,
      tracked: devices.length,
      remote: remote.length,
      discoveredOn: runtime.onlineDevices.length,
      nextSyncMs: runtime.nextSyncMs,
    },
    "fleet power sync",
  );
  queueBackgroundWork(tenantId, remote);
  return { poweredOn, tracked: devices.length };
}

function queueBackgroundWork(tenantId: string | undefined, remote: CloudPhoneRow[]): void {
  if (backgroundWork.has(tenantId)) return;
  // Importing local inventory and reading provider info must not hold the scan open.
  const work = (async () => {
    if (tenantId && config.autoImportDevices) {
      const { importRemotePhones } = await import("./importInventory.js");
      const imported = await importRemotePhones(tenantId, remote);
      if (imported.imported || imported.skippedExpired) {
        logger.info({ tenantId, ...imported }, "inventory import");
      }
    }
  })().catch((err) => {
    logger.warn({ tenantId, err }, "fleet setup deferred");
  }).finally(() => { backgroundWork.delete(tenantId); });
  backgroundWork.set(tenantId, work);
}

export function startFleetSync(): { stop: () => void } {
  let stopped = false;

  const run = async () => {
    if (stopped) return;
    try {
      await syncPowerState();
    } catch (err) {
      fleetRuntime.lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ err: fleetRuntime.lastError }, "fleet power sync failed");
      fleetRuntime.nextSyncMs = config.fleetPulseMs;
    }
  };

  logger.info({ intervalMs: config.fleetPulseMs, onStatus: DUOPLUS_STATUS.POWERED_ON }, "fleet discovery polling started");
  const timer = setInterval(() => void run(), config.fleetPulseMs);
  void run();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
