import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError } from "./errors.js";
import { applySite, cancelSiteJob, createSite, editSite, listSites, prepareSite, refreshSite, scheduleJob, serializeJob } from "../sites/service.js";
import { listSiteResults, resolveSiteJob, saveSiteResult } from "../sites/jobs.js";

async function read(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += Buffer.byteLength(chunk);
    if (size > 1_050_000) { req.resume(); throw new HttpError(413, "Request body too large"); }
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Invalid JSON"); }
}
function send(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
export async function handleSiteRequest(req: IncomingMessage, res: ServerResponse, url: URL, tenantId?: string): Promise<boolean> {
  const path = url.pathname, method = req.method ?? "GET";
  if (!/^\/api\/(?:sites|site-jobs|site-results)(?:\/|$)/.test(path)) return false;
  const callback = path.match(/^\/api\/site-jobs\/([^/]+)\/callback$/);
  if (callback && method === "POST") {
    const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!bearer) throw new HttpError(401, "Job-scoped result credential required");
    send(res, await saveSiteResult(decodeURIComponent(callback[1]!), await read(req), { token: bearer }));
    return true;
  }
  if (!tenantId) throw new HttpError(401, "Workspace login required");
  if (path === "/api/sites" && method === "GET") send(res, await listSites(tenantId));
  else if (path === "/api/sites" && method === "POST") send(res, await createSite(tenantId, await read(req)), 201);
  else if (path === "/api/site-results" && method === "GET") {
    const keyword = url.searchParams.get("keyword") ?? undefined;
    const app = url.searchParams.has("app") ? z.enum(["chrome", "maps", "tracker"]).parse(url.searchParams.get("app")) : undefined;
    if (keyword && keyword.length > 250) throw new HttpError(400, "Keyword is too long");
    send(res, await listSiteResults(tenantId, keyword, app));
  } else {
    const site = path.match(/^\/api\/sites\/([^/]+)(?:\/(prepare|refresh|apply|jobs))?$/);
    const job = path.match(/^\/api\/site-jobs\/([^/]+)(?:\/(cancel|result|resolve))?$/);
    if (site) {
      const id = decodeURIComponent(site[1]!), action = site[2];
      if (!action && method === "PATCH") send(res, await editSite(tenantId, id, await read(req)));
      else if (method === "POST" && action === "prepare") send(res, await prepareSite(tenantId, id));
      else if (method === "POST" && action === "refresh") send(res, await refreshSite(tenantId, id));
      else if (method === "POST" && action === "apply") {
        const { revision } = z.object({ revision: z.string().uuid() }).strict().parse(await read(req));
        send(res, await applySite(tenantId, id, revision));
      } else if (method === "POST" && action === "jobs") send(res, await scheduleJob(tenantId, id, await read(req)), 201);
      else throw new HttpError(405, "Method not allowed");
    } else if (job) {
      const id = decodeURIComponent(job[1]!), action = job[2];
      if (!action && method === "GET") {
        const row = await prisma.siteJob.findFirst({ where: { id, tenantId }, include: { result: true } });
        if (!row) throw new HttpError(404, "Job not found");
        send(res, serializeJob(row));
      } else if (method === "POST" && action === "cancel") send(res, await cancelSiteJob(tenantId, id));
      else if (method === "POST" && action === "result") send(res, await saveSiteResult(id, await read(req), { tenantId }));
      else if (method === "POST" && action === "resolve") {
        z.object({ remoteStopped: z.literal(true) }).strict().parse(await read(req));
        send(res, await resolveSiteJob(tenantId, id));
      } else throw new HttpError(405, "Method not allowed");
    } else throw new HttpError(404, "Client endpoint not found");
  }
  return true;
}
