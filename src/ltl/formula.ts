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
const temporalKinds = new Set<LtlFormula["kind"]>([
  "next", "always", "eventually", "until", "weakUntil",
  "eventuallyWithin", "alwaysWithin", "untilWithin", "eventuallyBy", "alwaysBy", "untilBy",
]);
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
      case "weakUntil": {
        exactKeys(value, ["kind", "left", "right"], path);
        return { kind: "weakUntil", left: nested(value.left, `${path}.left`, depth), right: nested(value.right, `${path}.right`, depth) };
      }
      case "eventuallyWithin":
      case "alwaysWithin": {
        exactKeys(value, ["kind", "operand", "withinMs"], path);
        return { kind: value.kind, operand: nested(value.operand, `${path}.operand`, depth), withinMs: windowMs(value.withinMs, `${path}.withinMs`) };
      }
      case "untilWithin": {
        exactKeys(value, ["kind", "left", "right", "withinMs"], path);
        return {
          kind: "untilWithin",
          left: nested(value.left, `${path}.left`, depth),
          right: nested(value.right, `${path}.right`, depth),
          withinMs: windowMs(value.withinMs, `${path}.withinMs`),
        };
      }
      case "eventuallyBy":
      case "alwaysBy": {
        exactKeys(value, ["kind", "operand", "by"], path);
        return { kind: value.kind, operand: nested(value.operand, `${path}.operand`, depth), by: instant(value.by, `${path}.by`) };
      }
      case "untilBy": {
        exactKeys(value, ["kind", "left", "right", "by"], path);
        return {
          kind: "untilBy",
          left: nested(value.left, `${path}.left`, depth),
          right: nested(value.right, `${path}.right`, depth),
          by: instant(value.by, `${path}.by`),
        };
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

  const nested = (candidate: unknown, path: string, depth: number): LtlFormula => {
    const parsed = visit(candidate, path, depth + 1, false);
    if (parsed.kind === "deadline") throw new FormulaValidationError("deadline cannot be nested", path);
    return parsed;
  };

  return visit(input, "$", 0, true);
}

function windowMs(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new FormulaValidationError("withinMs must be a positive safe integer", path);
  if ((value as number) > maximumDeadlineMs) throw new FormulaValidationError("withinMs cannot exceed 365 days", path);
  return value as number;
}

function instant(value: unknown, path: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new FormulaValidationError("by must be an ISO-8601 timestamp", path);
  return new Date(value).toISOString();
}

/** Direct sub-formulas, in source order. */
export function formulaChildren(formula: LtlFormula): readonly LtlFormula[] {
  switch (formula.kind) {
    case "true":
    case "false":
    case "atom": return [];
    case "and":
    case "or": return formula.operands;
    case "implies":
    case "until":
    case "weakUntil":
    case "untilWithin":
    case "untilBy": return [formula.left, formula.right];
    default: return [formula.operand];
  }
}

function someNode(formula: LtlFormula, test: (node: LtlFormula) => boolean): boolean {
  return test(formula) || formulaChildren(formula).some((child) => someNode(child, test));
}

export function containsTemporal(formula: LtlFormula): boolean {
  return someNode(formula, (node) => temporalKinds.has(node.kind));
}

export function containsBind(formula: LtlFormula): boolean {
  return someNode(formula, (node) => node.kind === "bind");
}

const timedKinds = new Set<LtlFormula["kind"]>(["eventuallyWithin", "alwaysWithin", "untilWithin", "eventuallyBy", "alwaysBy", "untilBy"]);

/** True when the formula has a time window, so evaluating it needs observation times rather than positions alone. */
export function containsTimed(formula: LtlFormula): boolean {
  return someNode(formula, (node) => timedKinds.has(node.kind));
}

/** Rebuilds `formula` with each direct sub-formula replaced by `map(child)`. */
function mapChildren(formula: LtlFormula, map: (child: LtlFormula) => LtlFormula): LtlFormula {
  switch (formula.kind) {
    case "true":
    case "false":
    case "atom": return formula;
    case "and":
    case "or": return { kind: formula.kind, operands: formula.operands.map(map) };
    case "implies":
    case "until":
    case "weakUntil": return { kind: formula.kind, left: map(formula.left), right: map(formula.right) };
    case "untilWithin": return { ...formula, left: map(formula.left), right: map(formula.right) };
    case "untilBy": return { ...formula, left: map(formula.left), right: map(formula.right) };
    case "bind": return { ...formula, operand: map(formula.operand) };
    case "eventuallyWithin":
    case "alwaysWithin": return { ...formula, operand: map(formula.operand) };
    case "eventuallyBy":
    case "alwaysBy": return { ...formula, operand: map(formula.operand) };
    default: return { kind: formula.kind, operand: map(formula.operand) };
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
    default: return mapChildren(formula, (child) => substituteBinding(child, variable, value));
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
  /** The observation's ISO-8601 time; required by timed operators. */
  readonly at?: string;
}

function timeOf(value: string): number {
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error(`Invalid timestamp ${value}`);
  return time;
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
      case "until":
      case "weakUntil": return boolean("or", [
        progress(node.right),
        boolean("and", [progress(node.left), node]),
      ]);
      case "eventuallyWithin":
      case "alwaysWithin": return progress({ kind: node.kind === "eventuallyWithin" ? "eventuallyBy" : "alwaysBy", operand: node.operand, by: windowEnd(node.withinMs) });
      case "untilWithin": return progress({ kind: "untilBy", left: node.left, right: node.right, by: windowEnd(node.withinMs) });
      case "eventuallyBy": return now() > timeOf(node.by) ? { kind: "false" } : boolean("or", [progress(node.operand), node]);
      case "alwaysBy": return now() > timeOf(node.by) ? { kind: "true" } : boolean("and", [progress(node.operand), node]);
      case "untilBy": return now() > timeOf(node.by)
        ? { kind: "false" }
        : boolean("or", [progress(node.right), boolean("and", [progress(node.left), node])]);
    }
  };
  const now = (): number => {
    if (context.at === undefined) throw new Error("Timed operators need the observation time; progress them with an observation-aware context");
    return timeOf(context.at);
  };
  const windowEnd = (withinMs: number): string => new Date(now() + withinMs).toISOString();
  return progress(formula);
}

