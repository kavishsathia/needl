import type { IncomingMessage, ServerResponse } from "node:http";
import { createNeedlApp } from "./app.js";
import { withClock } from "./clock.js";

// Vercel function entry. One app per warm instance; there is no background timer, so time-bounded
// rules advance on incoming requests (the open UI polls every few seconds) and on the cron route.
let handler: Promise<ReturnType<typeof withClock>> | undefined;

function load(): Promise<ReturnType<typeof withClock>> {
  handler ??= createNeedlApp({ serveStatic: false }).then((app) => withClock(app)).catch((error: unknown) => { handler = undefined; throw error; });
  return handler;
}

export default async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  await (await load())(request, response);
}
