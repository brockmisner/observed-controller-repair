ALTER TABLE "Device" ADD COLUMN "activeTripId" TEXT;

CREATE TABLE "DrivingTrip" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "routeJson" TEXT NOT NULL,
    "alternativesJson" TEXT NOT NULL DEFAULT '[]',
    "optionsJson" TEXT NOT NULL,
    "originLat" REAL NOT NULL,
    "originLng" REAL NOT NULL,
    "elapsedMs" REAL NOT NULL DEFAULT 0,
    "progressM" REAL NOT NULL DEFAULT 0,
    "durationMs" REAL NOT NULL,
    "acceptedLat" REAL,
    "acceptedLng" REAL,
    "lastRequestId" TEXT,
    "pendingElapsedMs" REAL,
    "pendingProgressM" REAL,
    "lastStepAt" DATETIME,
    "nextTickAt" DATETIME,
    "pauseReason" TEXT,
    "error" TEXT,
    "baselineJson" TEXT,
    "arrivalWifiJson" TEXT NOT NULL DEFAULT '{"enabled":false,"status":"DISABLED"}',
    "arrivalRpaJson" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "startedAt" DATETIME,
    "arrivedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DrivingTrip_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "LocationRequest" ADD COLUMN "tripId" TEXT REFERENCES "DrivingTrip" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TripToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TripToken_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DrivingTrip_tenantId_idempotencyKey_key" ON "DrivingTrip"("tenantId", "idempotencyKey");
CREATE INDEX "DrivingTrip_deviceId_createdAt_idx" ON "DrivingTrip"("deviceId", "createdAt");
CREATE INDEX "DrivingTrip_status_nextTickAt_idx" ON "DrivingTrip"("status", "nextTickAt");
CREATE UNIQUE INDEX "TripToken_tokenHash_key" ON "TripToken"("tokenHash");
CREATE INDEX "TripToken_deviceId_idx" ON "TripToken"("deviceId");
