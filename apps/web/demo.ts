import type { NormalizedEvent, Provider, RelationshipEvidence } from "../../src/core/types.js";
import {
  InMemoryMonitorStore,
  RuntimeMonitor,
  disabledFeatureErrorAssertion,
  linkedIssueRecurrenceAssertion,
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

export const TENANT_ID = "synthetic-demo";
export const DEMO_ANCHOR = "2026-02-18T10:40:00.000Z";

const definitions = {
  recurrence: linkedIssueRecurrenceAssertion(TENANT_ID),
  feature: disabledFeatureErrorAssertion(TENANT_ID),
  provisioning: provisioningSupportDeadlineAssertion(TENANT_ID, 600_000),
} as const;

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
    shortLabel: "A kill switch should kill it",
    description: "Persists LaunchDarkly flag state, then checks explicitly attributed Sentry feature errors.",
    providers: ["launchdarkly", "sentry"],
    definition: { ...definitions.feature, name: "A kill switch should kill it" },
  },
  {
    id: "provisioning",
    prompt: "A paid provisioning failure should receive support within ten minutes",
    shortLabel: "Failed provisioning gets support",
    description: "Opens a ten-minute obligation after explicit Stripe and PostHog evidence, scoped by customer and order.",
    providers: ["stripe", "posthog", "intercom"],
    definition: { ...definitions.provisioning, name: "Failed provisioning gets support" },
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
    event("stripe-payment", "stripe", "payment.succeeded", "2026-02-18T12:00:00.000Z", order, { type: "payment", id: "pi_demo_1042", name: "Acme payment" }),
    event("provisioning-failed", "posthog", "provisioning.failed", "2026-02-18T12:01:00.000Z", order, { type: "product_event", id: "evt_provision_1042", name: "Workspace provisioning failed" }),
  );
  if (scenario === "healthy") {
    base.push(event("support-ticket", "intercom", "support.ticket_created", "2026-02-18T12:08:00.000Z", order, { type: "ticket", id: "ticket-1042", name: "Provisioning help" }));
  }
  return base;
}

function validateDrafts(input: readonly AssertionDraft[]): readonly AssertionDraft[] {
  if (input.length > 25) throw new Error("Demo replay accepts at most 25 assertions");
  const ids = new Set<string>();
  for (const draft of input) {
    if (draft.localId !== draft.definition.id) throw new Error("Assertion localId must match definition id");
    if (draft.definition.tenantId !== TENANT_ID) throw new Error(`Demo assertions must use tenant ${TENANT_ID}`);
    if (ids.has(draft.localId)) throw new Error(`Duplicate assertion id ${draft.localId}`);
    ids.add(draft.localId);
  }
  return input;
}

export async function runDemoScenario(request: DemoReplayRequest): Promise<DemoReplay> {
  if (request.scenario !== "violating" && request.scenario !== "healthy") throw new Error("Unknown demo scenario");
  if (!Array.isArray(request.assertions)) throw new Error("assertions must be an array");
  const drafts = validateDrafts(request.assertions);
  const active = drafts.filter((draft) => draft.status === "monitoring");
  const assertions: readonly AssertionDefinition[] = active.map((draft) => draft.definition);
  const store = new InMemoryMonitorStore();
  const runtime = new RuntimeMonitor({ store, assertions });
  const events = eventsFor(request.scenario);
  const results = [];
  for (const item of events) results.push(...await runtime.process(item));
  const provisioning = active.find((draft) => draft.definition.id === definitions.provisioning.id);
  if (provisioning !== undefined) {
    results.push(await runtime.advanceTime({
      id: `deadline-tick-${request.scenario}`,
      tenantId: TENANT_ID,
      assertionId: provisioning.definition.id,
      assertionVersion: provisioning.definition.version,
      scope: { customer: "cus_acme", order: "ord_1042" },
      at: "2026-02-18T12:11:00.000Z",
    }));
  }
  const checkpoints = await store.listCheckpoints();
  const checkpointIds = new Set(checkpoints.map((checkpoint) => checkpoint.assertionId));
  return {
    mode: "deterministic-local-demo",
    replayedAt: "2026-02-18T12:11:00.000Z",
    scenario: request.scenario,
    events,
    results,
    checkpoints,
    violations: await store.listViolations(),
    outbox: await store.listOutbox(),
    unavailableAssertionIds: active.filter((draft) => !checkpointIds.has(draft.definition.id)).map((draft) => draft.localId),
  };
}
