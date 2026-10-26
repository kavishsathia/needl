import { createServer } from "node:http";
import { createNeedlApp } from "./backend/app.js";
import { withClock } from "./backend/clock.js";

// Long-running server: local development and Google Cloud Run. On Vercel the same app runs as a function (see backend/vercel.ts).
const apiOnly = process.argv.includes("--api-only");
const port = Number(process.env.PORT ?? (apiOnly ? 4174 : 4173));
const host = process.env.HOST ?? "127.0.0.1";
const app = await createNeedlApp({ serveStatic: !apiOnly, port });

// The timer covers machines that keep CPU between requests; on Cloud Run requests and the cron route do the work.
const ticker = setInterval(() => void app.tick(), Number(process.env.NEEDL_TICK_INTERVAL_MS ?? 5_000));
ticker.unref();

const handle = withClock(app);
const server = createServer((request, response) => void handle(request, response));
server.listen(port, host, () => process.stdout.write(`Needl server listening on http://${host}:${port} (${app.databaseType})\n`));

async function shutdown() {
  clearInterval(ticker);
  server.close();
  await app.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
