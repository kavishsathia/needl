import type { IncomingMessage, ServerResponse } from "node:http";
import type { NeedlApp } from "./app.js";

/**
 * Wraps the app so time-bounded rules advance without a background timer, which hosts like Vercel and Cloud Run do
 * not give CPU to between requests: every request ticks the clock (at most every `everyMs`), and a scheduler can call
 * `/api/cron/tick` with `Authorization: Bearer <CRON_SECRET>` to catch deadlines while nobody is on the site.
 */
export function withClock(app: NeedlApp, options: { readonly everyMs?: number; readonly environment?: NodeJS.ProcessEnv } = {}) {
  const everyMs = options.everyMs ?? 2_000;
  const environment = options.environment ?? process.env;
  let lastTick = 0;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/api/cron/tick") {
      const secret = environment.CRON_SECRET;
      if (!secret || request.headers.authorization !== `Bearer ${secret}`) {
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      await app.tick();
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ticked: true }));
      return;
    }
    if (Date.now() - lastTick >= everyMs) {
      lastTick = Date.now();
      await app.tick();
    }
    await app.handle(request, response);
  };
}
