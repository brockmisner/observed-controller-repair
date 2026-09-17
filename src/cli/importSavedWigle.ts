import { readFileSync, statSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { importSavedWigle } from "../ops/savedWigleImport.js";

// Standalone storage-only command: do not load controller/provider modules or dotenv.
async function main() {
  const [path, mode] = process.argv.slice(2);
  if (!path || !["--dry-run", "--apply"].includes(mode ?? "") || process.argv.length !== 4) {
    throw new Error("Usage: node dist/cli/importSavedWigle.js <bundle.json> <--dry-run|--apply>");
  }
  if (!process.env.DATABASE_URL?.startsWith("file:")) throw new Error("An explicit SQLite DATABASE_URL is required");
  if (statSync(path).size > 2_000_000) throw new Error("Saved WiGLE import bundle is too large");
  const input: unknown = JSON.parse(readFileSync(path, "utf8"));
  const prisma = new PrismaClient();
  try {
    console.log(JSON.stringify(await importSavedWigle(prisma, input, mode === "--apply")));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("Saved WiGLE import failed validation or database checks; no partial import committed.");
  process.exitCode = 1;
});
