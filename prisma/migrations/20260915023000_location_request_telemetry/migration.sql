CREATE TABLE "LocationRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "lat" REAL NOT NULL,
    "lng" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "evidenceLevel" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" DATETIME,
    "completedAt" DATETIME,
    "acceptedAt" DATETIME,
    "observedAt" DATETIME,
    "dispatchIntervalMs" REAL,
    "queueDelayMs" REAL,
    "apiLatencyMs" REAL,
    "androidObservationJson" TEXT,
    "error" TEXT,
    CONSTRAINT "LocationRequest_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "LocationRequest_deviceId_requestedAt_idx" ON "LocationRequest"("deviceId", "requestedAt");
CREATE INDEX "LocationRequest_deviceId_dispatchedAt_idx" ON "LocationRequest"("deviceId", "dispatchedAt");
