-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantWigleCredential" (
    "tenantId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "apiNameLast4" TEXT NOT NULL,
    "apiTokenLast4" TEXT NOT NULL,
    "lastValidatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantWigleCredential_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "dead" BOOLEAN NOT NULL DEFAULT false,
    "congestedUntil" TIMESTAMP(3),
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "poweredOn" BOOLEAN NOT NULL DEFAULT false,
    "duoPlusStatus" INTEGER,
    "lastPowerSyncAt" TIMESTAMP(3),
    "lastSeenOnAt" TIMESTAMP(3),
    "phase" TEXT NOT NULL DEFAULT 'STATIONARY',
    "activeTripId" TEXT,
    "campaignStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "campaignEnd" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "language" TEXT NOT NULL DEFAULT 'en-US',
    "anchorLat" DOUBLE PRECISION NOT NULL,
    "anchorLng" DOUBLE PRECISION NOT NULL,
    "movementRadiusM" INTEGER NOT NULL DEFAULT 15,
    "currentLat" DOUBLE PRECISION NOT NULL,
    "currentLng" DOUBLE PRECISION NOT NULL,
    "groundElevationM" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "lastAltitudeM" DOUBLE PRECISION NOT NULL DEFAULT 21.5,
    "lastBearing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastSpeedMps" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "lastAccuracyM" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "lastTickAt" TIMESTAMP(3),
    "wifiSsid" TEXT NOT NULL,
    "wifiBssid" TEXT NOT NULL,
    "wifiMac" TEXT NOT NULL,
    "wifiLocked" BOOLEAN NOT NULL DEFAULT true,
    "wifiClusterJson" TEXT,
    "wigleQueriedAt" TIMESTAMP(3),
    "mcc" TEXT NOT NULL DEFAULT '310',
    "mnc" TEXT NOT NULL DEFAULT '260',
    "operator" TEXT NOT NULL DEFAULT 'T-Mobile USA',
    "simCountry" TEXT NOT NULL DEFAULT 'US',
    "msisdn" TEXT,
    "msin" TEXT,
    "iccid" TEXT,
    "imsi" TEXT,
    "apn" TEXT,
    "apnType" TEXT,
    "lac" INTEGER NOT NULL DEFAULT 12001,
    "cid" INTEGER NOT NULL DEFAULT 44821,
    "carrierLocked" BOOLEAN NOT NULL DEFAULT true,
    "proxyIp" TEXT,
    "proxyIsp" TEXT,
    "proxyAsn" TEXT,
    "proxyKind" TEXT,
    "proxyMismatch" BOOLEAN NOT NULL DEFAULT false,
    "proxyAlert" TEXT,
    "lastSeenProxyIp" TEXT,
    "lastSeenProxyAsn" TEXT,
    "cellRadio" TEXT NOT NULL DEFAULT 'LTE',
    "cellLocked" BOOLEAN NOT NULL DEFAULT true,
    "wigleCellQueriedAt" TIMESTAMP(3),
    "bluetoothName" TEXT,
    "bluetoothAddress" TEXT,
    "transitMode" TEXT,
    "targetLat" DOUBLE PRECISION,
    "targetLng" DOUBLE PRECISION,
    "polylineJson" TEXT,
    "routeIndex" INTEGER NOT NULL DEFAULT 0,
    "routeProgressM" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceWigleArchive" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "clusterJson" TEXT NOT NULL,
    "queriedAt" TIMESTAMP(3) NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'LOCAL_IMPORT',

    CONSTRAINT "DeviceWigleArchive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationRequest" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "evidenceLevel" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3),
    "dispatchIntervalMs" DOUBLE PRECISION,
    "queueDelayMs" DOUBLE PRECISION,
    "apiLatencyMs" DOUBLE PRECISION,
    "androidObservationJson" TEXT,
    "error" TEXT,
    "rejectionReason" TEXT,
    "tripId" TEXT,

    CONSTRAINT "LocationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DrivingTrip" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "routeJson" TEXT NOT NULL,
    "alternativesJson" TEXT NOT NULL DEFAULT '[]',
    "optionsJson" TEXT NOT NULL,
    "originLat" DOUBLE PRECISION NOT NULL,
    "originLng" DOUBLE PRECISION NOT NULL,
    "elapsedMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "progressM" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMs" DOUBLE PRECISION NOT NULL,
    "acceptedLat" DOUBLE PRECISION,
    "acceptedLng" DOUBLE PRECISION,
    "lastRequestId" TEXT,
    "pendingElapsedMs" DOUBLE PRECISION,
    "pendingProgressM" DOUBLE PRECISION,
    "gpsRetryCount" INTEGER NOT NULL DEFAULT 0,
    "lastStepAt" TIMESTAMP(3),
    "nextTickAt" TIMESTAMP(3),
    "pauseReason" TEXT,
    "error" TEXT,
    "baselineJson" TEXT,
    "arrivalWifiJson" TEXT NOT NULL DEFAULT '{"enabled":false,"status":"DISABLED"}',
    "arrivalRpaJson" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "startedAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DrivingTrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripToken" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceWigleUpload" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "wifiCount" INTEGER NOT NULL,
    "cellCount" INTEGER NOT NULL,
    "bluetoothCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL,
    "duplicateCount" INTEGER NOT NULL,

    CONSTRAINT "DeviceWigleUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceEnvironment" (
    "deviceId" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARED',
    "preparedJson" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedJson" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "error" TEXT,
    "verificationJson" TEXT,
    "acceptedVerificationJson" TEXT,
    "dispatchedAt" TIMESTAMP(3),

    CONSTRAINT "DeviceEnvironment_pkey" PRIMARY KEY ("deviceId")
);

