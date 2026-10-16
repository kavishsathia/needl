import type { Provider } from "../../../src/core/types.js";
import type { AssertionDefinition } from "../../../src/ltl/assertion.js";
import { checkRule, type CheckedRule, type RuleIssue } from "../../../src/rules/check.js";
import { compileRule, type ParamValue, type ParamValues } from "../../../src/rules/compile.js";
import type { AssertionDraft, RuleSpec } from "./domain.js";
import { DEMO_TENANT_ID } from "./domain.js";
import { exampleRules, type ExampleRule } from "./examples.js";
import { assertAssertionCapacity } from "./collection.js";

export class RuleError extends Error {
  constructor(readonly issues: readonly RuleIssue[]) {
    super(issues.map((issue) => `Line ${issue.span.line}, column ${issue.span.column}: ${issue.message}`).join("\n"));
    this.name = "RuleError";
  }
}

const checked = new Map<string, CheckedRule>();

/** Parses and checks a rule, caching by source; throws `RuleError` with located messages. */
export function checkedRule(source: string): CheckedRule {
  const cached = checked.get(source);
  if (cached !== undefined) return cached;
  const result = checkRule(source);
  if (!result.ok) throw new RuleError(result.errors);
  if (checked.size > 200) checked.clear();
  checked.set(source, result.rule);
  return result.rule;
}

export function compileRuleDefinition(
  rule: RuleSpec,
  identity: { readonly id: string; readonly name: string; readonly version: number; readonly tenantId?: string },
): AssertionDefinition {
  return compileRule(checkedRule(rule.source), rule.values, { ...identity, tenantId: identity.tenantId ?? DEMO_TENANT_ID });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).filter(([, nested]) => nested !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The stored monitor must be exactly what the rule compiles to, so the reading can never drift from what runs. */
export function assertRuleMatchesMonitor(draft: AssertionDraft): void {
  if (draft.rule === undefined) return;
  if (typeof draft.rule.source !== "string" || typeof draft.rule.values !== "object" || draft.rule.values === null) {
    throw new Error(`Assertion ${draft.localId} has an invalid rule`);
  }
  const expected = compileRuleDefinition(draft.rule, {
    id: draft.definition.id, name: draft.definition.name, version: draft.definition.version, tenantId: draft.definition.tenantId,
  });
  if (canonicalJson(expected) !== canonicalJson(draft.definition)) throw new Error(`Assertion ${draft.localId} rule does not match its stored monitor`);
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36);
  return normalized || "assertion";
}

function uniqueId(base: string, existingIds: readonly string[]): string {
  let localId = base;
  for (let suffix = 2; existingIds.includes(localId); suffix += 1) localId = `${base}-${suffix}`;
  return localId;
}

export function createDraftFromRule(input: {
  readonly expectation: string;
  readonly name?: string;
  readonly rule: RuleSpec;
  readonly exampleId?: ExampleRule["id"];
  readonly existingIds: readonly string[];
  readonly now?: string;
}): AssertionDraft {
  assertAssertionCapacity(input.existingIds.length);
  const now = input.now ?? new Date().toISOString();
  const expectation = input.expectation.trim();
  const localId = uniqueId(`local-${slug(input.name ?? expectation)}`, input.existingIds);
  const name = (input.name ?? expectation).trim().slice(0, 120);
  return {
    localId,
    expectation,
    definition: compileRuleDefinition(input.rule, { id: localId, name, version: 1 }),
    status: "paused",
    rule: { source: input.rule.source, values: input.rule.values },
    ...(input.exampleId === undefined ? {} : { exampleId: input.exampleId }),
    createdAt: now,
    updatedAt: now,
  };
}

/** A worked example as a monitoring assertion, as seeded into new workspaces. */
export function exampleDraft(example: ExampleRule, overrides: Partial<Pick<AssertionDraft, "status" | "createdAt" | "updatedAt">> & { readonly values?: ParamValues } = {}): AssertionDraft {
  const rule: RuleSpec = { source: example.source, values: overrides.values ?? example.values };
  return {
    localId: example.id,
    expectation: example.prompt,
    definition: compileRuleDefinition(rule, { id: example.id, name: example.name, version: 1 }),
    status: overrides.status ?? "monitoring",
    rule,
    exampleId: example.id,
    createdAt: overrides.createdAt ?? "2026-02-18T10:39:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-02-18T10:39:00.000Z",
  };
}

