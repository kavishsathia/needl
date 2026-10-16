import type { NormalizedEvent, Provider, RelationshipEvidence } from "../../src/core/types.js";
import {
  InMemoryMonitorStore,
  RuntimeMonitor,
  provisioningSupportDeadlineAssertion,
} from "../../src/ltl/index.js";
import type { AssertionDefinition } from "../../src/ltl/assertion.js";
import type {
  AssertionDraft,
  DemoBootstrap,
  DemoReplay,
  DemoReplayRequest,
} from "./src/domain.js";
import { validateAssertionCollection } from "./src/collection.js";
import { DEMO_TENANT_ID } from "./src/domain.js";
import { exampleRules } from "./src/examples.js";

export const TENANT_ID = DEMO_TENANT_ID;
export const DEMO_ANCHOR = "2026-02-18T10:40:00.000Z";
export const DEMO_REPLAY_HORIZON = "2026-02-18T12:11:00.000Z";

/** Internal-only fixture retained to verify generic deadline replay behavior. */
export const legacyProvisioningDefinition = provisioningSupportDeadlineAssertion(TENANT_ID, 600_000);

export function getDemoBootstrap(): DemoBootstrap {
  return {
    mode: "deterministic-local-demo",
    anchorTime: DEMO_ANCHOR,
    examples: structuredClone(exampleRules),
  };
}

function relationship(type: string, id: string, index: number): RelationshipEvidence {
  return { type, id, evidencePath: `/synthetic/relationships/${index}` };
}

function event(
  id: string,
  provider: Provider,
  providerEventType: string,
  kind: string,
  at: string,
  relationships: readonly [string, string][],
  subject: { readonly type: string; readonly id: string; readonly name: string },
  /** Fields the real adapter projects for this event type, so rules read sample events exactly like live ones. */
  projection: Readonly<Record<string, unknown>> = {},
): NormalizedEvent {
  return {
    id,
    provider,
    providerEventType,
    tenantId: TENANT_ID,
    source: { id: `demo-${provider}` },
    occurredAt: at,
    receivedAt: at,
    kind,
    subject,
    relationships: relationships.map(([type, relationshipId], index) => relationship(type, relationshipId, index)),
    evidence: {
      providerPayload: { ...projection, synthetic: true, fixture: id, kind },
      links: [{ rel: "synthetic-reference", url: `https://synthetic.needl.test/${provider}/${id}` }],
      authenticity: "clearly-labeled-synthetic-demo",
      bodySha256: `synthetic-sha256-${id}`,
    },
  };
}

function eventsFor(scenario: DemoReplayRequest["scenario"]): readonly NormalizedEvent[] {
  const violating = scenario === "violating";
  const legacyProvisioning: readonly [string, string][] = [["customer", "cus_legacy"], ["order", "ord_legacy"]];
  const base: NormalizedEvent[] = [
    event("gitlab-deploy", "gitlab", "deployment.success", "deployment", "2026-02-18T10:40:00.000Z",
      [["project", "7"], ["repository", "acme/shop"], ["ref", "eng-42-fix-retry-loop"], ["environment", "production"]],
      { type: "deployment", id: "241", name: "Production deploy 241" }, { objectKind: "deployment", action: "success", status: "success", ref: "eng-42-fix-retry-loop", projectId: 7, projectPath: "acme/shop" }),
    violating
      ? event("sentry-ghost", "sentry", "event_alert.triggered", "error.event_alert", "2026-02-18T10:47:00.000Z",
        [["project", "shop"], ["environment", "production"], ["tag.linear_issue", "ENG-42"]],
        { type: "error_event", id: "evt-ghost-42", name: "Checkout retry loop is back" }, { action: "triggered", resource: "event_alert", level: "error" })
      : event("sentry-unrelated", "sentry", "event_alert.triggered", "error.event_alert", "2026-02-18T10:47:00.000Z",
        [["project", "shop"], ["environment", "production"], ["tag.linear_issue", "ENG-7"]],
        { type: "error_event", id: "evt-unrelated-7", name: "Avatar upload timeout" }, { action: "triggered", resource: "event_alert", level: "error" }),
    event("sentry-resolved", "sentry", "issue.resolved", "error.issue", "2026-02-18T11:00:00.000Z",
      [["project", "shop"]], { type: "issue", id: "4815", name: "CheckoutError: card token expired" }, { action: "resolved", resource: "issue", status: "resolved" }),
    violating
      ? event("sentry-boomerang", "sentry", "issue.unresolved", "error.issue", "2026-02-18T11:05:00.000Z",
        [["project", "shop"]], { type: "issue", id: "4815", name: "CheckoutError: card token expired" }, { action: "unresolved", resource: "issue", status: "unresolved" })
      : event("sentry-other-unresolved", "sentry", "issue.unresolved", "error.issue", "2026-02-18T11:05:00.000Z",
        [["project", "shop"]], { type: "issue", id: "1623", name: "SearchError: index unavailable" }, { action: "unresolved", resource: "issue", status: "unresolved" }),
    event("legacy-stripe-payment", "stripe", "payment.succeeded", "payment.succeeded", "2026-02-18T11:58:00.000Z", legacyProvisioning, { type: "payment", id: "pi_legacy", name: "Legacy deadline fixture payment" }),
    event("legacy-provisioning-failed", "posthog", "provisioning.failed", "provisioning.failed", "2026-02-18T11:59:00.000Z", legacyProvisioning, { type: "product_event", id: "evt_legacy", name: "Legacy deadline fixture failure" }),
    event("stripe-canceled", "stripe", "customer.subscription.deleted", "subscription.deleted", "2026-02-18T12:00:00.000Z",
      [["customer", "cus_acme"]], { type: "subscription", id: "sub_acme", name: "Acme Pro plan" }),
    violating
      ? event("stripe-charged-again", "stripe", "invoice.paid", "invoice.paid", "2026-02-18T12:03:00.000Z",
        [["customer", "cus_acme"], ["subscription", "sub_acme"]], { type: "invoice", id: "in_acme_after_cancel", name: "Invoice after cancellation" })
      : event("stripe-other-customer", "stripe", "invoice.paid", "invoice.paid", "2026-02-18T12:03:00.000Z",
        [["customer", "cus_globex"], ["subscription", "sub_globex"]], { type: "invoice", id: "in_globex", name: "Globex renewal" }),
  ];
  if (!violating) base.push(event("legacy-support-ticket", "intercom", "support.ticket_created", "support.ticket_created", "2026-02-18T12:08:00.000Z", legacyProvisioning, { type: "ticket", id: "ticket-legacy", name: "Legacy deadline fixture support" }));
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
  // The sample ends with an explicit clock tick so time limits still open at the end can expire.
  const timed = new Set(active.filter((draft) => draft.definition.formula.kind === "deadline").map((draft) => `${draft.definition.id}@${draft.definition.version}`));
  const openWindows = (await store.listCheckpoints()).filter((checkpoint) =>
    !checkpoint.finalized && (checkpoint.nextDueAt !== undefined || timed.has(`${checkpoint.assertionId}@${checkpoint.assertionVersion}`)));
  for (const [index, checkpoint] of openWindows.entries()) {
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
    unavailableAssertionIds: active.filter((draft) => !checkpointIds.has(draft.definition.id)).map((draft) => draft.localId),
  };
}
