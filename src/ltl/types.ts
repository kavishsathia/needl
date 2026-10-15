export type PropositionValuation = Readonly<Record<string, boolean>>;

/** Values frozen by enclosing `bind` operators; `null` records a bind point whose source had no value. */
export type BindingEnvironment = Readonly<Record<string, string | null>>;

export type LtlFormula =
  | { readonly kind: "true" }
  | { readonly kind: "false" }
  | { readonly kind: "atom"; readonly name: string; readonly env?: BindingEnvironment }
  | { readonly kind: "not"; readonly operand: LtlFormula }
  | { readonly kind: "and" | "or"; readonly operands: readonly LtlFormula[] }
  | { readonly kind: "implies"; readonly left: LtlFormula; readonly right: LtlFormula }
  | { readonly kind: "next" | "always" | "eventually"; readonly operand: LtlFormula }
  | { readonly kind: "until"; readonly left: LtlFormula; readonly right: LtlFormula }
  /** Freeze binding: captures `variable` from the current observation, then evaluates `operand` from that observation. */
  | { readonly kind: "bind"; readonly variable: string; readonly operand: LtlFormula };

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
