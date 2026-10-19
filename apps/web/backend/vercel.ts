import type { IncomingMessage, ServerResponse } from "node:http";
import { createNeedlApp, type NeedlApp } from "./app.js";

// Vercel function entry. One app per warm instance; there is no background timer, so time-bounded
// rules advance on incoming requests (the open UI polls every few seconds) and on the cron route.
let app: Promise<NeedlApp> | undefined;
let lastTick = 0;
const tickEveryMs = 2_000;

function load(): Promise<NeedlApp> {
  app ??= createNeedlApp({ serveStatic: false }).catch((error: unknown) => { app = undefined; throw error; });
  return app;
}

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const needl = await load();
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path === "/api/cron/tick") {
    const secret = process.env.CRON_SECRET;
    if (secret === undefined || request.headers.authorization !== `Bearer ${secret}`) {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    await needl.tick();
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ticked: true }));
    return;
  }
  if (Date.now() - lastTick >= tickEveryMs) {
    lastTick = Date.now();
    await needl.tick();
  }
  await needl.handle(request, response);
}
