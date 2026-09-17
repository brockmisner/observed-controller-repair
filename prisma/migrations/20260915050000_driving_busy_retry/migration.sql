ALTER TABLE "LocationRequest" ADD COLUMN "rejectionReason" TEXT;
ALTER TABLE "DrivingTrip" ADD COLUMN "gpsRetryCount" INTEGER NOT NULL DEFAULT 0;
