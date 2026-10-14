import type { NormalizedEvent, Provider, RelationshipEvidence } from "../../src/core/types.js";
import {
  InMemoryMonitorStore,
  RuntimeMonitor,
  provisioningSupportDeadlineAssertion,
} from "../../src/ltl/index.js";
import type { AssertionDefinition } from "../../src/ltl/assertion.js";
import type {
  AssertionDraft,
  AuthoringTemplate,
  DemoBootstrap,
  DemoReplay,
  DemoReplayRequest,
} from "./src/domain.js";
import { validateAssertionCollection } from "./src/collection.js";
import { DEMO_TENANT_ID } from "./src/domain.js";
import { buildTemplateDefinition, defaultMeaningValues, meaningHasFixtureEvidence } from "./src/meaning.js";

export const TENANT_ID = DEMO_TENANT_ID;
export const DEMO_ANCHOR = "2026-02-18T10:40:00.000Z";
export const DEMO_REPLAY_HORIZON = "2026-02-18T12:11:00.000Z";

const definitions = {
  recurrence: buildTemplateDefinition("recurrence", defaultMeaningValues("recurrence"), { id: "linked-issue-recurrence", name: "Fixed means fixed", version: 1, tenantId: TENANT_ID }),
  feature: buildTemplateDefinition("feature", defaultMeaningValues("feature"), { id: "disabled-feature-error", name: "Off means off", version: 1, tenantId: TENANT_ID }),
  order: buildTemplateDefinition("order", defaultMeaningValues("order"), { id: "order-before-payment", name: "Payment before fulfillment", version: 1, tenantId: TENANT_ID }),
  provisioning: provisioningSupportDeadlineAssertion(TENANT_ID, 600_000),
} as const;

/** Internal-only fixture retained to verify generic deadline replay behavior. */
export const legacyProvisioningDefinition = definitions.provisioning;

export const authoringTemplates: readonly AuthoringTemplate[] = [
  {
    id: "recurrence",
    prompt: "When a fix is deployed, the linked issue should not recur",
    shortLabel: "Fixed means fixed",
    description: "Correlates Linear completion, a linked GitLab deployment, and Sentry recurrence by issue and environment.",
    providers: ["linear", "gitlab", "sentry"],
    definition: { ...definitions.recurrence, name: "Fixed means fixed" },
  },
  {
    id: "feature",
    prompt: "While a feature is disabled, attributed errors should not occur",
    shortLabel: "Off means off",
    description: "Persists LaunchDarkly flag state, then checks explicitly attributed Sentry feature errors.",
    providers: ["launchdarkly", "sentry"],
    definition: definitions.feature,
  },
  {
    id: "order",
    prompt: "An order must not be fulfilled before payment is observed",
    shortLabel: "Payment before fulfillment",
    description: "Starts at an observed order-accepted boundary, then uses correlated Stripe payment and PostHog fulfillment evidence.",
    providers: ["stripe", "posthog"],
    definition: definitions.order,
  },
];

export function getDemoBootstrap(): DemoBootstrap {
  return {
    mode: "deterministic-local-demo",
    anchorTime: DEMO_ANCHOR,
    templates: structuredClone(authoringTemplates),
  };
}

function relationship(type: string, id: string, index: number): RelationshipEvidence {
  return { type, id, evidencePath: `/synthetic/relationships/${index}` };
}

function event(
  id: string,
  provider: Provider,
  kind: string,
  at: string,
  relationships: readonly [string, string][],
  subject: { readonly type: string; readonly id: string; readonly name: string },
): NormalizedEvent {
  return {
    id,
    provider,
    providerEventType: kind,
    tenantId: TENANT_ID,
    source: { id: `demo-${provider}` },
    occurredAt: at,
    receivedAt: at,
    kind,
    subject,
    relationships: relationships.map(([type, relationshipId], index) => relationship(type, relationshipId, index)),
    evidence: {
      providerPayload: { synthetic: true, fixture: id, kind },
      links: [{ rel: "synthetic-reference", url: `https://synthetic.needl.test/${provider}/${id}` }],
      authenticity: "clearly-labeled-synthetic-demo",
      bodySha256: `synthetic-sha256-${id}`,
    },
  };
}

