import type {
  BindingEnvironment,
  FormulaValidationOptions,
  LtlFormula,
  MonitorFormula,
  PrefixVerdict,
  PropositionValuation,
} from "./types.js";
import { FormulaValidationError } from "./types.js";

const atomPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const temporalKinds = new Set(["next", "always", "eventually", "until"]);
const maximumDeadlineMs = 31_536_000_000;

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
        exactKeys(value, ["kind", "name", "env"], path);
        if (typeof value.name !== "string" || !atomPattern.test(value.name)) {
          throw new FormulaValidationError("invalid atom name", `${path}.name`);
        }
        if (atoms !== undefined && !atoms.has(value.name)) {
          throw new FormulaValidationError(`undeclared atom ${JSON.stringify(value.name)}`, `${path}.name`);
        }
        if (value.env === undefined) return { kind: "atom", name: value.name };
        const env = object(value.env, `${path}.env`);
        for (const [variable, bound] of Object.entries(env)) {
          if (!atomPattern.test(variable)) throw new FormulaValidationError("invalid bound variable name", `${path}.env`);
          if (bound !== null && typeof bound !== "string") throw new FormulaValidationError("bound values must be strings or null", `${path}.env.${variable}`);
        }
        return { kind: "atom", name: value.name, env: env as BindingEnvironment };
      }
      case "bind": {
        exactKeys(value, ["kind", "variable", "operand"], path);
        if (typeof value.variable !== "string" || !atomPattern.test(value.variable)) {
          throw new FormulaValidationError("invalid bind variable", `${path}.variable`);
        }
        const operand = visit(value.operand, `${path}.operand`, depth + 1, false);
        if (operand.kind === "deadline") throw new FormulaValidationError("deadline cannot be nested", `${path}.operand`);
        return { kind: "bind", variable: value.variable, operand };
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
        if ((value.withinMs as number) > maximumDeadlineMs) {
          throw new FormulaValidationError("withinMs cannot exceed 365 days", `${path}.withinMs`);
        }
        const trigger = visit(value.trigger, `${path}.trigger`, depth + 1, false);
        const response = visit(value.response, `${path}.response`, depth + 1, false);
        if (trigger.kind === "deadline" || response.kind === "deadline") {
          throw new FormulaValidationError("deadline cannot be nested", path);
        }
        if (containsTemporal(trigger) || containsTemporal(response)) {
          throw new FormulaValidationError("deadline trigger and response must be propositional", path);
        }
        if (containsBind(trigger) || containsBind(response)) {
          throw new FormulaValidationError("deadline trigger and response cannot bind variables", path);
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
    case "not":
    case "bind": return containsTemporal(formula.operand);
    case "and":
    case "or": return formula.operands.some(containsTemporal);
    case "implies": return containsTemporal(formula.left) || containsTemporal(formula.right);
    default: return false;
  }
}

export function containsBind(formula: LtlFormula): boolean {
  switch (formula.kind) {
    case "bind": return true;
    case "not":
    case "next":
    case "always":
    case "eventually": return containsBind(formula.operand);
    case "and":
    case "or": return formula.operands.some(containsBind);
    case "implies":
    case "until": return containsBind(formula.left) || containsBind(formula.right);
    default: return false;
  }
}

