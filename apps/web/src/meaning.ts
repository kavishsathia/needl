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
  readonly eventKinds: readonly string[];
}

export type MeaningSegment = string | { readonly field: string };

export interface MeaningTemplate {
  readonly id: TemplateId;
  readonly fields: readonly MeaningField[];
  readonly sentence: readonly MeaningSegment[];
  readonly violationSentence: readonly MeaningSegment[];
}

const providerIs = (provider: string): Predicate => ({ op: "equal", path: { root: "event", segments: ["provider"] }, value: provider });
const eventTypeIn = (...types: string[]): Predicate => types.length === 1
  ? { op: "equal", path: { root: "event", segments: ["providerEventType"] }, value: types[0]! }
  : { op: "in", path: { root: "event", segments: ["providerEventType"] }, values: types };
const relationshipIs = (type: string, value: string): Predicate => ({ op: "equal", source: { from: "relationship", type }, value });

const all = (...operands: Predicate[]): Predicate => operands.length === 1 ? operands[0]! : { op: "and", operands };

/** Sentry event tag that carries the tracker key of the work item an error belongs to. */
export const GHOST_ISSUE_TAG = "linear_issue";
export const CHARGE_EVENT_TYPES = ["invoice.paid", "charge.succeeded", "payment_intent.succeeded"] as const;

export const meaningTemplates: Readonly<Record<TemplateId, MeaningTemplate>> = {
  ghost: {
    id: "ghost",
    sentence: ["Once ", { field: "trigger" }, " to ", { field: "environment" }, ", ", { field: "outcome" }, " must not appear there again."],
    violationSentence: ["An error tagged with a shipped issue key came back in ", { field: "environment" }, "."],
    fields: [
      { id: "trigger", accessibleLabel: "Trigger", options: [{ value: "fix-branch-deployed", label: "a branch for an issue deploys", evidence: "matched" }], eventKinds: ["deployment"] },
      { id: "outcome", accessibleLabel: "Forbidden outcome", options: [{ value: "tagged-errors", label: "errors tagged with that issue", evidence: "matched" }], eventKinds: ["error.event_alert"] },
      { id: "environment", accessibleLabel: "Environment", options: [
        { value: "production", label: "production", evidence: "matched" },
        { value: "staging", label: "staging", evidence: "none" },
      ], eventKinds: ["deployment", "error.event_alert"] },
    ],
  },
  boomerang: {
    id: "boomerang",
    sentence: ["Once ", { field: "trigger" }, ", it must never ", { field: "outcome" }, "."],
    violationSentence: ["A resolved Sentry issue came back."],
    fields: [
      { id: "trigger", accessibleLabel: "Trigger", options: [{ value: "issue-resolved", label: "a Sentry issue is resolved", evidence: "matched" }], eventKinds: ["error.issue"] },
      { id: "outcome", accessibleLabel: "Forbidden outcome", options: [{ value: "never-unresolved", label: "come back", evidence: "matched" }], eventKinds: ["error.issue"] },
    ],
  },
  "clean-break": {
    id: "clean-break",
    sentence: ["Once ", { field: "trigger" }, " their subscription, they must never ", { field: "outcome" }, "."],
    violationSentence: ["A customer was charged after their subscription was canceled."],
    fields: [
      { id: "trigger", accessibleLabel: "Trigger", options: [{ value: "subscription-canceled", label: "a customer cancels", evidence: "matched" }], eventKinds: ["subscription.deleted"] },
      { id: "outcome", accessibleLabel: "Forbidden outcome", options: [{ value: "never-charged", label: "be charged again", evidence: "matched" }], eventKinds: ["invoice.paid", "charge.succeeded", "payment.succeeded"] },
    ],
  },
};

export function defaultMeaningValues(templateId: TemplateId): Readonly<Record<string, string>> {
  return Object.fromEntries(meaningTemplates[templateId].fields.map((field) => [field.id, field.options[0]!.value]));
}

export function meaningOption(templateId: TemplateId, fieldId: string, value: string): MeaningOption | undefined {
  return meaningTemplates[templateId].fields.find((field) => field.id === fieldId)?.options.find((option) => option.value === value);
}

function renderMeaningSegments(
  templateId: TemplateId,
  values: Readonly<Record<string, string>>,
  segments: readonly MeaningSegment[],
): string {
  const rendered = segments.map((segment) => {
    if (typeof segment === "string") return segment;
    return meaningOption(templateId, segment.field, values[segment.field] ?? "")?.label ?? "the selected value";
  }).join("");
  return rendered.length === 0 ? rendered : rendered[0]!.toUpperCase() + rendered.slice(1);
}

export function meaningRuleText(draft: AssertionDraft): string | undefined {
  if (draft.meaning === undefined) return undefined;
  const template = meaningTemplates[draft.meaning.templateId];
  return renderMeaningSegments(template.id, draft.meaning.values, template.sentence);
}

export function meaningViolationText(draft: AssertionDraft): string | undefined {
  if (draft.meaning === undefined) return undefined;
  const template = meaningTemplates[draft.meaning.templateId];
  return renderMeaningSegments(template.id, draft.meaning.values, template.violationSentence);
}

