import { describe, expect, it } from "vitest";
import { translateSafetyAssertion, type TranslationModel } from "./translator.js";

function model(output: unknown): TranslationModel {
  return { model: "fixture-model", async translate() { return output; } };
}

describe("translateSafetyAssertion", () => {
  it("rejects liveness and deadline intent without spending a model request", async () => {
    let called = false;
    const fake: TranslationModel = { model: "fixture-model", async translate() { called = true; return {}; } };
    await expect(translateSafetyAssertion("Every accepted order must eventually ship within two days", fake)).resolves.toMatchObject({ supported: false });
    expect(called).toBe(false);
  });

  it("rejects malformed or unknown structured output", async () => {
    await expect(translateSafetyAssertion("A fixed issue must not recur", model({ supported: true }))).rejects.toThrow(/malformed/);
    await expect(translateSafetyAssertion("A fixed issue must not recur", model({ supported: true, template_id: "arbitrary", explanation: "x", rejection_reason: "" }))).rejects.toThrow(/unsupported template/);
  });

  it("turns a reviewed selection into canonical editable values", async () => {
    await expect(translateSafetyAssertion("A canceled customer must never be charged again", model({ supported: true, template_id: "clean-break", explanation: "Matches clean break.", rejection_reason: "" }))).resolves.toEqual({
      supported: true,
      templateId: "clean-break",
      values: { trigger: "subscription-canceled", outcome: "never-charged" },
      explanation: "Matches clean break.",
    });
  });
});