/** Freezes `variable` to `value` in every atom of `formula` that is not under a rebinding of the same variable. */
export function substituteBinding(formula: LtlFormula, variable: string, value: string | null): LtlFormula {
  switch (formula.kind) {
    case "true":
    case "false": return formula;
    case "atom": {
      const env = { ...formula.env, [variable]: value };
      return { kind: "atom", name: formula.name, env: Object.fromEntries(Object.keys(env).sort().map((key) => [key, env[key]!])) };
    }
    case "bind": return formula.variable === variable
      ? formula
      : { kind: "bind", variable: formula.variable, operand: substituteBinding(formula.operand, variable, value) };
    case "not":
    case "next":
    case "always":
    case "eventually": return { kind: formula.kind, operand: substituteBinding(formula.operand, variable, value) };
    case "and":
    case "or": return { kind: formula.kind, operands: formula.operands.map((operand) => substituteBinding(operand, variable, value)) };
    case "implies":
    case "until": return {
      kind: formula.kind,
      left: substituteBinding(formula.left, variable, value),
      right: substituteBinding(formula.right, variable, value),
    };
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

/** Observation-specific inputs for progression: atom truth under frozen bindings, and values captured at bind points. */
export interface ProgressionContext {
  atom(name: string, env: BindingEnvironment): boolean;
  bind(variable: string): string | undefined;
}

function valuationContext(valuation: PropositionValuation): ProgressionContext {
  return {
    atom: (name) => valuation[name] === true,
    bind: (variable) => { throw new Error(`Formula binds ${variable}; progress it with an observation-aware context`); },
  };
}

export function progressFormula(formula: LtlFormula, input: PropositionValuation | ProgressionContext): LtlFormula {
  const context = typeof input.atom === "function" && typeof input.bind === "function"
    ? input as ProgressionContext
    : valuationContext(input as PropositionValuation);
  const progress = (node: LtlFormula): LtlFormula => {
    switch (node.kind) {
      case "true":
      case "false": return node;
      case "atom": return { kind: context.atom(node.name, node.env ?? {}) ? "true" : "false" };
      case "bind": return progress(substituteBinding(node.operand, node.variable, context.bind(node.variable) ?? null));
      case "not": return negate(progress(node.operand));
      case "and":
      case "or": {
        // Short-circuit so binds in operands that cannot change the result capture nothing.
        const absorbing = node.kind === "and" ? "false" : "true";
        const progressed: LtlFormula[] = [];
        for (const operand of node.operands) {
          const next = progress(operand);
          if (next.kind === absorbing) return next;
          progressed.push(next);
        }
        return boolean(node.kind, progressed);
      }
      case "implies": {
        const left = progress(node.left);
        if (left.kind === "false") return { kind: "true" };
        return boolean("or", [negate(left), progress(node.right)]);
      }
      case "next": return node.operand;
      case "always": return node.operand.kind === "true"
        ? { kind: "true" }
        : boolean("and", [progress(node.operand), node]);
      case "eventually": return node.operand.kind === "false"
        ? { kind: "false" }
        : boolean("or", [progress(node.operand), node]);
      case "until": return boolean("or", [
        progress(node.right),
        boolean("and", [progress(node.left), node]),
      ]);
    }
  };
  return progress(formula);
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
    case "atom":
      if (formula.env !== undefined && position < trace.length) {
        throw new Error("Atoms with frozen bindings need observation-aware evaluation");
      }
      return trace[position]?.[formula.name] ?? false;
    case "bind":
      if (position < trace.length) throw new Error("Bind operators need observation-aware evaluation");
      return evaluateCompleteTrace(formula.operand, trace, position);
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

const reserved = new Set(["X", "G", "F", "U", "bind"]);

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
    if (!atomPattern.test(token.value) || reserved.has(token.value)) {
      throw new FormulaValidationError(`unexpected token ${JSON.stringify(token.value)}`, `text[${token.offset}]`);
    }
    return { kind: "atom", name: token.value };
  };
  const parseUnary = (): LtlFormula => {
    if (peek() === "bind" && tokens[position + 1]?.value === "(") {
      take();
      take();
      const variable = take();
      if (!atomPattern.test(variable.value) || reserved.has(variable.value)) {
        throw new FormulaValidationError(`invalid bind variable ${JSON.stringify(variable.value)}`, `text[${variable.offset}]`);
      }
      const close = take();
      if (close.value !== ")") throw new FormulaValidationError("expected closing parenthesis after bind variable", `text[${close.offset}]`);
      return { kind: "bind", variable: variable.value, operand: parseUnary() };
    }
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
  not: 5, next: 5, always: 5, eventually: 5, bind: 5,
  atom: 6, true: 6, false: 6,
};

export function formatFormula(formula: LtlFormula): string {
  const render = (node: LtlFormula, parentPrecedence = 0): string => {
    const current = precedence[node.kind];
    let text: string;
    switch (node.kind) {
      case "true":
      case "false": text = node.kind; break;
      case "atom": text = node.env === undefined
        ? node.name
        : `${node.name}{${Object.entries(node.env).map(([key, value]) => `${key}=${value === null ? "<missing>" : JSON.stringify(value)}`).join(", ")}}`;
        break;
      case "bind": text = `bind(${node.variable}) ${render(node.operand, current)}`; break;
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
