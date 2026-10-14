import { createHmac } from "node:crypto";
import {
  InMemoryEventSink,
  LinearAdapter,
  StaticRouteResolver,
  WebhookReceiver,
} from "@needl/integrations";

const secret = "package-smoke-secret";
const now = new Date("2026-10-14T09:00:00.000Z");
const rawBody = Buffer.from(JSON.stringify({
  action: "create",
  type: "Issue",
  createdAt: now.toISOString(),
  webhookTimestamp: now.getTime(),
  data: { id: "smoke-issue", identifier: "NDL-1", title: "Smoke test" },
}));
const routes = new StaticRouteResolver().register("smoke", "linear", new LinearAdapter(), { secrets: [secret] });
const receiver = new WebhookReceiver({ routes, sink: new InMemoryEventSink() });
const outcome = await receiver.receive({
  tenantId: "smoke",
  provider: "linear",
  rawBody,
  receivedAt: now,
  headers: { "linear-signature": createHmac("sha256", secret).update(rawBody).digest("hex") },
});
if (outcome.outcome !== "stored") throw new Error(`Package smoke test failed: ${outcome.outcome}`);
process.stdout.write(`package smoke passed: ${outcome.event.provider}/${outcome.event.providerEventType}\n`);

