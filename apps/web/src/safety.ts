import { compileAssertion, type AssertionDefinition } from "../../../src/ltl/assertion.js";
import { findLiveness } from "../../../src/ltl/safety.js";

/**
 * Product policy: Needl only runs safety properties, rules a single finite observation (or a passed time limit) can
 * break. The engine's syntactic check covers every LTL-expressible safety property, including time-bounded
 * operators and bound values; unbounded `eventually` and strong `until` are rejected with the reason.
 */
export function productSafetyIssue(definition: AssertionDefinition): string | undefined {
  let formula: ReturnType<typeof compileAssertion>["formula"];
  try {
    formula = compileAssertion(definition).formula;
  } catch (error) {
    return error instanceof Error ? error.message : "The structured rule is invalid.";
  }
  return findLiveness(formula)?.message;
}

export function assertProductSafety(definition: AssertionDefinition): void {
  const issue = productSafetyIssue(definition);
  if (issue !== undefined) throw new Error(issue);
}
