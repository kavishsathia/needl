import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { getDemoBootstrap, runDemoScenario } from "./demo.js";
import type { DemoReplayRequest } from "./src/domain.js";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const distRoot = join(appRoot, "dist");
const apiOnly = process.argv.includes("--api-only");
const port = apiOnly ? 4174 : 4173;

const mime: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function serveStatic(request: IncomingMessage, response: ServerResponse): void {
  if (!existsSync(distRoot)) {
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    response.end("Needl frontend is not built. Run npm run web:build first.\n");
    return;
  }
  const rawPath = new URL(request.url ?? "/", "http://localhost").pathname;
  const candidate = normalize(join(distRoot, rawPath));
  const safe = candidate.startsWith(distRoot) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(distRoot, "index.html");
  response.writeHead(200, {
    "content-type": mime[extname(safe)] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  createReadStream(safe).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, 200, { status: "ok", mode: "deterministic-local-demo" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/demo/bootstrap") {
      json(response, 200, getDemoBootstrap());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/demo/replay") {
      json(response, 200, await runDemoScenario(await readJson(request) as DemoReplayRequest));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      json(response, 404, { error: "Unknown local demo endpoint" });
      return;
    }
    if (apiOnly) {
      json(response, 404, { error: "The development API bridge only serves /api routes" });
      return;
    }
    serveStatic(request, response);
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Invalid request" });
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Needl local demo server listening on http://127.0.0.1:${port}\n`);
});