function eventsFor(scenario: DemoReplayRequest["scenario"]): readonly NormalizedEvent[] {
  const issue: readonly [string, string][] = [["issue", "LIN-42"], ["environment", "production"]];
  const feature: readonly [string, string][] = [["feature_flag", "checkout-v2"], ["environment", "production"]];
  const order: readonly [string, string][] = [["customer", "cus_acme"], ["order", "ord_1042"]];
  const legacyProvisioning: readonly [string, string][] = [["customer", "cus_legacy"], ["order", "ord_legacy"]];
  const base: NormalizedEvent[] = [
    event("linear-done", "linear", "work.issue_done", "2026-02-18T10:40:00.000Z", issue, { type: "issue", id: "LIN-42", name: "Checkout retry loop" }),
    event("gitlab-deploy", "gitlab", "fix.deployed", "2026-02-18T10:42:00.000Z", issue, { type: "deployment", id: "deploy-241", name: "Production deploy 241" }),
  ];
  if (scenario === "violating") {
    base.push(event("sentry-recurrence", "sentry", "error.recurred", "2026-02-18T10:47:00.000Z", issue, { type: "issue", id: "SENTRY-42", name: "Checkout retry loop recurred" }));
  }
  base.push(
    event("flag-disabled", "launchdarkly", "feature.disabled", "2026-02-18T11:00:00.000Z", feature, { type: "feature_flag", id: "checkout-v2", name: "Checkout v2" }),
  );
  if (scenario === "healthy") {
    base.push(event("flag-enabled", "launchdarkly", "feature.enabled", "2026-02-18T11:04:00.000Z", feature, { type: "feature_flag", id: "checkout-v2", name: "Checkout v2" }));
  }
  base.push(
    event("feature-error", "sentry", "feature.error", "2026-02-18T11:05:00.000Z", feature, { type: "issue", id: "SENTRY-77", name: "Checkout v2 error" }),
    event("legacy-stripe-payment", "stripe", "payment.succeeded", "2026-02-18T11:58:00.000Z", legacyProvisioning, { type: "payment", id: "pi_legacy", name: "Legacy deadline fixture payment" }),
    event("legacy-provisioning-failed", "posthog", "provisioning.failed", "2026-02-18T11:59:00.000Z", legacyProvisioning, { type: "product_event", id: "evt_legacy", name: "Legacy deadline fixture failure" }),
    event("order-accepted", "posthog", "order.accepted", "2026-02-18T12:00:00.000Z", order, { type: "order", id: "ord_1042", name: "Order 1042 accepted" }),
  );
  if (scenario === "healthy") base.push(event("stripe-payment", "stripe", "payment.succeeded", "2026-02-18T12:01:00.000Z", order, { type: "payment", id: "pi_demo_1042", name: "Payment for order 1042" }));
  base.push(event("order-fulfilled", "posthog", "order.fulfilled", "2026-02-18T12:02:00.000Z", order, { type: "order", id: "ord_1042", name: "Order 1042 fulfilled" }));
  if (scenario === "violating") base.push(event("stripe-payment-late", "stripe", "payment.succeeded", "2026-02-18T12:03:00.000Z", order, { type: "payment", id: "pi_demo_1042", name: "Late payment for order 1042" }));
  else base.push(event("legacy-support-ticket", "intercom", "support.ticket_created", "2026-02-18T12:08:00.000Z", legacyProvisioning, { type: "ticket", id: "ticket-legacy", name: "Legacy deadline fixture support" }));
  return base;
}

export async function runDemoScenario(request: DemoReplayRequest): Promise<DemoReplay> {
  if (request.scenario !== "violating" && request.scenario !== "healthy") throw new Error("Unknown demo scenario");
  const drafts = validateAssertionCollection(request.assertions);
  const active = drafts.filter((draft) => draft.status === "monitoring");
  const assertions: readonly AssertionDefinition[] = active.map((draft) => draft.definition);
  const store = new InMemoryMonitorStore();
  const runtime = new RuntimeMonitor({ store, assertions });
  const events = eventsFor(request.scenario);
  const results = [];
  for (const item of events) results.push(...await runtime.process(item));
  const timedDefinitions = new Map(active
    .filter((draft) => draft.definition.formula.kind === "deadline")
    .map((draft) => [`${draft.definition.id}@${draft.definition.version}`, draft.definition]));
  const instantiatedTimedPartitions = (await store.listCheckpoints()).filter((checkpoint) =>
    timedDefinitions.has(`${checkpoint.assertionId}@${checkpoint.assertionVersion}`));
  for (const [index, checkpoint] of instantiatedTimedPartitions.entries()) {
    results.push(await runtime.advanceTime({
      id: `deadline-tick-${request.scenario}-${index}`,
      tenantId: checkpoint.tenantId,
      assertionId: checkpoint.assertionId,
      assertionVersion: checkpoint.assertionVersion,
      scope: checkpoint.scope,
      at: DEMO_REPLAY_HORIZON,
    }));
  }
  const checkpoints = await store.listCheckpoints();
  const checkpointIds = new Set(checkpoints.map((checkpoint) => checkpoint.assertionId));
  return {
    mode: "deterministic-local-demo",
    replayedAt: DEMO_REPLAY_HORIZON,
    scenario: request.scenario,
    events,
    results,
    checkpoints,
    violations: await store.listViolations(),
    outbox: await store.listOutbox(),
    unavailableAssertionIds: active.filter((draft) => !checkpointIds.has(draft.definition.id) || !meaningHasFixtureEvidence(draft)).map((draft) => draft.localId),
  };
}
