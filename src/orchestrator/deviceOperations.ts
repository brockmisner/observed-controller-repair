import { HttpError } from "../http/errors.js";

interface DeviceOperation {
  held: boolean;
  moving: boolean;
  drained: Set<() => void>;
}

const operations = new Map<string, DeviceOperation>();
const drainTimeoutMs = 30_000;

function operationFor(deviceId: string): DeviceOperation {
  let operation = operations.get(deviceId);
  if (!operation) {
    operation = { held: false, moving: false, drained: new Set() };
    operations.set(deviceId, operation);
  }
  return operation;
}

function cleanup(deviceId: string, operation: DeviceOperation): void {
  if (!operation.held && !operation.moving && operations.get(deviceId) === operation) operations.delete(deviceId);
}

export function reserveMovement(deviceId: string): (() => void) | null {
  const operation = operationFor(deviceId);
  if (operation.held || operation.moving) return null;
  operation.moving = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    operation.moving = false;
    for (const resolve of operation.drained) resolve();
    operation.drained.clear();
    cleanup(deviceId, operation);
  };
}

export async function withEnvironmentWindow<T>(deviceId: string, work: () => Promise<T>): Promise<T> {
  const operation = operationFor(deviceId);
  if (operation.held) throw new HttpError(409, "An environment operation is already waiting for this device");
  operation.held = true;
  try {
    if (operation.moving) {
      await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          operation.drained.delete(done);
          reject(new HttpError(409, "GPS work is still in progress. No environment update was sent. Try again shortly."));
        }, drainTimeoutMs);
        operation.drained.add(done);
      });
    }
    return await work();
  } finally {
    operation.held = false;
    cleanup(deviceId, operation);
  }
}
