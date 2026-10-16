import { formulaChildren } from "./formula.js";
import type { LtlFormula, MonitorFormula } from "./types.js";

/** Why a formula is not a safety property, located by its path from the root (`$`, `$.operand`, `$.left`, …). */
export interface LivenessFinding {
  readonly path: string;
  readonly operator: "eventually" | "until" | "always" | "weakUntil";
  readonly negated: boolean;
  readonly message: string;
}

const messages: Record<LivenessFinding["operator"], [positive: string, negated: string]> = {
  eventually: [
    "`eventually` has no time limit, so it can never be caught breaking. Give it one, such as `eventually within 30m`.",
    "",
  ],
  until: [
    "`until` also requires its right side to happen eventually, with no time limit. Use `unless` if it never has to happen, or `until within <time>`.",
    "",
  ],
  always: [
    "",
    "`not always` means something must eventually stop holding, with no time limit, so it can never be caught breaking.",
  ],
  weakUntil: [
    "",
    "`not … unless …` requires something to happen eventually, with no time limit, so it can never be caught breaking.",
  ],
};

/**
 * Syntactic safety check. After pushing negations to the atoms, a formula built only from atoms, `and`, `or`,
 * `next`, `always`, weak until, `bind` and time-bounded operators is a safety property: every violation is caught by
 * a finite prefix. Every LTL-expressible safety property can be written in this fragment, so nothing safe is lost.
 * Unbounded `eventually` and strong `until` (and their duals under negation) are the only rejected operators.
 */
export function findLiveness(formula: MonitorFormula): LivenessFinding | undefined {
  // Top-level deadline formulas are bounded response obligations, which are safety properties.
  if (formula.kind === "deadline") return undefined;
  const visit = (node: LtlFormula, path: string, negated: boolean): LivenessFinding | undefined => {
    const forbidden = (operator: LivenessFinding["operator"]): LivenessFinding => ({
      path, operator, negated, message: messages[operator][negated ? 1 : 0]!,
    });
    switch (node.kind) {
      case "eventually": if (!negated) return forbidden("eventually"); break;
      case "until": if (!negated) return forbidden("until"); break;
      case "always": if (negated) return forbidden("always"); break;
      case "weakUntil": if (negated) return forbidden("weakUntil"); break;
      case "not": return visit(node.operand, `${path}.operand`, !negated);
      case "implies": return visit(node.left, `${path}.left`, !negated) ?? visit(node.right, `${path}.right`, negated);
      default: break;
    }
    const names = node.kind === "and" || node.kind === "or"
      ? node.operands.map((_, index) => `${path}.operands[${index}]`)
      : "left" in node ? [`${path}.left`, `${path}.right`] : [`${path}.operand`];
    const children = formulaChildren(node);
    for (const [index, child] of children.entries()) {
      const finding = visit(child, names[index]!, negated);
      if (finding !== undefined) return finding;
    }
    return undefined;
  };
  return visit(formula, "$", false);
}

export function isSafetyFormula(formula: MonitorFormula): boolean {
  return findLiveness(formula) === undefined;
}
