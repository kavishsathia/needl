import { describe, expect, it } from "vitest";
import { exampleRules } from "./examples.js";
import { exampleDraft } from "./ruleDrafts.js";
import { assertProductSafety, productSafetyIssue } from "./safety.js";

describe("safety-only product policy", () => {
  it("accepts every example rule", () => {
    for (const example of exampleRules) {
      expect(productSafetyIssue(exampleDraft(example).definition)).toBeUndefined();
      expect(() => assertProductSafety(exampleDraft(example).definition)).not.toThrow();
    }
  });

  it("rejects unbounded eventualities and accepts time-bounded ones", () => {
    const base = structuredClone(exampleDraft(exampleRules[0]!).definition);
    const atom = { kind: "atom", name: base.propositions[0]!.name } as const;
    const eventual = { ...base, formula: { kind: "always", operand: { kind: "eventually", operand: atom } } as const };
    const bounded = { ...base, formula: { kind: "always", operand: { kind: "eventuallyWithin", operand: atom, withinMs: 60_000 } } as const };
    const deadline = { ...base, formula: { kind: "deadline", trigger: atom, response: atom, withinMs: 60_000 } as const };
    const next = { ...base, formula: { kind: "always", operand: { kind: "next", operand: atom } } as const };

    expect(productSafetyIssue(eventual)).toMatch(/no time limit/i);
    expect(() => assertProductSafety(eventual)).toThrow(/no time limit/i);
    expect(productSafetyIssue(bounded)).toBeUndefined();
    expect(productSafetyIssue(deadline)).toBeUndefined();
    expect(productSafetyIssue(next)).toBeUndefined();
  });
});
