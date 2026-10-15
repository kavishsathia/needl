import { describe, expect, it } from "vitest";
import { authoringTemplates } from "../demo.js";
import { createDraftFromTemplate, formulaText, updateDraft, updateMeaningChoice } from "./authoring.js";
import { validateProductAssertionCollection } from "./collection.js";
import { meaningRuleText, meaningViolationText } from "./meaning.js";

describe("explicit template authoring", () => {
  it("creates a paused, uniquely identified draft without claiming general translation", () => {
    const first = createDraftFromTemplate("Keep checkout quiet", authoringTemplates[0]!, [], "2026-01-01T00:00:00.000Z");
    const second = createDraftFromTemplate("Keep checkout quiet", authoringTemplates[0]!, [first.localId], "2026-01-01T00:00:00.000Z");
    expect(first.status).toBe("paused");
    expect(second.localId).toBe(`${first.localId}-2`);
    expect(first.definition.formula).toEqual(authoringTemplates[0]!.definition.formula);
  });

  it("validates manual formula edits through the existing compiler", () => {
    const draft = createDraftFromTemplate("Keep checkout quiet", authoringTemplates[0]!, []);
    const edited = updateDraft(draft, {
      expectation: "Never ship anything",
      formula: "G !shipped",
      definitionJson: JSON.stringify(draft.definition),
    }, "2026-01-02T00:00:00.000Z");
    expect(formulaText(edited)).toBe("G !shipped");
    expect(edited.definition.version).toBe(2);
    expect(edited.meaning).toBeUndefined();
  });

  it("keeps canonical meaning metadata when only user-facing wording changes", () => {
    const draft = createDraftFromTemplate("Keep checkout quiet", authoringTemplates[0]!, []);
    const edited = updateDraft(draft, {
      expectation: "A renamed checkout repair stays repaired",
      formula: formulaText(draft),
      definitionJson: JSON.stringify(draft.definition),
    }, "2026-01-02T00:00:00.000Z");

    expect(edited.localId).toBe(draft.localId);
    expect(edited.meaning).toEqual(draft.meaning);
    expect(meaningRuleText(edited)).toBe("Once a branch for an issue deploys to production, errors tagged with that issue must not appear there again.");
    expect(meaningViolationText(edited)).toBe("An error tagged with a shipped issue key came back in production.");
  });

  it("derives business explanations from canonical meaning for every cloned template ID", () => {
    const explanations = authoringTemplates.map((template, index) => {
      const draft = createDraftFromTemplate(`Cloned rule ${index}`, template, []);
      return meaningViolationText(draft);
    });

    expect(explanations).toEqual([
      "An error tagged with a shipped issue key came back in production.",
      "A resolved Sentry issue came back.",
      "A customer was charged after their subscription was canceled.",
    ]);
  });

  it("rejects liveness edits at the advanced-editor boundary", () => {
    const draft = createDraftFromTemplate("Keep checkout quiet", authoringTemplates[0]!, []);
    expect(() => updateDraft(draft, {
      expectation: "Every fix should eventually ship",
      formula: "G F shipped",
      definitionJson: JSON.stringify(draft.definition),
    })).toThrow(/eventually happen/i);
  });

  it("makes meaning-chip choices canonical and versioned", () => {
    const draft = createDraftFromTemplate("Keep checkout quiet", authoringTemplates[0]!, []);
    const edited = updateMeaningChoice(draft, "environment", "staging", "2026-01-02T00:00:00.000Z");

    expect(edited.definition.version).toBe(2);
    expect(edited.meaning?.values.environment).toBe("staging");
    expect(edited.definition.formula).toEqual(draft.definition.formula);
    expect(edited.definition.propositions).not.toEqual(draft.definition.propositions);
    expect(edited.definition.scope).not.toEqual(draft.definition.scope);
  });

  it("rejects cosmetic meaning metadata that does not match the stored monitor", () => {
    const draft = createDraftFromTemplate("Keep checkout quiet", authoringTemplates[0]!, []);
    const tampered = {
      ...draft,
      meaning: { ...draft.meaning!, values: { ...draft.meaning!.values, environment: "staging" } },
    };
    expect(() => validateProductAssertionCollection([tampered])).toThrow(/meaning.*monitor/i);
  });
});
