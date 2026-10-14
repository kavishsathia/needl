import { describe, expect, it } from "vitest";
import type { NormalizedEvent, Provider, RelationshipEvidence } from "../src/core/index.js";
import {
  InMemoryMonitorStore,
  RuntimeMonitor,
  disabledFeatureErrorAssertion,
  linkedIssueRecurrenceAssertion,
  provisioningSupportDeadlineAssertion,
} from "../src/ltl/index.js";

function event(input: {
  id: string;
  provider: Provider;
  kind: string;
  at: string;
  relationships: readonly [string, string][];
}): NormalizedEvent {
  return {
    id: input.id,
    provider: input.provider,
    providerEventType: input.kind,
    tenantId: "acme",
    source: {},
    occurredAt: input.at,
    receivedAt: input.at,
    kind: input.kind,
    subject: { type: "synthetic-demo-observation", id: input.id },
    relationships: input.relationships.map(([type, id], index): RelationshipEvidence => ({
      type, id, evidencePath: `/synthetic/relationships/${index}`,
    })),
    evidence: {
      providerPayload: { synthetic: true, scenario: input.kind },
      links: [{ rel: "source", url: `https://synthetic.needl.test/${input.provider}/${input.id}` }],
      authenticity: "clearly-labeled-synthetic-demo",
      bodySha256: input.id,
    },
  };
}

describe("cross-provider monitoring scenarios", () => {
  it("requires Linear Done and a linked GitLab deployment before matching Sentry recurrence", async () => {
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [linkedIssueRecurrenceAssertion("acme")] });
    const scope = (issue: string, environment: string): readonly [string, string][] => [["issue", issue], ["environment", environment]];

    await monitor.process(event({ id: "linear-done", provider: "linear", kind: "work.issue_done", at: "2026-01-01T00:00:00Z", relationships: scope("LIN-7", "production") }));
    await monitor.process(event({ id: "gitlab-deploy", provider: "gitlab", kind: "fix.deployed", at: "2026-01-01T00:01:00Z", relationships: scope("LIN-7", "production") }));
    await monitor.process(event({ id: "wrong-issue", provider: "sentry", kind: "error.recurred", at: "2026-01-01T00:02:00Z", relationships: scope("LIN-8", "production") }));
    await monitor.process(event({ id: "wrong-environment", provider: "sentry", kind: "error.recurred", at: "2026-01-01T00:03:00Z", relationships: scope("LIN-7", "staging") }));
    expect(await store.listViolations()).toHaveLength(0);

    expect((await monitor.process(event({ id: "matching-recurrence", provider: "sentry", kind: "error.recurred", at: "2026-01-01T00:04:00Z", relationships: scope("LIN-7", "production") })))[0])
      .toMatchObject({ verdict: "violated", scope: { issue: "LIN-7", environment: "production" } });
    expect((await store.listViolations())[0]!.sourceEvents.map((source) => source.provider)).toEqual(["linear", "gitlab", "sentry"]);
  });

  it("persists LaunchDarkly disabled state, honors re-enable, and isolates unrelated feature errors", async () => {
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [disabledFeatureErrorAssertion("acme")] });
    const scope = (feature: string): readonly [string, string][] => [["feature_flag", feature], ["environment", "production"]];

    await monitor.process(event({ id: "disable", provider: "launchdarkly", kind: "feature.disabled", at: "2026-01-01T00:00:00Z", relationships: scope("checkout-v2") }));
    await monitor.process(event({ id: "unrelated-error", provider: "sentry", kind: "feature.error", at: "2026-01-01T00:01:00Z", relationships: scope("search-v2") }));
    await monitor.process(event({ id: "enable", provider: "launchdarkly", kind: "feature.enabled", at: "2026-01-01T00:02:00Z", relationships: scope("checkout-v2") }));
    await monitor.process(event({ id: "enabled-error", provider: "sentry", kind: "feature.error", at: "2026-01-01T00:03:00Z", relationships: scope("checkout-v2") }));
    expect(await store.listViolations()).toHaveLength(0);

    await monitor.process(event({ id: "disable-again", provider: "launchdarkly", kind: "feature.disabled", at: "2026-01-01T00:04:00Z", relationships: scope("checkout-v2") }));
    await monitor.process(event({ id: "disabled-error", provider: "sentry", kind: "feature.error", at: "2026-01-01T00:05:00Z", relationships: scope("checkout-v2") }));
    expect(await store.listViolations()).toEqual([
      expect.objectContaining({ scope: { feature: "checkout-v2", environment: "production" }, cause: "formula_false" }),
    ]);
  });

  it("requires payment plus explicit provisioning failure and only accepts the matching Intercom ticket", async () => {
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [provisioningSupportDeadlineAssertion("acme", 600_000)] });
    const scope = (customer: string, order: string): readonly [string, string][] => [["customer", customer], ["order", order]];

    // Payment alone never creates a provisioning-failure obligation.
    await monitor.process(event({ id: "pay-no-failure", provider: "stripe", kind: "payment.succeeded", at: "2026-01-01T00:00:00Z", relationships: scope("cus-1", "order-1") }));
    await monitor.advanceTime({ id: "tick-no-failure", tenantId: "acme", assertionId: "provisioning-support", assertionVersion: 1, scope: { customer: "cus-1", order: "order-1" }, at: "2026-01-01T00:20:00Z" });
    expect(await store.listViolations()).toHaveLength(0);

    await monitor.process(event({ id: "pay", provider: "stripe", kind: "payment.succeeded", at: "2026-01-01T01:00:00Z", relationships: scope("cus-2", "order-2") }));
    await monitor.process(event({ id: "provision-fail", provider: "posthog", kind: "provisioning.failed", at: "2026-01-01T01:01:00Z", relationships: scope("cus-2", "order-2") }));
    await monitor.process(event({ id: "wrong-ticket", provider: "intercom", kind: "support.ticket_created", at: "2026-01-01T01:02:00Z", relationships: scope("cus-2", "order-other") }));
    await monitor.advanceTime({ id: "expire-order-2", tenantId: "acme", assertionId: "provisioning-support", assertionVersion: 1, scope: { customer: "cus-2", order: "order-2" }, at: "2026-01-01T01:11:00Z" });
    expect(await store.listViolations()).toEqual([
      expect.objectContaining({ cause: "deadline_expired", triggerEventId: "provision-fail", scope: { customer: "cus-2", order: "order-2" } }),
    ]);

    await monitor.process(event({ id: "pay-3", provider: "stripe", kind: "payment.succeeded", at: "2026-01-01T02:00:00Z", relationships: scope("cus-3", "order-3") }));
    await monitor.process(event({ id: "fail-3", provider: "posthog", kind: "provisioning.failed", at: "2026-01-01T02:01:00Z", relationships: scope("cus-3", "order-3") }));
    await monitor.process(event({ id: "ticket-3", provider: "intercom", kind: "support.ticket_created", at: "2026-01-01T02:09:00Z", relationships: scope("cus-3", "order-3") }));
    await monitor.advanceTime({ id: "tick-3", tenantId: "acme", assertionId: "provisioning-support", assertionVersion: 1, scope: { customer: "cus-3", order: "order-3" }, at: "2026-01-01T02:11:00Z" });
    expect(await store.listViolations()).toHaveLength(1);
  });
});

