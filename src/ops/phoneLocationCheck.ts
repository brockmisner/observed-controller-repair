import type { PhoneLocationObservation } from "../api/phoneNavigation.js";
import { HttpError } from "../http/errors.js";

interface Phone {
  id: string;
  imageId: string;
  tenantId: string;
  activeTripId: string | null;
  active: boolean;
  phase: string;
  poweredOn: boolean;
  duoPlusStatus: number | null;
  lastPowerSyncAt: Date | string | null;
}
interface Dependencies {
  getDevice: (id: string, tenantId: string) => Promise<Phone | null>;
  observe: (imageId: string, tenantId: string, beforeSend: () => Promise<void>) => Promise<PhoneLocationObservation>;
  now?: () => number;
  powerMaxAgeMs: number;
}

/** Read-only diagnostic. It never updates the model or promotes a trip's GPS acceptance. */
export async function checkPhoneLocation(deviceId: string, tenantId: string, dependencies: Dependencies) {
  const current = async (expectedImageId?: string): Promise<Phone> => {
    const phone = await dependencies.getDevice(deviceId, tenantId);
    if (!tenantId || !phone || phone.id !== deviceId || phone.tenantId !== tenantId ||
        expectedImageId && phone.imageId !== expectedImageId) throw new HttpError(404, "Device not found");
    if (phone.activeTripId) throw new HttpError(409, "Use the Driving panel's phone readback while a trip owns this phone.");
    if (phone.active && phone.phase === "NAVIGATING") throw new HttpError(409, "Pause movement before checking phone GPS.");
    const now = (dependencies.now ?? Date.now)();
    const checkedAt = phone.lastPowerSyncAt === null ? NaN : new Date(phone.lastPowerSyncAt).getTime();
    if (!phone.poweredOn || phone.duoPlusStatus !== 1 || !Number.isFinite(checkedAt) || checkedAt > now ||
        now - checkedAt > dependencies.powerMaxAgeMs) {
      throw new HttpError(409, "Check power first. The phone must be freshly confirmed ON.");
    }
    return phone;
  };
  const phone = await current();
  const observation = await dependencies.observe(phone.imageId, tenantId, async () => { await current(phone.imageId); });
  return { deviceId, observation };
}