/**
 * Applies the passage of time with no observation: every future observation is later than `at`, so a window that
 * closed before `at` can no longer be met (eventually/until become false) or broken (always becomes true).
 */
export function advanceFormulaTime(formula: LtlFormula, at: string): LtlFormula {
  const now = timeOf(at);
  const advance = (node: LtlFormula): LtlFormula => {
    switch (node.kind) {
      case "eventuallyBy":
      case "untilBy": return now > timeOf(node.by) ? { kind: "false" } : node;
      case "alwaysBy": return now > timeOf(node.by) ? { kind: "true" } : node;
      case "not": return negate(advance(node.operand));
      case "and":
      case "or": return boolean(node.kind, node.operands.map(advance));
      case "implies": {
        const left = advance(node.left);
        const right = advance(node.right);
        if (left.kind === "false" || right.kind === "true") return { kind: "true" };
        if (left.kind === "true") return right;
        return { kind: "implies", left, right };
      }
      default: return mapChildren(node, advance);
    }
  };
  return advance(formula);
}

/** The earliest end of an opened time window, when one is pending. */
export function nextDeadline(formula: LtlFormula): string | undefined {
  let earliest: string | undefined;
  const visit = (node: LtlFormula): void => {
    if ((node.kind === "eventuallyBy" || node.kind === "alwaysBy" || node.kind === "untilBy") && (earliest === undefined || node.by < earliest)) earliest = node.by;
    formulaChildren(node).forEach(visit);
  };
  visit(formula);
  return earliest;
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
    case "until":
    case "weakUntil": {
      for (let end = position; end < trace.length; end += 1) {
        if (!evaluateCompleteTrace(formula.right, trace, end)) continue;
        let held = true;
        for (let index = position; index < end; index += 1) {
          if (!evaluateCompleteTrace(formula.left, trace, index)) held = false;
        }
        if (held) return true;
      }
      if (formula.kind === "until") return false;
      for (let index = position; index < trace.length; index += 1) {
        if (!evaluateCompleteTrace(formula.left, trace, index)) return false;
      }
      return true;
    }
    default:
      // Timed operators need observation times; only the empty remaining suffix is decidable from positions alone.
      if (position < trace.length) throw new Error("Timed operators need observation times; evaluate them by progression");
      return formula.kind === "alwaysWithin" || formula.kind === "alwaysBy";
  }
}

interface Token { readonly value: string; readonly offset: number }

const reserved = new Set(["X", "G", "F", "U", "W", "bind"]);

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
    while (peek() === "U" || peek() === "W") { const kind = take().value === "U" ? "until" : "weakUntil"; left = { kind, left, right: parseUnary() }; }
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
  implies: 1, or: 2, and: 3, until: 4, weakUntil: 4, untilWithin: 4, untilBy: 4,
  not: 5, next: 5, always: 5, eventually: 5, bind: 5, eventuallyWithin: 5, alwaysWithin: 5, eventuallyBy: 5, alwaysBy: 5,
  atom: 6, true: 6, false: 6,
};

/** Compact window label such as `30m`, `2h` or `1d12h`. */
export function formatDuration(ms: number): string {
  const units: readonly [string, number][] = [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1_000], ["ms", 1]];
  let rest = ms;
  let text = "";
  for (const [unit, size] of units) {
    if (rest >= size) {
      text += `${Math.floor(rest / size)}${unit}`;
      rest %= size;
    }
  }
  return text || "0ms";
}

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
      case "weakUntil": text = `${render(node.left, current)} W ${render(node.right, current + 1)}`; break;
      case "untilWithin": text = `${render(node.left, current)} U[<=${formatDuration(node.withinMs)}] ${render(node.right, current + 1)}`; break;
      case "untilBy": text = `${render(node.left, current)} U[<=${node.by}] ${render(node.right, current + 1)}`; break;
      case "eventuallyWithin": text = `F[<=${formatDuration(node.withinMs)}] ${render(node.operand, current)}`; break;
      case "alwaysWithin": text = `G[<=${formatDuration(node.withinMs)}] ${render(node.operand, current)}`; break;
      case "eventuallyBy": text = `F[<=${node.by}] ${render(node.operand, current)}`; break;
      case "alwaysBy": text = `G[<=${node.by}] ${render(node.operand, current)}`; break;
    }
    return current < parentPrecedence ? `(${text})` : text;
  };
  return render(formula);
}
