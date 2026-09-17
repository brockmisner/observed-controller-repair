-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lat" REAL NOT NULL,
    "lng" REAL NOT NULL,
    "elevationM" REAL,
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
    "appliedAt" DATETIME,
    "lastGpsAt" DATETIME,
    "wigleCheckedAt" DATETIME,
    "nextWigleRefreshAt" DATETIME,
    "weeklyRefresh" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Site_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Site_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SiteJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "motion" TEXT NOT NULL DEFAULT 'STILL',
    "scheduledAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "requestJson" TEXT NOT NULL DEFAULT '{}',
    "preflightJson" TEXT,
    "providerResponseJson" TEXT,
    "error" TEXT,
    "callbackTokenHash" TEXT,
    "callbackExpiresAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SiteJob_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SiteResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "rank" INTEGER,
    "rawJson" TEXT NOT NULL,
    "evidenceUrl" TEXT,
    "capturedAt" DATETIME NOT NULL,
    "source" TEXT NOT NULL,
    "provenanceJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SiteJob" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

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
