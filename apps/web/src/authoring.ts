import { formatFormula } from "../../../src/ltl/formula.js";
import type { AssertionDraft } from "./domain.js";

/** Engine formula text, for search and the advanced details view. */
export function formulaText(draft: AssertionDraft): string {
  return draft.definition.formula.kind === "deadline"
    ? JSON.stringify(draft.definition.formula)
    : formatFormula(draft.definition.formula);
}
