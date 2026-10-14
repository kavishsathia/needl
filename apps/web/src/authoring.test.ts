import { describe, expect, it } from "vitest";
import { authoringTemplates } from "../demo.js";
import { createDraftFromTemplate, formulaText, updateDraft, updateMeaningChoice } from "./authoring.js";

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
    const recurrence = draft.definition.propositions.find((item) => item.name.startsWith("recurrence_"))!.name;
    const edited = updateDraft(draft, {
      expectation: "Never recur after deployment",
      formula: `G !${recurrence}`,
      definitionJson: JSON.stringify(draft.definition),
    }, "2026-01-02T00:00:00.000Z");
    expect(formulaText(edited)).toBe(`G !${recurrence}`);
    expect(edited.definition.version).toBe(2);
  });

  it("rejects liveness edits at the advanced-editor boundary", () => {
    const draft = createDraftFromTemplate("Keep checkout quiet", authoringTemplates[0]!, []);
    const recurrence = draft.definition.propositions.find((item) => item.name.startsWith("recurrence_"))!.name;
    expect(() => updateDraft(draft, {
      expectation: "Every paid order should eventually be fulfilled",
      formula: `G F ${recurrence}`,
      definitionJson: JSON.stringify(draft.definition),
    })).toThrow(/eventually happen/i);
  });

  it("makes meaning-chip choices canonical and versioned", () => {
    const draft = createDraftFromTemplate("Keep checkout quiet", authoringTemplates[0]!, []);
    const edited = updateMeaningChoice(draft, "environment", "staging", "2026-01-02T00:00:00.000Z");

    expect(edited.definition.version).toBe(2);
    expect(edited.meaning?.values.environment).toBe("staging");
    expect(edited.definition.formula).not.toEqual(draft.definition.formula);
    expect(edited.definition.propositions).not.toEqual(draft.definition.propositions);
    expect(edited.definition.scope).not.toEqual(draft.definition.scope);
  });
});
