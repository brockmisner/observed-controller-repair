-- CreateTable
CREATE TABLE "AreaDataset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "centerLat" DOUBLE PRECISION NOT NULL,
    "centerLng" DOUBLE PRECISION NOT NULL,
    "radiusM" INTEGER NOT NULL,
    "tileZoom" INTEGER NOT NULL DEFAULT 15,
    "activeRevisionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AreaDataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaDatasetRevision" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BUILDING',
    "tileZoom" INTEGER NOT NULL,
    "centerLat" DOUBLE PRECISION NOT NULL,
    "centerLng" DOUBLE PRECISION NOT NULL,
    "radiusM" INTEGER NOT NULL,
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "wifiCount" INTEGER NOT NULL DEFAULT 0,
    "cellCount" INTEGER NOT NULL DEFAULT 0,
    "bluetoothCount" INTEGER NOT NULL DEFAULT 0,
    "tileCount" INTEGER NOT NULL DEFAULT 0,
    "maxTileRecords" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "outsideCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "unknownDateCount" INTEGER NOT NULL DEFAULT 0,
    "oldestLastSeen" TIMESTAMP(3),
    "newestLastSeen" TIMESTAMP(3),
    "sourcesJson" TEXT NOT NULL DEFAULT '[]',
    "auditJson" TEXT,
    "error" TEXT,
    "builtAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AreaDatasetRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaDatasetTile" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tileKey" TEXT NOT NULL,
    "tileX" INTEGER NOT NULL,
    "tileY" INTEGER NOT NULL,
    "minLat" DOUBLE PRECISION NOT NULL,
    "maxLat" DOUBLE PRECISION NOT NULL,
    "minLng" DOUBLE PRECISION NOT NULL,
    "maxLng" DOUBLE PRECISION NOT NULL,
    "recordCount" INTEGER NOT NULL,
    "usableCount" INTEGER NOT NULL,
    "unknownDateCount" INTEGER NOT NULL DEFAULT 0,
    "oldestLastSeen" TIMESTAMP(3),
    "newestLastSeen" TIMESTAMP(3),
    "plmnJson" TEXT NOT NULL DEFAULT '{}',
    "recordsJson" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,

    CONSTRAINT "AreaDatasetTile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AreaDataset_tenantId_name_key" ON "AreaDataset"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AreaDatasetRevision_datasetId_revision_key" ON "AreaDatasetRevision"("datasetId", "revision");

-- CreateIndex
CREATE INDEX "AreaDatasetRevision_datasetId_status_idx" ON "AreaDatasetRevision"("datasetId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AreaDatasetTile_revisionId_kind_tileKey_key" ON "AreaDatasetTile"("revisionId", "kind", "tileKey");

-- CreateIndex
CREATE INDEX "AreaDatasetTile_revisionId_kind_idx" ON "AreaDatasetTile"("revisionId", "kind");

-- AddForeignKey
ALTER TABLE "AreaDataset" ADD CONSTRAINT "AreaDataset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaDatasetRevision" ADD CONSTRAINT "AreaDatasetRevision_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "AreaDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaDatasetTile" ADD CONSTRAINT "AreaDatasetTile_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "AreaDatasetRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AreaIngestJob" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "kindsJson" TEXT NOT NULL,
    "cellSizeM" INTEGER NOT NULL,
    "dailyQueryBudget" INTEGER NOT NULL,
    "requestsUsed" INTEGER NOT NULL DEFAULT 0,
    "requestsToday" INTEGER NOT NULL DEFAULT 0,
    "budgetDay" TEXT NOT NULL DEFAULT '',
    "rowsFetched" INTEGER NOT NULL DEFAULT 0,
    "recordsStored" INTEGER NOT NULL DEFAULT 0,
    "rateLimitedAt" TIMESTAMP(3),
    "lastMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AreaIngestJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaIngestUnit" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cellKey" TEXT NOT NULL,
    "minLat" DOUBLE PRECISION NOT NULL,
    "maxLat" DOUBLE PRECISION NOT NULL,
    "minLng" DOUBLE PRECISION NOT NULL,
    "maxLng" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "cursor" TEXT,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "rows" INTEGER NOT NULL DEFAULT 0,
    "totalResults" INTEGER,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AreaIngestUnit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AreaIngestJob_revisionId_key" ON "AreaIngestJob"("revisionId");

-- CreateIndex
CREATE INDEX "AreaIngestJob_tenantId_status_idx" ON "AreaIngestJob"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AreaIngestUnit_jobId_kind_cellKey_key" ON "AreaIngestUnit"("jobId", "kind", "cellKey");

-- CreateIndex
CREATE INDEX "AreaIngestUnit_jobId_status_idx" ON "AreaIngestUnit"("jobId", "status");

-- AddForeignKey
ALTER TABLE "AreaIngestUnit" ADD CONSTRAINT "AreaIngestUnit_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AreaIngestJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