export function updateRuleChoice(draft: AssertionDraft, param: string, value: ParamValue, now = new Date().toISOString()): AssertionDraft {
  if (draft.rule === undefined) throw new Error("This assertion has no rule choices");
  const rule: RuleSpec = { source: draft.rule.source, values: { ...draft.rule.values, [param]: value } };
  const definition = compileRuleDefinition(rule, {
    id: draft.localId, name: draft.definition.name, version: draft.definition.version + 1, tenantId: draft.definition.tenantId,
  });
  return { ...draft, rule, definition, reviewReason: undefined, updatedAt: now };
}

/** Saves edited wording and rule text as a new version; choices for `$` names that still exist are kept. */
export function updateRuleSource(
  draft: AssertionDraft,
  input: { readonly expectation: string; readonly name?: string; readonly source: string; readonly values?: ParamValues },
  now = new Date().toISOString(),
): AssertionDraft {
  const expectation = input.expectation.trim();
  if (expectation.length === 0) throw new Error("Expectation is required");
  const rule = checkedRule(input.source);
  const previous = input.values ?? draft.rule?.values ?? {};
  const values = Object.fromEntries(rule.params.flatMap((param) => previous[param.name] === undefined ? [] : [[param.name, previous[param.name]!]]));
  const spec: RuleSpec = { source: input.source, values };
  const name = (input.name ?? draft.definition.name).trim() || expectation;
  const definition = compileRuleDefinition(spec, { id: draft.localId, name, version: draft.definition.version + 1, tenantId: draft.definition.tenantId });
  const { exampleId: _example, ...rest } = draft;
  const keepsExample = draft.exampleId !== undefined && exampleRules.find((example) => example.id === draft.exampleId)?.source === input.source;
  return {
    ...rest,
    ...(keepsExample ? { exampleId: draft.exampleId } : {}),
    expectation,
    definition,
    rule: spec,
    status: draft.status === "needs-review" ? "paused" : draft.status,
    reviewReason: undefined,
    updatedAt: now,
  };
}

/** Integrations a rule reads, in first-use order. */
export function ruleProviders(draft: AssertionDraft): Provider[] {
  if (draft.rule === undefined) return [];
  try {
    return [...new Set([...checkedRule(draft.rule.source).events.values()].map((resolved) => resolved.event.provider))];
  } catch {
    return [];
  }
}

const legacyExamples: Readonly<Record<string, ExampleRule["id"]>> = { ghost: "no-ghosts", boomerang: "boomerang", "clean-break": "clean-break" };

/**
 * Converts an assertion saved by the template-based authoring flow into a rule. The monitor is recompiled from the
 * matching example, so it gets a new version: the compiled propositions differ even though the meaning is the same.
 */
export function upgradeLegacyDraft(value: unknown): { readonly draft: unknown; readonly upgraded: boolean } {
  if (typeof value !== "object" || value === null) return { draft: value, upgraded: false };
  const candidate = value as Record<string, unknown>;
  const templateId = typeof candidate.templateId === "string" ? candidate.templateId : undefined;
  if (candidate.rule !== undefined || templateId === undefined) return { draft: value, upgraded: false };
  const { templateId: _template, meaning, ...rest } = candidate;
  const exampleId = legacyExamples[templateId];
  const example = exampleRules.find((item) => item.id === exampleId);
  const definition = candidate.definition as AssertionDefinition | undefined;
  if (example === undefined || definition === undefined || typeof candidate.localId !== "string") return { draft: rest, upgraded: true };
  const chosen = (meaning as { values?: Record<string, string> } | undefined)?.values ?? {};
  const values: ParamValues = example.id === "no-ghosts" ? { environment: chosen.environment ?? "production" } : example.values;
  const rule: RuleSpec = { source: example.source, values };
  return {
    upgraded: true,
    draft: {
      ...rest,
      rule,
      exampleId: example.id,
      definition: compileRuleDefinition(rule, { id: candidate.localId, name: definition.name, version: definition.version + 1, tenantId: definition.tenantId }),
    },
  };
}
