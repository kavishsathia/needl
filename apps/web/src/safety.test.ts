import { describe, expect, it } from "vitest";
import { authoringTemplates } from "../demo.js";
import { assertProductSafety, productSafetyIssue } from "./safety.js";

describe("safety-only product policy", () => {
  it("accepts the reviewed invariant and bound never-again safety shapes", () => {
    for (const template of authoringTemplates) {
      expect(productSafetyIssue(template.definition)).toBeUndefined();
      expect(() => assertProductSafety(template.definition)).not.toThrow();
    }
  });

  it("rejects eventuality and deadline semantics with friendly explanations", () => {
    const base = structuredClone(authoringTemplates[0]!.definition);
    const atom = base.propositions[0]!.name;
    const eventual = {
      ...base,
      formula: { kind: "always", operand: { kind: "eventually", operand: { kind: "atom", name: atom } } } as const,
    };
    const deadline = {
      ...base,
      formula: {
        kind: "deadline",
        trigger: { kind: "atom", name: atom },
        response: { kind: "atom", name: atom },
        withinMs: 60_000,
      } as const,
    };

    expect(productSafetyIssue(eventual)).toMatch(/eventually happen/i);
    expect(productSafetyIssue(deadline)).toMatch(/deadline/i);
    expect(() => assertProductSafety(eventual)).toThrow(/eventually happen/i);
    expect(() => assertProductSafety(deadline)).toThrow(/deadline/i);
  });

  it("conservatively rejects unrecognized temporal shapes", () => {
    const base = structuredClone(authoringTemplates[0]!.definition);
    const atom = base.propositions[0]!.name;
    const next = {
      ...base,
      formula: { kind: "always", operand: { kind: "next", operand: { kind: "atom", name: atom } } } as const,
    };
    expect(productSafetyIssue(next)).toMatch(/supported safety shape/i);
  });
});
