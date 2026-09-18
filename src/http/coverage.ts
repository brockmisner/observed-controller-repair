import type { IncomingMessage, ServerResponse } from "node:http";
import { prisma } from "../db.js";
import { areaCoverageReport } from "../coverage/areaReport.js";
import { listAreas, resolvePin, verifyTile } from "../coverage/areaStore.js";
import { ingestStatus } from "../coverage/ingestJob.js";
import { planAreaIngest } from "../coverage/ingestPlan.js";
import { auditReimport, uploadAuditRequestSchema } from "../coverage/reimport.js";
import { uploadSummary } from "../ops/wigleUpload.js";
import { HttpError } from "./errors.js";

/** Reads a JSON request body up to 2 MB and rejects unsupported, oversized, or invalid input. */
async function readJson(req: IncomingMessage) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "JSON required");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += Buffer.byteLength(chunk);
    if (size > 2_000_000) {
      req.resume();
      throw new HttpError(413, "Body exceeds 2 MB");
    }
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
  catch { throw new HttpError(400, "Invalid JSON"); }
}

/** Handles a coverage route and writes its JSON response, or returns false when the path is unrelated. */
export async function handleCoverageRequest(req: IncomingMessage, res: ServerResponse, url: URL, tenantId?: string): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/coverage")) return false;
  if (!tenantId) throw new HttpError(401, "Workspace login required");
  const method = req.method ?? "GET";
  let result: unknown;
  const pinPath = path.match(/^\/api\/coverage\/areas\/([^/]+)\/pin$/);
  const tilePath = path.match(/^\/api\/coverage\/areas\/([^/]+)\/tile$/);
  const jobPath = path.match(/^\/api\/coverage\/ingest\/([^/]+)$/);

  if (path === "/api/coverage/areas" && method === "GET") {
    result = { areas: await listAreas(prisma, tenantId) };
  } else if (path === "/api/coverage/report" && method === "POST") {
    result = await areaCoverageReport(prisma, tenantId, await readJson(req));
  } else if (path === "/api/coverage/plan" && method === "POST") {
    result = planAreaIngest(await readJson(req));
  } else if (pinPath && method === "GET") {
    const revision = url.searchParams.get("revision");
    result = await resolvePin(prisma, tenantId, {
      dataset: decodeURIComponent(pinPath[1]!),
      ...(revision ? { revision: Number(revision) } : {}),
    });
  } else if (tilePath && method === "GET") {
    const kind = url.searchParams.get("kind");
    const tileKey = url.searchParams.get("tileKey");
    if (kind !== "WIFI" && kind !== "CELL" && kind !== "BLUETOOTH") throw new HttpError(400, "kind must be WIFI, CELL or BLUETOOTH");
    if (!tileKey) throw new HttpError(400, "tileKey is required");
    const revision = url.searchParams.get("revision");
    const pin = await resolvePin(prisma, tenantId, {
      dataset: decodeURIComponent(tilePath[1]!),
      ...(revision ? { revision: Number(revision) } : {}),
    });
    result = await verifyTile(prisma, pin.revisionId, kind, tileKey);
  } else if (jobPath && method === "GET") {
    result = await ingestStatus(prisma, tenantId, decodeURIComponent(jobPath[1]!));
  } else if (path === "/api/coverage/imports/audit" && method === "POST") {
    const request = uploadAuditRequestSchema.parse(await readJson(req));
    const uploads = await prisma.deviceWigleUpload.findMany({
      where: { device: { tenantId }, ...(request.deviceId ? { deviceId: request.deviceId } : {}) },
      orderBy: { importedAt: "desc" },
      take: request.limit,
    });
    result = {
      uploads: uploads.map((upload) => ({
        ...uploadSummary(upload),
        deviceId: upload.deviceId,
        reimport: auditReimport(upload.payloadJson, { source: upload.filename }),
      })),
      note: "Reimport recovers only what the retained original response contains. Absent frequency, propagation and "
        + "sector information stay absent.",
    };
  } else throw new HttpError(404, "Coverage endpoint not found");

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(result));
  return true;
}
