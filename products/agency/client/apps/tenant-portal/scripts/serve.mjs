import http from "node:http";
import https from "node:https";
import { createReadStream, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const env = {};
for (const name of [
  ".env",
  ".env.production",
  ".env.local",
  ".env.production.local",
]) {
  try {
    Object.assign(
      env,
      parseEnv(readFileSync(new URL("../" + name, import.meta.url), "utf8")),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
Object.assign(env, process.env);
const backend = new URL(env.TENANT_BACKEND_URL || "http://127.0.0.1:8090");
if (!["http:", "https:"].includes(backend.protocol))
  throw new Error("TENANT_BACKEND_URL must be an HTTP URL");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};
export function createPortalServer({
  directory = root,
  target = backend,
} = {}) {
  return http.createServer(async (req, res) => {
    const pathname = (req.url || "/").split("?")[0];
    if (pathname === "/api/tenant" || pathname.startsWith("/api/tenant/")) {
      const headers = {
        ...req.headers,
        host: target.host,
        "x-kasitek-tenant-host": req.headers.host,
        "x-forwarded-host": req.headers.host,
        "x-forwarded-proto": env.PORTAL_PUBLIC_PROTOCOL || "http",
      };
      delete headers.connection;
      const upstream = (target.protocol === "https:" ? https : http).request(
        target,
        {
          method: req.method,
          path:
            (req.url || "/").replace(/^\/api\/tenant(?=\/|\?|$)/, "") || "/",
          headers,
        },
        (response) => {
          const responseHeaders = { ...response.headers };
          delete responseHeaders.connection;
          res.writeHead(response.statusCode || 502, responseHeaders);
          response.pipe(res);
        },
      );
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end('{"error":"Agency API unavailable"}');
        } else res.destroy();
      });
      req.on("aborted", () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    let filename = path.resolve(directory, "." + decoded);
    if (
      path.relative(directory, filename).startsWith("..") ||
      decoded.includes("\0")
    ) {
      res.writeHead(400);
      res.end();
      return;
    }
    let info = await stat(filename).catch(() => null);
    if (!info?.isFile()) {
      if (
        path.extname(decoded) ||
        (decoded !== "/" && !req.headers.accept?.includes("text/html"))
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      filename = path.join(directory, "index.html");
      info = await stat(filename).catch(() => null);
    }
    if (!info?.isFile()) {
      res.writeHead(503);
      res.end("Build the portal before starting it.");
      return;
    }
    res.writeHead(200, {
      "content-type":
        types[path.extname(filename)] || "application/octet-stream",
      "content-length": info.size,
      "cache-control": filename.endsWith("index.html")
        ? "no-store"
        : "public, max-age=3600",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") res.end();
    else
      createReadStream(filename)
        .on("error", () => res.destroy())
        .pipe(res);
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  createPortalServer().listen(
    Number(env.PORT || 3010),
    env.HOST || "127.0.0.1",
    () => console.log("Agency portal ready"),
  );
}
