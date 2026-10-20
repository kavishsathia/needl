import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeEvent, type SimulatedValue } from "../../simulator/encoders.js";
import * as adapters from "../../../src/adapters/index.js";
import type { WebhookAdapter } from "../../../src/core/types.js";
import { InMemoryMonitorStore, RuntimeMonitor, type AssertionDefinition } from "../../../src/ltl/index.js";
import { compileRuleDefinition } from "../src/ruleDrafts.js";

// Every rule in docs/use-cases.md, played against signed webhooks through the real adapters and monitor.
const doc = readFileSync(new URL("../../../docs/use-cases.md", import.meta.url), "utf8");
const sources = [...doc.matchAll(/```text\n([\s\S]*?)```/g)].map((match) => match[1]!.trim());
const tenantId = "ten_use_cases";
const definitions: AssertionDefinition[] = sources.map((source, index) => {
  const id = `rule-${index}`;
  return { ...compileRuleDefinition({ source, values: {} }, { id, name: /rule "([^"]+)"/.exec(source)![1]!, version: 1 }), tenantId };
});
const ruleId = (title: string): string => {
  const index = sources.findIndex((source) => source.startsWith(`rule "${title}`));
  if (index < 0) throw new Error(`No use case starts with "${title}"`);
  return `rule-${index}`;
};

const secret = `whsec_${Buffer.from("use-case-test-secret").toString("base64")}`;
const adapterFor: Record<string, WebhookAdapter<never>> = {
  sentry: new adapters.SentryAdapter(), gitlab: new adapters.GitLabAdapter(), launchdarkly: new adapters.LaunchDarklyAdapter(),
  linear: new adapters.LinearAdapter(), stripe: new adapters.StripeAdapter(), posthog: new adapters.PostHogAdapter(), intercom: new adapters.IntercomAdapter(),
} as never;
const start = Date.parse("2026-10-20T06:00:00Z");
type Step = readonly [minutes: number, key: string, values: Record<string, SimulatedValue>];

/** Plays the steps in order, then moves the clock to `thenMinutes`, and returns the rules that broke. */
async function play(steps: readonly Step[], thenMinutes: number): Promise<string[]> {
  const store = new InMemoryMonitorStore();
  const monitor = new RuntimeMonitor({ store, assertions: definitions, reorderToleranceMs: 300_000 });
  const broke = new Set<string>();
  for (const [minutes, key, values] of steps) {
    const at = new Date(start + minutes * 60_000);
    const delivery = encodeEvent(key, values, at, secret);
    const provider = key.split(".")[0]!;
    const headers = Object.fromEntries(Object.entries(delivery.headers).map(([name, value]) => [name.toLowerCase(), value]));
    const result = await adapterFor[provider]!.ingest({ tenantId, rawBody: Buffer.from(delivery.body), headers, receivedAt: at }, { secrets: [secret], authMode: "signing-token", authentication: { mode: "standard-webhooks" } } as never);
    if (result.status !== "accepted") throw new Error(`${key} was not accepted: ${JSON.stringify(result)}`);
    for (const outcome of await monitor.process(result.event)) if (outcome.outcome === "applied" && outcome.violationIds.length > 0) broke.add(outcome.assertionId);
  }
  const at = new Date(start + thenMinutes * 60_000).toISOString();
  for (const checkpoint of await store.listCheckpoints()) {
    if (checkpoint.finalized || checkpoint.nextDueAt === undefined || checkpoint.nextDueAt > at) continue;
    const outcome = await monitor.advanceTime({ id: `tick-${checkpoint.key}`, tenantId, assertionId: checkpoint.assertionId, assertionVersion: checkpoint.assertionVersion, scope: checkpoint.scope, at });
    if (outcome.outcome === "applied" && outcome.violationIds.length > 0) broke.add(checkpoint.assertionId);
  }
  return [...broke].sort();
}

const cases: readonly { name: string; steps: readonly Step[]; then: number; breaks: readonly string[] }[] = [
  { name: "a red main branch nobody fixes", steps: [[0, "gitlab.pipeline", { status: "failed", ref: "main" }]], then: 61, breaks: ["When a pipeline on"] },
  { name: "a red main branch fixed in time", steps: [[0, "gitlab.pipeline", { status: "failed", ref: "main" }], [20, "gitlab.pipeline", { status: "success", ref: "main" }]], then: 61, breaks: [] },
  { name: "a deploy whose Linear issue stays open", steps: [[0, "gitlab.deployment", { status: "success", environment: "production", ref: "csg-9-fix" }]], then: 60 * 25, breaks: ["Once a branch for an issue"] },
  { name: "a deploy whose Linear issue is completed", steps: [[0, "gitlab.deployment", { status: "success", environment: "production", ref: "csg-9-fix" }], [60, "linear.issue", { action: "update", identifier: "CSG-9", state_type: "completed" }]], then: 60 * 25, breaks: [] },
  { name: "a fixed issue's error comes back", steps: [[0, "gitlab.deployment", { status: "success", environment: "production", ref: "csg-9-fix" }], [10, "sentry.error", { environment: "production", "tags.linear_issue": "CSG-9" }]], then: 11, breaks: ["Once a fix for an issue"] },
  { name: "another issue's error after a fix", steps: [[0, "gitlab.deployment", { status: "success", environment: "production", ref: "csg-9-fix" }], [10, "sentry.error", { environment: "production", "tags.linear_issue": "CSG-10" }]], then: 11, breaks: [] },
  { name: "a critical alert right after a flag goes on", steps: [[0, "launchdarkly.flag", { actions: "updateOn", environment: "production" }], [5, "sentry.metric_alert", { action: "critical", alert_rule: "11" }], [6, "sentry.metric_alert", { action: "resolved", alert_rule: "11" }]], then: 10, breaks: ["For {time_limit} after a flag"] },
  { name: "a critical alert long after a flag goes on", steps: [[0, "launchdarkly.flag", { actions: "updateOn", environment: "production" }], [45, "sentry.metric_alert", { action: "critical", alert_rule: "12" }], [46, "sentry.metric_alert", { action: "resolved", alert_rule: "12" }]], then: 50, breaks: [] },
  { name: "a critical alert left firing", steps: [[0, "sentry.metric_alert", { action: "critical", alert_rule: "10" }]], then: 61, breaks: ["A critical metric alert"] },
  { name: "a fatal issue nobody owns", steps: [[0, "sentry.issue", { action: "created", level: "fatal", issue: "111" }]], then: 31, breaks: ["Every new fatal Sentry issue"] },
  { name: "a fatal issue assigned in time", steps: [[0, "sentry.issue", { action: "created", level: "fatal", issue: "222" }], [5, "sentry.issue", { action: "assigned", issue: "222" }]], then: 31, breaks: [] },
  { name: "an invoice paid twice", steps: [[0, "stripe.invoice_payment.paid", { invoice: "in_1", payment_intent: "pi_1" }], [1, "stripe.invoice_payment.paid", { invoice: "in_1", payment_intent: "pi_2" }]], then: 2, breaks: ["An invoice must never be paid"] },
  { name: "a paid invoice with a failed attempt after", steps: [[0, "stripe.invoice_payment.paid", { invoice: "in_2", payment_intent: "pi_3" }], [1, "stripe.invoice.payment_failed", { id: "in_2", customer: "cus_1" }]], then: 2, breaks: ["Once an invoice is paid"] },
  { name: "a failed payment nobody acts on", steps: [[0, "stripe.invoice.payment_failed", { id: "in_3", customer: "cus_2" }]], then: 60 * 24 * 8, breaks: ["After an invoice payment fails"] },
  { name: "a failed first payment whose subscription expires", steps: [[0, "stripe.invoice.payment_failed", { id: "in_4", customer: "cus_3" }], [10, "stripe.customer.subscription.updated", { customer: "cus_3", status: "incomplete_expired" }]], then: 60 * 24 * 8, breaks: [] },
  { name: "a test-mode charge", steps: [[0, "stripe.charge.succeeded", { livemode: false }]], then: 1, breaks: ["Production must never record"] },
  { name: "a test-mode charge delivered a second late", steps: [[0, "stripe.invoice_payment.paid", { invoice: "in_5", payment_intent: "pi_5" }], [-0.02, "stripe.charge.succeeded", { livemode: false }]], then: 1, breaks: ["Production must never record"] },
  { name: "a disputed payment charged again", steps: [[0, "stripe.charge.dispute.created", { payment_intent: "pi_9" }], [5, "stripe.charge.succeeded", { payment_intent: "pi_9", livemode: true }]], then: 6, breaks: ["Once a payment is disputed"] },
  { name: "an urgent issue nobody starts", steps: [[0, "linear.issue", { action: "create", priority: 1, identifier: "CSG-11", state_type: "backlog" }]], then: 61, breaks: ["An urgent Linear issue"] },
  { name: "an urgent issue started in time", steps: [[0, "linear.issue", { action: "create", priority: 1, identifier: "CSG-9", state_type: "backlog" }], [1, "linear.issue", { action: "update", identifier: "CSG-9", state_type: "started" }]], then: 61, breaks: [] },
  { name: "a breached SLA", steps: [[0, "linear.issue_sla", { action: "breached" }]], then: 1, breaks: ["No Linear issue SLA"] },
  { name: "a conversation closed without a reply", steps: [[0, "intercom.conversation.user.created", { id: "c2" }], [10, "intercom.conversation.admin.closed", { id: "c2" }]], then: 61, breaks: ["Every conversation a customer starts", "A customer conversation must never"] },
  { name: "a conversation answered then closed", steps: [[0, "intercom.conversation.user.created", { id: "c1" }], [10, "intercom.conversation.admin.replied", { id: "c1" }], [20, "intercom.conversation.admin.closed", { id: "c1" }]], then: 61, breaks: [] },
  { name: "events after an account is deleted", steps: [[0, "posthog.event", { event: "account_deleted", distinct_id: "p1" }], [1, "posthog.event", { event: "$pageview", distinct_id: "p1" }]], then: 2, breaks: ["Once a person deletes"] },
  { name: "another person's events after a deletion", steps: [[0, "posthog.event", { event: "account_deleted", distinct_id: "p1" }], [1, "posthog.event", { event: "$pageview", distinct_id: "p2" }]], then: 2, breaks: [] },
];

describe("business invariants in docs/use-cases.md", () => {
  it("lists sixteen rules", () => { expect(sources).toHaveLength(16); });
  for (const testCase of cases) {
    it(`${testCase.breaks.length === 0 ? "holds for" : "catches"} ${testCase.name}`, async () => {
      expect(await play(testCase.steps, testCase.then)).toEqual(testCase.breaks.map(ruleId).sort());
    });
  }
});
