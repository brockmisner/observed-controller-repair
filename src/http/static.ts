import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".apk": "application/vnd.android.package-archive",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const here = fileURLToPath(new URL(".", import.meta.url));
const candidates = [
  resolve(here, "../../public"),
  resolve(process.cwd(), "public"),
  resolve(process.cwd(), "observatory-controller/public"),
];

export const publicDir = candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? candidates[0]!;

export function tryServeStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/" || pathname === "/ui" || pathname === "/ui/") {
    pathname = "/index.html";
  }
  if (pathname.startsWith("/ui/")) pathname = pathname.slice(3);

  const abs = normalize(join(publicDir, pathname));
  if (!abs.startsWith(publicDir + sep)) return false;
  if (!existsSync(abs)) return false;
  const stat = statSync(abs);
  if (!stat.isFile()) return false;

  const type = MIME[extname(abs)] ?? "application/octet-stream";
  const html = extname(abs) === ".html";
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  const headers = {
    "Content-Type": type,
    "Cache-Control": html ? "no-store" : pathname.startsWith("/vendor/leaflet-1.9.4/")
      ? "public, max-age=31536000, immutable" : "public, no-cache",
    ...(html ? {} : { ETag: etag, "Last-Modified": stat.mtime.toUTCString() }),
  };
  const matches = req.headers["if-none-match"]?.split(",").map((value) => value.trim());
  if (!html && matches?.some((value) => value === "*" || value.replace(/^W\//, "") === etag.slice(2))) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, "Content-Length": stat.size });
  createReadStream(abs).on("error", () => res.destroy()).pipe(res);
  return true;
}
