import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { PrismaClient } from "@prisma/client";
import { MAX_WIGLE_UPLOAD_BYTES, parseWigleUpload, saveWigleUpload } from "../ops/wigleUpload.js";

// This storage-only command must not import controller, provider, configuration, or dotenv modules.
async function main() {
  const [path, imageId, deviceName, mode] = process.argv.slice(2);
  if (!path || !imageId || !deviceName || !["--dry-run", "--apply"].includes(mode ?? "") || process.argv.length !== 6) {
    throw new Error("Usage: node dist/cli/importWigleUpload.js <file.json> <imageId> <exactDeviceName> <--dry-run|--apply>");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.startsWith("file:") || databaseUrl.length <= 5) throw new Error("An explicit SQLite DATABASE_URL is required");
  const file = statSync(path);
  if (!file.isFile() || file.size > MAX_WIGLE_UPLOAD_BYTES) throw new Error("Upload must be a JSON file no larger than 1 MiB");
  const input = readFileSync(path, "utf8");
  const parsed = parseWigleUpload(input);
  const wifiCount = parsed.records.filter((record) => record.kind === "WIFI").length;
  const counts = {
    wifiCount,
    cellCount: parsed.records.filter((record) => record.kind === "CELL").length,
    bluetoothCount: parsed.records.filter((record) => record.kind === "BLUETOOTH").length,
    rejectedCount: parsed.rejectedCount, duplicateCount: parsed.duplicateCount,
  };
  parsed.records.sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const expectedSha256 = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const devices = await prisma.device.findMany({
      where: { imageId, name: deviceName },
      select: { id: true, tenantId: true, imageId: true, name: true }, take: 2,
    });
    if (devices.length !== 1) throw new Error("Exactly one device must match the image ID and device name across workspaces");
    const device = devices[0]!;
    let id: string | null = null;
    let duplicate: boolean | null = null;
    let importedAt: string | null = null;
    let sha256: string | null = null;
    let filename = basename(path);
    if (mode === "--apply") {
      const result = await saveWigleUpload(prisma, device.id, device.tenantId, filename, input);
      const saved = await prisma.deviceWigleUpload.findFirstOrThrow({
        where: { id: result.upload.id, deviceId: device.id, device: { tenantId: device.tenantId } },
      });
      sha256 = createHash("sha256").update(saved.payloadJson).digest("hex");
      if (sha256 !== expectedSha256 || sha256 !== saved.sha256 || saved.wifiCount !== counts.wifiCount || saved.cellCount !== counts.cellCount
        || saved.bluetoothCount !== counts.bluetoothCount
        || saved.rejectedCount !== counts.rejectedCount || saved.duplicateCount !== counts.duplicateCount) {
        throw new Error("Stored upload readback did not match the validated input");
      }
      id = saved.id;
      duplicate = result.duplicate;
      importedAt = saved.importedAt.toISOString();
      filename = saved.filename;
    }
    console.log(JSON.stringify({
      event: "manual_wigle_upload", imageId: device.imageId, deviceName: device.name,
      mode: mode === "--apply" ? "apply" : "dry_run", counts,
      totalResults: parsed.page.totalResults,
      returnedRows: parsed.records.length + parsed.rejectedCount + parsed.duplicateCount,
      id, duplicate, filename, importedAt, sha256,
    }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("WiGLE upload failed validation, device matching, or database checks. No provider requests were made.");
  process.exitCode = 1;
});
