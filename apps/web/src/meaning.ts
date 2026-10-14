import { parseFormula } from "../../../src/ltl/formula.js";
import type { AssertionDefinition, Predicate } from "../../../src/ltl/assertion.js";
import type { AssertionDraft, TemplateId } from "./domain.js";
import { DEMO_TENANT_ID } from "./domain.js";

export interface MeaningOption {
  readonly value: string;
  readonly label: string;
  readonly evidence: "matched" | "none";
}

export interface MeaningField {
  readonly id: string;
  readonly accessibleLabel: string;
  readonly options: readonly MeaningOption[];
}

export type MeaningSegment = string | { readonly field: string };

export interface MeaningTemplate {
  readonly id: TemplateId;
  readonly fields: readonly MeaningField[];
  readonly sentence: readonly MeaningSegment[];
}

const eventIs = (provider: string, kind: string): Predicate => ({
  op: "and",
  operands: [
    { op: "equal", path: { root: "event", segments: ["provider"] }, value: provider },
    { op: "equal", path: { root: "event", segments: ["kind"] }, value: kind },
  ],
});

const relationshipIs = (index: number, value: string): Predicate => ({
  op: "equal",
  path: { root: "event", segments: ["relationships", String(index), "id"] },
  value,
});

const all = (...operands: Predicate[]): Predicate => operands.length === 1 ? operands[0]! : { op: "and", operands };
const atomSuffix = (value: string): string => value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase();

export const meaningTemplates: Readonly<Record<TemplateId, MeaningTemplate>> = {
  recurrence: {
    id: "recurrence",
    sentence: ["After ", { field: "trigger" }, ", ", { field: "subject" }, " must not ", { field: "outcome" }, " in ", { field: "environment" }, "."],
    fields: [
      { id: "trigger", accessibleLabel: "Trigger", options: [{ value: "deployed-fix", label: "a fix is deployed", evidence: "matched" }] },
      { id: "subject", accessibleLabel: "Protected subject", options: [{ value: "linked-issue", label: "the linked issue", evidence: "matched" }] },
      { id: "outcome", accessibleLabel: "Forbidden outcome", options: [{ value: "recur", label: "occur again", evidence: "matched" }] },
      { id: "environment", accessibleLabel: "Environment", options: [
        { value: "production", label: "Production", evidence: "matched" },
        { value: "staging", label: "Staging", evidence: "none" },
      ] },
    ],
  },
  feature: {
    id: "feature",
    sentence: ["While ", { field: "feature" }, " is ", { field: "state" }, ", ", { field: "outcome" }, " must not occur."],
    fields: [
      { id: "feature", accessibleLabel: "Feature", options: [
        { value: "checkout-v2", label: "checkout-v2", evidence: "matched" },
        { value: "recommendations-v1", label: "recommendations-v1", evidence: "none" },
      ] },
      { id: "state", accessibleLabel: "Flag state", options: [{ value: "disabled", label: "disabled", evidence: "matched" }] },
      { id: "outcome", accessibleLabel: "Forbidden outcome", options: [{ value: "feature-errors", label: "errors from the feature", evidence: "matched" }] },
    ],
  },
  order: {
    id: "order",
    sentence: ["After ", { field: "boundary" }, ", ", { field: "subject" }, " must not be ", { field: "outcome" }, "."],
    fields: [
      { id: "boundary", accessibleLabel: "Observed lifecycle boundary", options: [{ value: "accepted", label: "an order is accepted", evidence: "matched" }] },
      { id: "subject", accessibleLabel: "Order", options: [
        { value: "ord_1042", label: "order ord_1042", evidence: "matched" },
        { value: "ord_2048", label: "order ord_2048", evidence: "none" },
      ] },
      { id: "outcome", accessibleLabel: "Forbidden outcome", options: [{ value: "fulfilled-before-payment", label: "fulfilled before payment is observed", evidence: "matched" }] },
    ],
  },
};

export function defaultMeaningValues(templateId: TemplateId): Readonly<Record<string, string>> {
  return Object.fromEntries(meaningTemplates[templateId].fields.map((field) => [field.id, field.options[0]!.value]));
}

export function meaningOption(templateId: TemplateId, fieldId: string, value: string): MeaningOption | undefined {
  return meaningTemplates[templateId].fields.find((field) => field.id === fieldId)?.options.find((option) => option.value === value);
}

