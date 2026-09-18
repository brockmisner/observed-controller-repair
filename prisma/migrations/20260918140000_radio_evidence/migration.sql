-- CreateTable
CREATE TABLE "RadioEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "bootId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "datasetRevision" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "simElapsedMs" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lifecycle" TEXT,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "uncertain" BOOLEAN NOT NULL DEFAULT false,
    "duplicate" BOOLEAN NOT NULL DEFAULT false,
    "current" BOOLEAN NOT NULL DEFAULT true,
    "evidenceClass" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "clockDomain" TEXT NOT NULL,
    "frameHash" TEXT,
    "servingCell" TEXT,
    "handoverFrom" TEXT,
    "handoverTo" TEXT,
    "detail" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "RadioEvidence_tenantId_imageId_tripId_sequence_idx" ON "RadioEvidence"("tenantId", "imageId", "tripId", "sequence");
CREATE INDEX "RadioEvidence_tenantId_sessionId_sequence_idx" ON "RadioEvidence"("tenantId", "sessionId", "sequence");
CREATE INDEX "RadioEvidence_tenantId_imageId_current_idx" ON "RadioEvidence"("tenantId", "imageId", "current");
