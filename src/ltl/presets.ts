import type { AssertionDefinition, Predicate } from "./assertion.js";
import { parseFormula } from "./formula.js";

function eventIs(provider: string, kind: string): Predicate {
  return {
    op: "and",
    operands: [
      { op: "equal", path: { root: "event", segments: ["provider"] }, value: provider },
      { op: "equal", path: { root: "event", segments: ["kind"] }, value: kind },
    ],
  };
}

/**
 * Demo preset. `work.issue_done` and `fix.deployed` are deliberate configured
 * kind mappings, and every participating event must carry explicit issue and
 * environment relationships.
 */
export function linkedIssueRecurrenceAssertion(tenantId: string): AssertionDefinition {
  return {
    id: "linked-issue-recurrence",
    version: 1,
    tenantId,
    name: "A completed and deployed issue must not recur",
    formula: parseFormula("G (ready_deployment -> G !recurrence)"),
    scope: { keys: [
      { name: "issue", extractors: [{ from: "relationship", type: "issue" }] },
      { name: "environment", extractors: [{ from: "relationship", type: "environment" }] },
    ] },
    propositions: [
      {
        name: "ready_deployment",
        predicate: {
          op: "and",
          operands: [
            eventIs("gitlab", "fix.deployed"),
            { op: "equal", path: { root: "state", segments: ["linearDone"] }, value: true },
          ],
        },
      },
      { name: "recurrence", predicate: eventIs("sentry", "error.recurred") },
    ],
    stateUpdates: [
      { when: eventIs("linear", "work.issue_done"), set: { linearDone: { from: "literal", value: true } } },
      { when: eventIs("linear", "work.issue_reopened"), set: { linearDone: { from: "literal", value: false } } },
    ],
  };
}

/** Every Sentry feature error is explicitly attributed by feature/environment relationships. */
export function disabledFeatureErrorAssertion(tenantId: string): AssertionDefinition {
  return {
    id: "disabled-feature-error",
    version: 1,
    tenantId,
    name: "A disabled feature must not execute with an error",
    formula: parseFormula("G !(disabled & feature_error)"),
    scope: { keys: [
      { name: "feature", extractors: [{ from: "relationship", type: "feature_flag" }] },
      { name: "environment", extractors: [{ from: "relationship", type: "environment" }] },
    ] },
    propositions: [
      { name: "disabled", predicate: { op: "equal", path: { root: "state", segments: ["enabled"] }, value: false } },
      { name: "feature_error", predicate: eventIs("sentry", "feature.error") },
    ],
    stateUpdates: [
      { when: eventIs("launchdarkly", "feature.disabled"), set: { enabled: { from: "literal", value: false } } },
      { when: eventIs("launchdarkly", "feature.enabled"), set: { enabled: { from: "literal", value: true } } },
    ],
  };
}

/**
 * Demo timed extension. Order is an upstream explicit relationship because it
 * is not guaranteed by the provider adapters themselves.
 */
export function provisioningSupportDeadlineAssertion(
  tenantId: string,
  withinMs = 600_000,
): AssertionDefinition {
  return {
    id: "provisioning-support",
    version: 1,
    tenantId,
    name: "Paid provisioning failures receive a support ticket",
    formula: {
      kind: "deadline",
      trigger: { kind: "atom", name: "paid_provisioning_failure" },
      response: { kind: "atom", name: "support_ticket" },
      withinMs,
    },
    scope: { keys: [
      { name: "customer", extractors: [{ from: "relationship", type: "customer" }] },
      { name: "order", extractors: [{ from: "relationship", type: "order" }] },
    ] },
    propositions: [
      {
        name: "paid_provisioning_failure",
        predicate: {
          op: "and",
          operands: [
            eventIs("posthog", "provisioning.failed"),
            { op: "equal", path: { root: "state", segments: ["paymentReceived"] }, value: true },
          ],
        },
      },
      { name: "support_ticket", predicate: eventIs("intercom", "support.ticket_created") },
    ],
    stateUpdates: [
      { when: eventIs("stripe", "payment.succeeded"), set: { paymentReceived: { from: "literal", value: true } } },
      { when: eventIs("stripe", "payment.failed"), set: { paymentReceived: { from: "literal", value: false } } },
    ],
  };
}
