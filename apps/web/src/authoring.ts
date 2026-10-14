import { compileAssertion } from "../../../src/ltl/assertion.js";
import { formatFormula, parseFormula } from "../../../src/ltl/formula.js";
import type { AssertionDraft, AuthoringTemplate } from "./domain.js";
import { assertAssertionCapacity } from "./collection.js";
import { assertProductSafety } from "./safety.js";
import { assertMeaningMatchesMonitor, buildTemplateDefinition, defaultMeaningValues, meaningOption } from "./meaning.js";

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36);
  return normalized || "assertion";
}

export function createDraftFromTemplate(
  expectation: string,
  template: AuthoringTemplate,
  existingIds: readonly string[],
  now = new Date().toISOString(),
): AssertionDraft {
  assertAssertionCapacity(existingIds.length);
  const base = `local-${slug(expectation)}`;
  let localId = base;
  let suffix = 2;
  while (existingIds.includes(localId)) {
    localId = `${base}-${suffix}`;
    suffix += 1;
  }
  const values = defaultMeaningValues(template.id);
  const definition = buildTemplateDefinition(template.id, values, { id: localId, name: expectation.trim(), version: 1 });
  return {
    localId,
    expectation: expectation.trim(),
    definition,
    status: "paused",
    templateId: template.id,
    meaning: { templateId: template.id, values },
    createdAt: now,
    updatedAt: now,
  };
}

export function formulaText(draft: AssertionDraft): string {
  return draft.definition.formula.kind === "deadline"
    ? JSON.stringify(draft.definition.formula)
    : formatFormula(draft.definition.formula);
}

export function updateDraft(
  draft: AssertionDraft,
  input: { readonly expectation: string; readonly formula: string; readonly definitionJson: string },
  now = new Date().toISOString(),
): AssertionDraft {
  const expectation = input.expectation.trim();
  if (expectation.length === 0) throw new Error("Expectation is required");
  let definition = JSON.parse(input.definitionJson) as AssertionDraft["definition"];
  const formula = input.formula.trim().startsWith("{")
    ? JSON.parse(input.formula) as AssertionDraft["definition"]["formula"]
    : parseFormula(input.formula);
  definition = {
    ...definition,
    id: draft.localId,
    tenantId: "synthetic-demo",
    name: expectation,
    version: draft.definition.version + 1,
    formula,
  };
  compileAssertion(definition);
  assertProductSafety(definition);
  let meaning = draft.meaning;
  if (meaning !== undefined) {
    try {
      assertMeaningMatchesMonitor({ ...draft, expectation, definition, meaning });
    } catch {
      meaning = undefined;
    }
  }
  return { ...draft, expectation, definition, status: draft.status === "needs-review" ? "paused" : draft.status, meaning, reviewReason: undefined, updatedAt: now };
}

export function updateMeaningChoice(
  draft: AssertionDraft,
  fieldId: string,
  value: string,
  now = new Date().toISOString(),
): AssertionDraft {
  if (draft.meaning === undefined) throw new Error("This assertion does not have editable meaning chips");
  if (meaningOption(draft.meaning.templateId, fieldId, value) === undefined) throw new Error("That meaning choice is unavailable");
  const values = { ...draft.meaning.values, [fieldId]: value };
  const definition = buildTemplateDefinition(draft.meaning.templateId, values, {
    id: draft.localId,
    name: draft.definition.name,
    version: draft.definition.version + 1,
    tenantId: draft.definition.tenantId,
  });
  assertProductSafety(definition);
  return { ...draft, definition, meaning: { templateId: draft.meaning.templateId, values }, reviewReason: undefined, updatedAt: now };
}