export function meaningHasFixtureEvidence(draft: AssertionDraft): boolean {
  if (draft.meaning === undefined) return true;
  return meaningTemplates[draft.meaning.templateId].fields.every((field) => {
    const option = meaningOption(draft.meaning!.templateId, field.id, draft.meaning!.values[field.id] ?? "");
    return option?.evidence === "matched";
  });
}

export function buildTemplateDefinition(
  templateId: TemplateId,
  values: Readonly<Record<string, string>>,
  identity: { readonly id: string; readonly name: string; readonly version: number; readonly tenantId?: string },
): AssertionDefinition {
  for (const field of meaningTemplates[templateId].fields) {
    if (meaningOption(templateId, field.id, values[field.id] ?? "") === undefined) throw new Error(`Unsupported ${field.accessibleLabel.toLowerCase()} choice`);
  }
  const common = { id: identity.id, name: identity.name, version: identity.version, tenantId: identity.tenantId ?? DEMO_TENANT_ID };
  if (templateId === "recurrence") {
    const environment = values.environment!;
    const suffix = atomSuffix(environment);
    const ready = `ready_deployment_${suffix}`;
    const recurrence = `recurrence_${suffix}`;
    const environmentPredicate = relationshipIs(1, environment);
    return {
      ...common,
      formula: parseFormula(`G (${ready} -> G !${recurrence})`),
      scope: { keys: [
        { name: "issue", extractors: [{ from: "relationship", type: "issue" }] },
        { name: "environment", extractors: [{ from: "literal", value: environment }] },
      ] },
      propositions: [
        { name: ready, predicate: all(eventIs("gitlab", "fix.deployed"), environmentPredicate, { op: "equal", path: { root: "state", segments: ["linearDone"] }, value: true }) },
        { name: recurrence, predicate: all(eventIs("sentry", "error.recurred"), environmentPredicate) },
      ],
      stateUpdates: [
        { when: all(eventIs("linear", "work.issue_done"), environmentPredicate), set: { linearDone: { from: "literal", value: true } } },
        { when: all(eventIs("linear", "work.issue_reopened"), environmentPredicate), set: { linearDone: { from: "literal", value: false } } },
      ],
    };
  }
  if (templateId === "feature") {
    const feature = values.feature!;
    const suffix = atomSuffix(feature);
    const disabled = `disabled_${suffix}`;
    const featureError = `feature_error_${suffix}`;
    const featurePredicate = relationshipIs(0, feature);
    return {
      ...common,
      formula: parseFormula(`G !(${disabled} & ${featureError})`),
      scope: { keys: [
        { name: "feature", extractors: [{ from: "literal", value: feature }] },
        { name: "environment", extractors: [{ from: "relationship", type: "environment" }] },
      ] },
      propositions: [
        { name: disabled, predicate: { op: "equal", path: { root: "state", segments: ["enabled"] }, value: false } },
        { name: featureError, predicate: all(eventIs("sentry", "feature.error"), featurePredicate) },
      ],
      stateUpdates: [
        { when: all(eventIs("launchdarkly", "feature.disabled"), featurePredicate), set: { enabled: { from: "literal", value: false } } },
        { when: all(eventIs("launchdarkly", "feature.enabled"), featurePredicate), set: { enabled: { from: "literal", value: true } } },
      ],
    };
  }
  const order = values.subject!;
  const suffix = atomSuffix(order);
  const forbidden = `fulfilled_before_payment_${suffix}`;
  const orderPredicate = relationshipIs(1, order);
  return {
    ...common,
    formula: parseFormula(`G !${forbidden}`),
    scope: { keys: [
      { name: "customer", extractors: [{ from: "relationship", type: "customer" }] },
      { name: "order", extractors: [{ from: "literal", value: order }] },
    ] },
    propositions: [{
      name: forbidden,
      predicate: all(
        eventIs("posthog", "order.fulfilled"),
        orderPredicate,
        { op: "equal", path: { root: "state", segments: ["lifecycleStarted"] }, value: true },
        { op: "notEqual", path: { root: "state", segments: ["paymentObserved"] }, value: true },
      ),
    }],
    stateUpdates: [
      { when: all(eventIs("posthog", "order.accepted"), orderPredicate), set: { lifecycleStarted: { from: "literal", value: true }, paymentObserved: { from: "literal", value: false } } },
      { when: all(eventIs("stripe", "payment.succeeded"), orderPredicate), set: { paymentObserved: { from: "literal", value: true } } },
      { when: all(eventIs("stripe", "payment.failed"), orderPredicate), set: { paymentObserved: { from: "literal", value: false } } },
    ],
  };
}
