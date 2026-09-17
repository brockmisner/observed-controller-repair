-- CreateTable
CREATE TABLE "WarmupCity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "radiusM" INTEGER NOT NULL,
    "recordsJson" TEXT NOT NULL DEFAULT '[]',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarmupCity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmupCampaign" (
    "reservedImageId" TEXT,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientFolder" TEXT NOT NULL,
    "folderId" TEXT,
    "profileLabel" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "providerTimezone" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "wifiMode" TEXT NOT NULL DEFAULT 'PRESERVE',
    "autoPower" BOOLEAN NOT NULL DEFAULT false,
    "powerOwned" BOOLEAN NOT NULL DEFAULT false,
    "powerRequestedAt" TIMESTAMP(3),
    "scheduleJson" TEXT NOT NULL,
    "profileBaselineJson" TEXT,
    "environmentJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "error" TEXT,
    "activatedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarmupCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmupRun" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "dayNumber" INTEGER NOT NULL,
    "slotKey" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "taskJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerName" TEXT NOT NULL,
    "providerTaskId" TEXT,
    "issueAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "evidenceJson" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarmupRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmupEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarmupEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WarmupCity_tenantId_name_key" ON "WarmupCity"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "WarmupCampaign_reservedImageId_key" ON "WarmupCampaign"("reservedImageId");

-- CreateIndex
CREATE INDEX "WarmupCampaign_deviceId_status_idx" ON "WarmupCampaign"("deviceId", "status");

-- CreateIndex
CREATE INDEX "WarmupCampaign_tenantId_status_idx" ON "WarmupCampaign"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WarmupRun_providerName_key" ON "WarmupRun"("providerName");

-- CreateIndex
CREATE INDEX "WarmupRun_status_scheduledAt_idx" ON "WarmupRun"("status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "WarmupRun_campaignId_dayNumber_slotKey_key" ON "WarmupRun"("campaignId", "dayNumber", "slotKey");

-- CreateIndex
CREATE INDEX "WarmupEvent_campaignId_createdAt_idx" ON "WarmupEvent"("campaignId", "createdAt");

-- AddForeignKey
ALTER TABLE "WarmupCity" ADD CONSTRAINT "WarmupCity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupCampaign" ADD CONSTRAINT "WarmupCampaign_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupCampaign" ADD CONSTRAINT "WarmupCampaign_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupCampaign" ADD CONSTRAINT "WarmupCampaign_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "WarmupCity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupRun" ADD CONSTRAINT "WarmupRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "WarmupCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupEvent" ADD CONSTRAINT "WarmupEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "WarmupCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

