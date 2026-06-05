import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const DEFAULT_UPDATE_DIR = "/Volumes/ModelX/Apps/Pings-v2/artifacts";
const updateDir = path.resolve(process.env.PINGS_UPDATE_DIR || DEFAULT_UPDATE_DIR);
const port = Number(process.env.PINGS_UPDATE_PORT || 8123);
const host = process.env.PINGS_UPDATE_HOST || "0.0.0.0";

const contentTypeByExt = new Map([
  [".json", "application/json"],
  [".gz", "application/gzip"],
  [".sig", "text/plain; charset=utf-8"],
  [".dmg", "application/x-apple-diskimage"],
]);

const respond = (res, code, body, contentType = "text/plain; charset=utf-8") => {
  res.writeHead(code, {
    "content-type": contentType,
    "access-control-allow-origin": "*",
    "cache-control": "no-cache",
  });
  res.end(body);
};

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    respond(res, 400, "Bad request");
    return;
  }

  let requestPath = decodeURIComponent(req.url.split("?")[0] || "/");
  if (requestPath === "/") {
    requestPath = "/latest.json";
  }

  const normalizedPath = path
    .normalize(requestPath)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
  const filePath = path.resolve(updateDir, normalizedPath);

  if (!filePath.startsWith(updateDir)) {
    respond(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      respond(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = contentTypeByExt.get(ext) || "application/octet-stream";

    res.writeHead(200, {
      "content-type": contentType,
      "content-length": stat.size,
      "access-control-allow-origin": "*",
      "cache-control": ext === ".json" ? "no-cache" : "public, max-age=60",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    respond(res, 404, "Not found");
  }
});

server.listen(port, host, () => {
  const hostname = os.hostname();
  console.log(`[updates] serving ${updateDir}`);
  console.log(`[updates] endpoint (local): http://localhost:${port}/latest.json`);
  console.log(`[updates] endpoint (LAN):   http://${hostname}:${port}/latest.json`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
