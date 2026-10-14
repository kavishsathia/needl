import type {
  FormulaValidationOptions,
  LtlFormula,
  MonitorFormula,
  PrefixVerdict,
  PropositionValuation,
} from "./types.js";
import { FormulaValidationError } from "./types.js";

const atomPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const temporalKinds = new Set(["next", "always", "eventually", "until"]);

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FormulaValidationError("expected an object", path);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new FormulaValidationError(`unknown field ${JSON.stringify(key)}`, path);
  }
}

export function validateFormula(input: unknown, options: FormulaValidationOptions = {}): MonitorFormula {
  const atoms = options.atoms === undefined ? undefined : new Set(options.atoms);
  const maxDepth = options.maxDepth ?? 64;
  const maxNodes = options.maxNodes ?? 1_000;
  let nodes = 0;

  const visit = (candidate: unknown, path: string, depth: number, allowDeadline: boolean): MonitorFormula => {
    if (depth > maxDepth) throw new FormulaValidationError(`maximum depth ${maxDepth} exceeded`, path);
    nodes += 1;
    if (nodes > maxNodes) throw new FormulaValidationError(`maximum node count ${maxNodes} exceeded`, path);
    const value = object(candidate, path);
    if (typeof value.kind !== "string") throw new FormulaValidationError("kind must be a string", `${path}.kind`);
    switch (value.kind) {
      case "true":
      case "false":
        exactKeys(value, ["kind"], path);
        return { kind: value.kind };
      case "atom": {
        exactKeys(value, ["kind", "name"], path);
        if (typeof value.name !== "string" || !atomPattern.test(value.name)) {
          throw new FormulaValidationError("invalid atom name", `${path}.name`);
        }
        if (atoms !== undefined && !atoms.has(value.name)) {
          throw new FormulaValidationError(`undeclared atom ${JSON.stringify(value.name)}`, `${path}.name`);
        }
        return { kind: "atom", name: value.name };
      }
      case "not":
      case "next":
      case "always":
      case "eventually": {
        exactKeys(value, ["kind", "operand"], path);
        const operand = visit(value.operand, `${path}.operand`, depth + 1, false);
        if (operand.kind === "deadline") throw new FormulaValidationError("deadline cannot be nested", `${path}.operand`);
        return { kind: value.kind, operand };
      }
      case "and":
      case "or": {
        exactKeys(value, ["kind", "operands"], path);
        if (!Array.isArray(value.operands) || value.operands.length < 2 || value.operands.length > 100) {
          throw new FormulaValidationError("operands must contain 2 to 100 formulas", `${path}.operands`);
        }
        const operands = value.operands.map((operand, index): LtlFormula => {
          const parsed = visit(operand, `${path}.operands[${index}]`, depth + 1, false);
          if (parsed.kind === "deadline") throw new FormulaValidationError("deadline cannot be nested", `${path}.operands[${index}]`);
          return parsed;
        });
        return { kind: value.kind, operands };
      }
      case "implies":
      case "until": {
        exactKeys(value, ["kind", "left", "right"], path);
        const left = visit(value.left, `${path}.left`, depth + 1, false);
        const right = visit(value.right, `${path}.right`, depth + 1, false);
        if (left.kind === "deadline" || right.kind === "deadline") {
          throw new FormulaValidationError("deadline cannot be nested", path);
        }
        return { kind: value.kind, left, right };
      }
      case "deadline": {
        if (!allowDeadline) throw new FormulaValidationError("deadline cannot be nested", path);
        exactKeys(value, ["kind", "trigger", "response", "withinMs"], path);
        if (!Number.isSafeInteger(value.withinMs) || (value.withinMs as number) <= 0) {
          throw new FormulaValidationError("withinMs must be a positive safe integer", `${path}.withinMs`);
        }
        const trigger = visit(value.trigger, `${path}.trigger`, depth + 1, false);
        const response = visit(value.response, `${path}.response`, depth + 1, false);
        if (trigger.kind === "deadline" || response.kind === "deadline") {
          throw new FormulaValidationError("deadline cannot be nested", path);
        }
        if (containsTemporal(trigger) || containsTemporal(response)) {
          throw new FormulaValidationError("deadline trigger and response must be propositional", path);
        }
        return { kind: "deadline", trigger, response, withinMs: value.withinMs as number };
      }
      default:
        throw new FormulaValidationError(`unsupported formula kind ${JSON.stringify(value.kind)}`, `${path}.kind`);
    }
  };

  return visit(input, "$", 0, true);
}

