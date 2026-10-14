export type PropositionValuation = Readonly<Record<string, boolean>>;

export type LtlFormula =
  | { readonly kind: "true" }
  | { readonly kind: "false" }
  | { readonly kind: "atom"; readonly name: string }
  | { readonly kind: "not"; readonly operand: LtlFormula }
  | { readonly kind: "and" | "or"; readonly operands: readonly LtlFormula[] }
  | { readonly kind: "implies"; readonly left: LtlFormula; readonly right: LtlFormula }
  | { readonly kind: "next" | "always" | "eventually"; readonly operand: LtlFormula }
  | { readonly kind: "until"; readonly left: LtlFormula; readonly right: LtlFormula };

/** Needl timed extension: G(trigger -> F[0, withinMs] response). */
export interface DeadlineFormula {
  readonly kind: "deadline";
  readonly trigger: LtlFormula;
  readonly response: LtlFormula;
  readonly withinMs: number;
}

export type MonitorFormula = LtlFormula | DeadlineFormula;
export type PrefixVerdict = "satisfied" | "violated" | "inconclusive";

export interface FormulaValidationOptions {
  readonly atoms?: readonly string[];
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

export class FormulaValidationError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${path}: ${message}`);
    this.name = "FormulaValidationError";
  }
}
