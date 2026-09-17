CREATE TABLE "DuoPlusFolderInventory" (
  "tenantId" TEXT NOT NULL PRIMARY KEY,
  "payloadJson" TEXT NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DuoPlusFolderInventory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