export function containsTemporal(formula: LtlFormula): boolean {
  if (temporalKinds.has(formula.kind)) return true;
  switch (formula.kind) {
    case "not": return containsTemporal(formula.operand);
    case "and":
    case "or": return formula.operands.some(containsTemporal);
    case "implies": return containsTemporal(formula.left) || containsTemporal(formula.right);
    default: return false;
  }
}

function same(left: LtlFormula, right: LtlFormula): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function negate(formula: LtlFormula): LtlFormula {
  if (formula.kind === "true") return { kind: "false" };
  if (formula.kind === "false") return { kind: "true" };
  if (formula.kind === "not") return formula.operand;
  return { kind: "not", operand: formula };
}

function boolean(kind: "and" | "or", inputs: readonly LtlFormula[]): LtlFormula {
  const identity = kind === "and" ? "true" : "false";
  const absorbing = kind === "and" ? "false" : "true";
  const flattened: LtlFormula[] = [];
  for (const input of inputs) {
    if (input.kind === absorbing) return { kind: absorbing };
    if (input.kind === identity) continue;
    const parts = input.kind === kind ? input.operands : [input];
    for (const part of parts) {
      if (flattened.some((existing) => same(existing, part))) continue;
      if (flattened.some((existing) => same(existing, negate(part)))) return { kind: absorbing };
      flattened.push(part);
    }
  }
  if (flattened.length === 0) return { kind: identity };
  if (flattened.length === 1) return flattened[0]!;
  return { kind, operands: flattened };
}

export function progressFormula(formula: LtlFormula, valuation: PropositionValuation): LtlFormula {
  switch (formula.kind) {
    case "true":
    case "false": return formula;
    case "atom": return { kind: valuation[formula.name] === true ? "true" : "false" };
    case "not": return negate(progressFormula(formula.operand, valuation));
    case "and":
    case "or": return boolean(formula.kind, formula.operands.map((operand) => progressFormula(operand, valuation)));
    case "implies": return boolean("or", [
      negate(progressFormula(formula.left, valuation)),
      progressFormula(formula.right, valuation),
    ]);
    case "next": return formula.operand;
    case "always": return formula.operand.kind === "true"
      ? { kind: "true" }
      : boolean("and", [progressFormula(formula.operand, valuation), formula]);
    case "eventually": return formula.operand.kind === "false"
      ? { kind: "false" }
      : boolean("or", [progressFormula(formula.operand, valuation), formula]);
    case "until": return boolean("or", [
      progressFormula(formula.right, valuation),
      boolean("and", [progressFormula(formula.left, valuation), formula]),
    ]);
  }
}

export function prefixVerdict(residual: LtlFormula): PrefixVerdict {
  if (residual.kind === "true") return "satisfied";
  if (residual.kind === "false") return "violated";
  return "inconclusive";
}

export function evaluateCompleteTrace(
  formula: LtlFormula,
  trace: readonly PropositionValuation[],
  position = 0,
): boolean {
  switch (formula.kind) {
    case "true": return true;
    case "false": return false;
    case "atom": return trace[position]?.[formula.name] ?? false;
    case "not": return !evaluateCompleteTrace(formula.operand, trace, position);
    case "and": return formula.operands.every((operand) => evaluateCompleteTrace(operand, trace, position));
    case "or": return formula.operands.some((operand) => evaluateCompleteTrace(operand, trace, position));
    case "implies": return !evaluateCompleteTrace(formula.left, trace, position)
      || evaluateCompleteTrace(formula.right, trace, position);
    case "next": return position + 1 < trace.length
      && evaluateCompleteTrace(formula.operand, trace, position + 1);
    case "always": {
      for (let index = position; index < trace.length; index += 1) {
        if (!evaluateCompleteTrace(formula.operand, trace, index)) return false;
      }
      return true;
    }
    case "eventually": {
      for (let index = position; index < trace.length; index += 1) {
        if (evaluateCompleteTrace(formula.operand, trace, index)) return true;
      }
      return false;
    }
    case "until": {
      for (let end = position; end < trace.length; end += 1) {
        if (!evaluateCompleteTrace(formula.right, trace, end)) continue;
        let held = true;
        for (let index = position; index < end; index += 1) {
          if (!evaluateCompleteTrace(formula.left, trace, index)) held = false;
        }
        if (held) return true;
      }
      return false;
    }
  }
}

