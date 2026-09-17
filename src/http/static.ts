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
  if (!existsSync(abs) || !statSync(abs).isFile()) return false;

  const type = MIME[extname(abs)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  createReadStream(abs).pipe(res);
  return true;
}