-- CreateTable
CREATE TABLE "TelemetryTick" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "altitudeM" DOUBLE PRECISION NOT NULL,
    "accuracyM" DOUBLE PRECISION NOT NULL,
    "speedMps" DOUBLE PRECISION NOT NULL,
    "bearing" DOUBLE PRECISION NOT NULL,
    "phase" TEXT NOT NULL,
    "pushed" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetryTick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RpaJob" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateType" INTEGER NOT NULL DEFAULT 2,
    "name" TEXT NOT NULL,
    "variablesJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RpaJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceEvent" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKeyStat" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "congestedUntil" TIMESTAMP(3),
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "dead" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,

    CONSTRAINT "ApiKeyStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "elevationM" DOUBLE PRECISION,
    "street" TEXT NOT NULL DEFAULT '',
    "zip" TEXT NOT NULL DEFAULT '',
    "proxyId" TEXT,
    "proxyIp" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'STILL',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "templateId" TEXT,
    "templateType" INTEGER NOT NULL DEFAULT 2,
    "profileJson" TEXT NOT NULL DEFAULT '{}',
    "profileStatus" TEXT NOT NULL DEFAULT 'DRAFT',
    "profileRevision" TEXT,
    "profileError" TEXT,
    "appliedAt" TIMESTAMP(3),
    "lastGpsAt" TIMESTAMP(3),
    "wigleCheckedAt" TIMESTAMP(3),
    "nextWigleRefreshAt" TIMESTAMP(3),
    "weeklyRefresh" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "motion" TEXT NOT NULL DEFAULT 'STILL',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "requestJson" TEXT NOT NULL DEFAULT '{}',
    "preflightJson" TEXT,
    "providerResponseJson" TEXT,
    "error" TEXT,
    "callbackTokenHash" TEXT,
    "callbackExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteResult" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "rank" INTEGER,
    "rawJson" TEXT NOT NULL,
    "evidenceUrl" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "provenanceJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "TenantKey_tenantId_keyHash_key" ON "TenantKey"("tenantId", "keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tenantId_imageId_key" ON "Device"("tenantId", "imageId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceWigleArchive_deviceId_sha256_key" ON "DeviceWigleArchive"("deviceId", "sha256");

-- CreateIndex
CREATE INDEX "LocationRequest_deviceId_requestedAt_idx" ON "LocationRequest"("deviceId", "requestedAt");

-- CreateIndex
CREATE INDEX "LocationRequest_deviceId_dispatchedAt_idx" ON "LocationRequest"("deviceId", "dispatchedAt");

-- CreateIndex
CREATE INDEX "DrivingTrip_deviceId_createdAt_idx" ON "DrivingTrip"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "DrivingTrip_status_nextTickAt_idx" ON "DrivingTrip"("status", "nextTickAt");

-- CreateIndex
CREATE UNIQUE INDEX "DrivingTrip_tenantId_idempotencyKey_key" ON "DrivingTrip"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TripToken_tokenHash_key" ON "TripToken"("tokenHash");

-- CreateIndex
CREATE INDEX "TripToken_deviceId_idx" ON "TripToken"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceWigleUpload_deviceId_sha256_key" ON "DeviceWigleUpload"("deviceId", "sha256");

-- CreateIndex
CREATE INDEX "TelemetryTick_deviceId_createdAt_idx" ON "TelemetryTick"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceEvent_deviceId_createdAt_idx" ON "DeviceEvent"("deviceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Site_deviceId_key" ON "Site"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "Site_tenantId_proxyIp_key" ON "Site"("tenantId", "proxyIp");

-- CreateIndex
CREATE INDEX "SiteJob_status_scheduledAt_idx" ON "SiteJob"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "SiteJob_siteId_createdAt_idx" ON "SiteJob"("siteId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SiteJob_tenantId_idempotencyKey_key" ON "SiteJob"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "SiteResult_jobId_key" ON "SiteResult"("jobId");

-- AddForeignKey
ALTER TABLE "TenantWigleCredential" ADD CONSTRAINT "TenantWigleCredential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantKey" ADD CONSTRAINT "TenantKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceWigleArchive" ADD CONSTRAINT "DeviceWigleArchive_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationRequest" ADD CONSTRAINT "LocationRequest_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationRequest" ADD CONSTRAINT "LocationRequest_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "DrivingTrip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrivingTrip" ADD CONSTRAINT "DrivingTrip_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripToken" ADD CONSTRAINT "TripToken_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceWigleUpload" ADD CONSTRAINT "DeviceWigleUpload_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEnvironment" ADD CONSTRAINT "DeviceEnvironment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryTick" ADD CONSTRAINT "TelemetryTick_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RpaJob" ADD CONSTRAINT "RpaJob_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEvent" ADD CONSTRAINT "DeviceEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteJob" ADD CONSTRAINT "SiteJob_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteResult" ADD CONSTRAINT "SiteResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SiteJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