interface Token { readonly value: string; readonly offset: number }

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < text.length) {
    if (/\s/.test(text[offset]!)) { offset += 1; continue; }
    const rest = text.slice(offset);
    const operator = rest.startsWith("->") ? "->" : undefined;
    if (operator !== undefined) {
      tokens.push({ value: operator, offset });
      offset += operator.length;
      continue;
    }
    const character = text[offset]!;
    if ("()!&|".includes(character)) {
      tokens.push({ value: character, offset });
      offset += 1;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(rest);
    if (match === null) throw new FormulaValidationError(`unexpected character ${JSON.stringify(character)}`, `text[${offset}]`);
    tokens.push({ value: match[0], offset });
    offset += match[0].length;
  }
  return tokens;
}

export function parseFormula(text: string): LtlFormula {
  if (text.length > 20_000) throw new FormulaValidationError("formula text is too long", "text");
  const tokens = tokenize(text);
  let position = 0;
  const peek = (): string | undefined => tokens[position]?.value;
  const take = (): Token => {
    const token = tokens[position];
    if (token === undefined) throw new FormulaValidationError("unexpected end of formula", `text[${text.length}]`);
    position += 1;
    return token;
  };
  const parsePrimary = (): LtlFormula => {
    const token = take();
    if (token.value === "(") {
      const nested = parseImplies();
      const close = take();
      if (close.value !== ")") throw new FormulaValidationError("expected closing parenthesis", `text[${close.offset}]`);
      return nested;
    }
    if (token.value === "true" || token.value === "false") return { kind: token.value };
    if (!atomPattern.test(token.value) || ["X", "G", "F", "U"].includes(token.value)) {
      throw new FormulaValidationError(`unexpected token ${JSON.stringify(token.value)}`, `text[${token.offset}]`);
    }
    return { kind: "atom", name: token.value };
  };
  const parseUnary = (): LtlFormula => {
    const operator = peek();
    if (operator === "!" || operator === "X" || operator === "G" || operator === "F") {
      take();
      const kind = operator === "!" ? "not" : operator === "X" ? "next" : operator === "G" ? "always" : "eventually";
      return { kind, operand: parseUnary() };
    }
    return parsePrimary();
  };
  const parseUntil = (): LtlFormula => {
    let left = parseUnary();
    while (peek() === "U") { take(); left = { kind: "until", left, right: parseUnary() }; }
    return left;
  };
  const parseAnd = (): LtlFormula => {
    const operands = [parseUntil()];
    while (peek() === "&") { take(); operands.push(parseUntil()); }
    return operands.length === 1 ? operands[0]! : { kind: "and", operands };
  };
  const parseOr = (): LtlFormula => {
    const operands = [parseAnd()];
    while (peek() === "|") { take(); operands.push(parseAnd()); }
    return operands.length === 1 ? operands[0]! : { kind: "or", operands };
  };
  const parseImplies = (): LtlFormula => {
    const left = parseOr();
    if (peek() !== "->") return left;
    take();
    return { kind: "implies", left, right: parseImplies() };
  };
  if (tokens.length === 0) throw new FormulaValidationError("formula is empty", "text");
  const result = parseImplies();
  if (position !== tokens.length) {
    const token = tokens[position]!;
    throw new FormulaValidationError(`unexpected token ${JSON.stringify(token.value)}`, `text[${token.offset}]`);
  }
  return validateFormula(result) as LtlFormula;
}

const precedence: Record<LtlFormula["kind"], number> = {
  implies: 1, or: 2, and: 3, until: 4,
  not: 5, next: 5, always: 5, eventually: 5,
  atom: 6, true: 6, false: 6,
};

export function formatFormula(formula: LtlFormula): string {
  const render = (node: LtlFormula, parentPrecedence = 0): string => {
    const current = precedence[node.kind];
    let text: string;
    switch (node.kind) {
      case "true":
      case "false": text = node.kind; break;
      case "atom": text = node.name; break;
      case "not": text = `!${render(node.operand, current)}`; break;
      case "next": text = `X ${render(node.operand, current)}`; break;
      case "always": text = `G ${render(node.operand, current)}`; break;
      case "eventually": text = `F ${render(node.operand, current)}`; break;
      case "and": text = node.operands.map((operand) => render(operand, current)).join(" & "); break;
      case "or": text = node.operands.map((operand) => render(operand, current)).join(" | "); break;
      case "implies": text = `${render(node.left, current + 1)} -> ${render(node.right, current)}`; break;
      case "until": text = `${render(node.left, current)} U ${render(node.right, current + 1)}`; break;
    }
    return current < parentPrecedence ? `(${text})` : text;
  };
  return render(formula);
}
