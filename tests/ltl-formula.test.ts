import { describe, expect, it } from "vitest";
import {
  evaluateCompleteTrace,
  formatFormula,
  parseFormula,
  prefixVerdict,
  progressFormula,
  validateFormula,
  type LtlFormula,
  type PropositionValuation,
} from "../src/ltl/index.js";

function reference(
  formula: LtlFormula,
  trace: readonly PropositionValuation[],
  position = 0,
): boolean {
  switch (formula.kind) {
    case "true": return true;
    case "false": return false;
    case "atom": return trace[position]?.[formula.name] ?? false;
    case "not": return !reference(formula.operand, trace, position);
    case "bind": throw new Error("The propositional reference model does not cover bind");
    case "and": return formula.operands.every((operand) => reference(operand, trace, position));
    case "or": return formula.operands.some((operand) => reference(operand, trace, position));
    case "implies": return !reference(formula.left, trace, position) || reference(formula.right, trace, position);
    case "next": return position + 1 < trace.length && reference(formula.operand, trace, position + 1);
    case "always": {
      for (let index = position; index < trace.length; index += 1) {
        if (!reference(formula.operand, trace, index)) return false;
      }
      return true;
    }
    case "eventually": {
      for (let index = position; index < trace.length; index += 1) {
        if (reference(formula.operand, trace, index)) return true;
      }
      return false;
    }
    case "until": {
      for (let end = position; end < trace.length; end += 1) {
        if (!reference(formula.right, trace, end)) continue;
        let leftHeld = true;
        for (let index = position; index < end; index += 1) {
          if (!reference(formula.left, trace, index)) leftHeld = false;
        }
        if (leftHeld) return true;
      }
      return false;
    }
  }
}

function valuations(length: number): PropositionValuation[][] {
  const output: PropositionValuation[][] = [];
  const combinations = 2 ** (length * 2);
  for (let bits = 0; bits < combinations; bits += 1) {
    const trace: PropositionValuation[] = [];
    for (let index = 0; index < length; index += 1) {
      trace.push({
        p: Boolean(bits & (1 << (index * 2))),
        q: Boolean(bits & (1 << (index * 2 + 1))),
      });
    }
    output.push(trace);
  }
  return output;
}

describe("LTL formula language", () => {
  it("parses and formats every supported ordinary operator", () => {
    const formula = parseFormula("G (deployed -> X (! recurring U recovered))");
    expect(formatFormula(formula)).toBe("G (deployed -> X (!recurring U recovered))");
    expect(parseFormula(formatFormula(formula))).toEqual(formula);
  });

  it("rejects malformed, undeclared, deep, and executable-looking AST input", () => {
    expect(() => parseFormula("p.constructor()")) .toThrow(/unexpected|atom/i);
    expect(() => validateFormula({ kind: "atom", name: "p; process.exit()" }, { atoms: ["p"] })).toThrow(/atom/i);
    expect(() => validateFormula({ kind: "atom", name: "q" }, { atoms: ["p"] })).toThrow(/undeclared/i);
    expect(() => validateFormula({ kind: "atom", name: "p", eval: "evil" }, { atoms: ["p"] })).toThrow(/unknown/i);
    expect(() => validateFormula({
      kind: "deadline",
      trigger: { kind: "atom", name: "p" },
      response: { kind: "atom", name: "q" },
      withinMs: 31_536_000_001,
    }, { atoms: ["p", "q"] })).toThrow(/365 days/i);
    let tooDeep: unknown = { kind: "atom", name: "p" };
    for (let index = 0; index < 70; index += 1) tooDeep = { kind: "not", operand: tooDeep };
    expect(() => validateFormula(tooDeep, { atoms: ["p"], maxDepth: 64 })).toThrow(/depth/i);
  });

  it("keeps eventualities and always formulas inconclusive on live prefixes", () => {
    const pending = progressFormula(parseFormula("F p"), { p: false });
    expect(prefixVerdict(pending)).toBe("inconclusive");
    expect(prefixVerdict(progressFormula(pending, { p: true }))).toBe("satisfied");

    const safeSoFar = progressFormula(parseFormula("G p"), { p: true });
    expect(prefixVerdict(safeSoFar)).toBe("inconclusive");
    expect(prefixVerdict(progressFormula(safeSoFar, { p: false }))).toBe("violated");
  });

  it("handles until, next, negation, and empty/complete traces", () => {
    expect(evaluateCompleteTrace(parseFormula("p U q"), [{ p: true, q: false }, { p: false, q: true }])).toBe(true);
    expect(evaluateCompleteTrace(parseFormula("p U q"), [{ p: false, q: false }, { p: true, q: true }])).toBe(false);
    expect(evaluateCompleteTrace(parseFormula("X p"), [{ p: true }])).toBe(false);
    expect(evaluateCompleteTrace(parseFormula("X p"), [{ p: false }, { p: true }])).toBe(true);
    expect(evaluateCompleteTrace(parseFormula("!p"), [])).toBe(true);
    expect(evaluateCompleteTrace(parseFormula("F p"), [])).toBe(false);
    expect(evaluateCompleteTrace(parseFormula("G p"), [])).toBe(true);
  });

  it("agrees exhaustively with an independent evaluator on short traces", () => {
    const formulas = [
      "p", "!p", "p & q", "p | q", "p -> q", "X p", "G p", "F p",
      "p U q", "G (p -> F q)", "X (p U !q)", "F (p & X q)",
    ].map(parseFormula);
    for (const length of [0, 1, 2, 3]) {
      for (const trace of valuations(length)) {
        for (const formula of formulas) {
          expect(evaluateCompleteTrace(formula, trace), `${formatFormula(formula)} ${JSON.stringify(trace)}`)
            .toBe(reference(formula, trace));
        }
      }
    }
  });
});