export function fieldForEventKind(templateId: TemplateId, eventKind: string): string | undefined {
  return meaningTemplates[templateId].fields.find((field) => field.eventKinds.includes(eventKind))?.id;
}

export function eventKindsForField(templateId: TemplateId, fieldId: string): readonly string[] {
  return meaningTemplates[templateId].fields.find((field) => field.id === fieldId)?.eventKinds ?? [];
}

export function meaningHasFixtureEvidence(draft: AssertionDraft): boolean {
  if (draft.meaning === undefined) return true;
  return meaningTemplates[draft.meaning.templateId].fields.every((field) => {
    const option = meaningOption(draft.meaning!.templateId, field.id, draft.meaning!.values[field.id] ?? "");
    return option?.evidence === "matched";
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function assertMeaningMatchesMonitor(draft: AssertionDraft): void {
  if (draft.meaning === undefined) return;
  if (draft.templateId !== draft.meaning.templateId) throw new Error(`Assertion ${draft.localId} meaning template does not match its monitor template`);
  const expected = buildTemplateDefinition(draft.meaning.templateId, draft.meaning.values, {
    id: draft.definition.id,
    name: draft.definition.name,
    version: draft.definition.version,
    tenantId: draft.definition.tenantId,
  });
  if (canonicalJson(expected) !== canonicalJson(draft.definition)) {
    throw new Error(`Assertion ${draft.localId} meaning does not match its stored monitor`);
  }
}

function meaningValueCombinations(templateId: TemplateId): Readonly<Record<string, string>>[] {
  return meaningTemplates[templateId].fields.reduce<Readonly<Record<string, string>>[]>(
    (combinations, field) => combinations.flatMap((values) => field.options.map((option) => ({ ...values, [field.id]: option.value }))),
    [{}],
  );
}

export function restoreCanonicalMeaning(draft: AssertionDraft): AssertionDraft {
  if (draft.meaning !== undefined || draft.templateId === undefined || !(draft.templateId in meaningTemplates)) return draft;
  const templateId = draft.templateId as TemplateId;
  for (const values of meaningValueCombinations(templateId)) {
    const candidate = { ...draft, meaning: { templateId, values } };
    try {
      assertMeaningMatchesMonitor(candidate);
      return candidate;
    } catch {
      // A template label or ID is not enough: restore meaning only for an exact canonical monitor match.
    }
  }
  return draft;
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
  if (templateId === "ghost") {
    const environment = values.environment!;
    return {
      ...common,
      formula: parseFormula("G (shipped -> bind(issue) G !haunted)"),
      // Each issue key is its own monitor instance, so one ghost does not end monitoring for every other issue.
      scope: { keys: [
        { name: "issue", extractors: [
          { provider: "gitlab", from: "relationship", type: "ref", pattern: "issue-key" },
          { provider: "sentry", from: "relationship", type: `tag.${GHOST_ISSUE_TAG}`, pattern: "issue-key" },
        ] },
        { name: "environment", extractors: [{ from: "literal", value: environment }] },
      ] },
      bindings: [{ name: "issue", extractors: [{ provider: "gitlab", from: "relationship", type: "ref", pattern: "issue-key" }] }],
      propositions: [
        { name: "shipped", predicate: all(providerIs("gitlab"), eventTypeIn("deployment.success"), relationshipIs("environment", environment)) },
        {
          name: "haunted",
          predicate: all(
            providerIs("sentry"),
            relationshipIs("environment", environment),
            { op: "equal", source: { from: "relationship", type: `tag.${GHOST_ISSUE_TAG}`, pattern: "issue-key" }, variable: "issue" },
          ),
        },
      ],
    };
  }
  if (templateId === "boomerang") {
    return {
      ...common,
      formula: parseFormula("G (resolved -> bind(issue) G !returned)"),
      scope: { keys: [{ name: "issue", extractors: [{ provider: "sentry", from: "subject", type: "issue" }] }] },
      bindings: [{ name: "issue", extractors: [{ provider: "sentry", from: "subject", type: "issue" }] }],
      propositions: [
        { name: "resolved", predicate: all(providerIs("sentry"), eventTypeIn("issue.resolved")) },
        {
          name: "returned",
          predicate: all(
            providerIs("sentry"),
            eventTypeIn("issue.unresolved"),
            { op: "equal", source: { from: "subject", type: "issue" }, variable: "issue" },
          ),
        },
      ],
    };
  }
  return {
    ...common,
    formula: parseFormula("G (canceled -> bind(customer) G !charged)"),
    scope: { keys: [{ name: "customer", extractors: [{ provider: "stripe", from: "relationship", type: "customer" }] }] },
    bindings: [{ name: "customer", extractors: [{ provider: "stripe", from: "relationship", type: "customer" }] }],
    propositions: [
      { name: "canceled", predicate: all(providerIs("stripe"), eventTypeIn("customer.subscription.deleted")) },
      {
        name: "charged",
        predicate: all(
          providerIs("stripe"),
          eventTypeIn(...CHARGE_EVENT_TYPES),
          { op: "equal", source: { from: "relationship", type: "customer" }, variable: "customer" },
        ),
      },
    ],
  };
}
