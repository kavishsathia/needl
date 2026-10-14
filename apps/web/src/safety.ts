import { compileAssertion, type AssertionDefinition } from "../../../src/ltl/assertion.js";
import type { LtlFormula } from "../../../src/ltl/types.js";

export const EVENTUALITY_EXPLANATION = "This describes something that should eventually happen. Needl needs a condition it can catch being broken.";
export const DEADLINE_EXPLANATION = "This rule waits for something to happen by a deadline. This product version only supports conditions it can catch at the moment they break.";
export const UNSUPPORTED_SAFETY_EXPLANATION = "This formula is outside Needl’s supported safety shape. Use a global ‘must not’ condition or an ‘after this, never again’ rule.";

function isPropositional(formula: LtlFormula): boolean {
  switch (formula.kind) {
    case "true":
    case "false":
    case "atom": return true;
    case "not": return isPropositional(formula.operand);
    case "and":
    case "or": return formula.operands.every(isPropositional);
    case "implies": return isPropositional(formula.left) && isPropositional(formula.right);
    default: return false;
  }
}

function containsKind(formula: LtlFormula, kinds: ReadonlySet<LtlFormula["kind"]>): boolean {
  if (kinds.has(formula.kind)) return true;
  switch (formula.kind) {
    case "not":
    case "next":
    case "always":
    case "eventually": return containsKind(formula.operand, kinds);
    case "and":
    case "or": return formula.operands.some((operand) => containsKind(operand, kinds));
    case "implies":
    case "until": return containsKind(formula.left, kinds) || containsKind(formula.right, kinds);
    default: return false;
  }
}

export function productSafetyIssue(definition: AssertionDefinition): string | undefined {
  let formula: ReturnType<typeof compileAssertion>["formula"];
  try {
    formula = compileAssertion(definition).formula;
  } catch (error) {
    return error instanceof Error ? error.message : "The structured rule is invalid.";
  }
  if (formula.kind === "deadline") return DEADLINE_EXPLANATION;
  if (containsKind(formula, new Set(["eventually", "until"]))) return EVENTUALITY_EXPLANATION;
  if (formula.kind !== "always") return UNSUPPORTED_SAFETY_EXPLANATION;
  if (isPropositional(formula.operand)) return undefined;
  if (
    formula.operand.kind === "implies"
    && isPropositional(formula.operand.left)
    && formula.operand.right.kind === "always"
    && isPropositional(formula.operand.right.operand)
  ) return undefined;
  return UNSUPPORTED_SAFETY_EXPLANATION;
}

export function assertProductSafety(definition: AssertionDefinition): void {
  const issue = productSafetyIssue(definition);
  if (issue !== undefined) throw new Error(issue);
}

export function unsupportedAuthoringIntent(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\b(eventually|someday)\b/.test(normalized)
    || /\bshould\s+(?:later\s+)?(?:be\s+)?(fulfilled|completed|resolved|created|delivered)\b/.test(normalized)
    || /\bwithin\s+\d+\s*(?:second|minute|hour|day)s?\b/.test(normalized);
}
