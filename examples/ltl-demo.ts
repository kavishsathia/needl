import type { NormalizedEvent, Provider, RelationshipEvidence } from "../src/core/index.js";
import {
  RuntimeMonitor,
  disabledFeatureErrorAssertion,
  linkedIssueRecurrenceAssertion,
  provisioningSupportDeadlineAssertion,
} from "../src/ltl/index.js";
import { SqliteMonitorStore } from "../src/ltl/sqlite.js";

const tenantId = "synthetic-demo";
const store = new SqliteMonitorStore(":memory:");
const runtime = new RuntimeMonitor({
  store,
  assertions: [
    linkedIssueRecurrenceAssertion(tenantId),
    disabledFeatureErrorAssertion(tenantId),
    provisioningSupportDeadlineAssertion(tenantId),
  ],
});

function syntheticEvent(
  id: string,
  provider: Provider,
  kind: string,
  at: string,
  relationships: readonly [string, string][],
): NormalizedEvent {
  return {
    id,
    provider,
    providerEventType: kind,
    tenantId,
    source: { id: "synthetic-demo-source" },
    occurredAt: at,
    receivedAt: at,
    kind,
    subject: { type: "synthetic-observation", id },
    relationships: relationships.map(([type, relationshipId], index): RelationshipEvidence => ({
      type,
      id: relationshipId,
      evidencePath: `/synthetic/relationships/${index}`,
    })),
    evidence: {
      providerPayload: { synthetic: true, kind },
      links: [{ rel: "synthetic-source", url: `https://synthetic.needl.test/${provider}/${id}` }],
      authenticity: "clearly-labeled-synthetic-demo",
      bodySha256: `synthetic-${id}`,
    },
  };
}

const issueScope: readonly [string, string][] = [["issue", "LIN-42"], ["environment", "production"]];
await runtime.process(syntheticEvent("linear-done", "linear", "work.issue_done", "2026-01-01T00:00:00Z", issueScope));
await runtime.process(syntheticEvent("gitlab-deploy", "gitlab", "fix.deployed", "2026-01-01T00:01:00Z", issueScope));
await runtime.process(syntheticEvent("sentry-recurrence", "sentry", "error.recurred", "2026-01-01T00:02:00Z", issueScope));

const featureScope: readonly [string, string][] = [["feature_flag", "checkout-v2"], ["environment", "production"]];
await runtime.process(syntheticEvent("flag-disabled", "launchdarkly", "feature.disabled", "2026-01-01T01:00:00Z", featureScope));
await runtime.process(syntheticEvent("attributed-error", "sentry", "feature.error", "2026-01-01T01:01:00Z", featureScope));

const orderScope: readonly [string, string][] = [["customer", "cus_demo"], ["order", "order_demo"]];
await runtime.process(syntheticEvent("stripe-payment", "stripe", "payment.succeeded", "2026-01-01T02:00:00Z", orderScope));
await runtime.process(syntheticEvent("provisioning-failed", "posthog", "provisioning.failed", "2026-01-01T02:01:00Z", orderScope));
await runtime.advanceTime({
  id: "deadline-tick",
  tenantId,
  assertionId: "provisioning-support",
  assertionVersion: 1,
  scope: { customer: "cus_demo", order: "order_demo" },
  at: "2026-01-01T02:11:00Z",
});

const counterexamples = await store.listViolations();
const outbox = await store.listOutbox("pending");
process.stdout.write(`${JSON.stringify({
  notice: "All observations below are synthetic; no provider was contacted.",
  counterexampleCount: counterexamples.length,
  counterexamples,
  pendingDispatchRequests: outbox,
}, null, 2)}\n`);
store.close();
