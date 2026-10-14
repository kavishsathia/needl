import { createHmac } from "node:crypto";
import {
  InMemoryEventSink,
  InMemoryMonitorStore,
  LinearAdapter,
  RuntimeMonitor,
  StaticRouteResolver,
  WebhookReceiver,
  parseFormula,
} from "@needl/integrations";
import { SqliteMonitorStore } from "@needl/integrations/ltl/sqlite";

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
const monitorStore = new InMemoryMonitorStore();
const monitor = new RuntimeMonitor({
  store: monitorStore,
  assertions: [{
    id: "smoke-monitor",
    version: 1,
    tenantId: "smoke",
    name: "Smoke monitor",
    formula: parseFormula("F seen"),
    scope: { keys: [{ name: "issue", extractors: [{ from: "subject", type: "issue" }] }] },
    propositions: [{ name: "seen", predicate: { op: "true" } }],
  }],
});
const monitorResult = await monitor.process(outcome.event);
if (monitorResult[0]?.outcome !== "applied" || monitorResult[0].verdict !== "satisfied") {
  throw new Error("LTL package smoke test failed");
}
const sqliteMonitor = new SqliteMonitorStore(":memory:");
sqliteMonitor.close();
process.stdout.write(`package smoke passed: ${outcome.event.provider}/${outcome.event.providerEventType} + LTL\n`);
