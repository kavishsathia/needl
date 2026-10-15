import { providers, type NormalizedEvent, type Provider } from "../core/types.js";
import { validateFormula } from "./formula.js";
import type { BindingEnvironment, LtlFormula, MonitorFormula, PropositionValuation } from "./types.js";

export type Scalar = string | number | boolean | null;
export type StateSnapshot = Readonly<Record<string, Scalar>>;

export interface DataPath {
  readonly root: "event" | "state";
  readonly segments: readonly string[];
}

/** Closed set of named recognizers; configuration never supplies a regular expression. */
export type ValuePattern = "issue-key";

const valuePatterns: Readonly<Record<ValuePattern, (text: string) => string | undefined>> = {
  // Tracker keys such as ENG-42, found anywhere in text like "eng-42-fix-retry"; normalized to upper case.
  "issue-key": (text) => /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9}-\d{1,9})(?![0-9])/.exec(text)?.[1]?.toUpperCase(),
};

interface SourceOptions {
  /** Only applies to events from this provider; other providers fall through to the next source. */
  readonly provider?: Provider;
  /** Reduces the extracted text to the first match of a named recognizer. */
  readonly pattern?: ValuePattern;
}

/** Where a value is read from an observation. */
export type ValueSource = SourceOptions & (
  | { readonly from: "subject"; readonly type?: string; readonly field?: "id" | "name" }
  | { readonly from: "relationship"; readonly type: string; readonly field?: "id" | "name" }
  | { readonly from: "event"; readonly path: readonly string[] }
  /** The authenticated provider body; present only when the integration retains full payloads. */
  | { readonly from: "payload"; readonly path: readonly string[] }
  | { readonly from: "literal"; readonly value: string }
);

type Operand =
  | { readonly path: DataPath; readonly source?: never }
  | { readonly source: ValueSource; readonly path?: never };

type Expected =
  | { readonly value: Scalar; readonly variable?: never }
  | { readonly variable: string; readonly value?: never };

export type Predicate =
  | { readonly op: "true" }
  | { readonly op: "false" }
  | ({ readonly op: "exists" } & Operand)
  | ({ readonly op: "equal" | "notEqual" | "lessThan" | "lessThanOrEqual" | "greaterThan" | "greaterThanOrEqual" | "contains" } & Operand & Expected)
  | ({ readonly op: "in"; readonly values: readonly Scalar[] } & Operand)
  | { readonly op: "not"; readonly operand: Predicate }
  | { readonly op: "and"; readonly operands: readonly Predicate[] }
  | { readonly op: "or"; readonly operands: readonly Predicate[] };

export type ScopeExtractor = ValueSource;

export interface ScopeKeyDefinition {
  readonly name: string;
  readonly extractors: readonly ScopeExtractor[];
}

/** A variable that `bind(name)` captures from the observation at that point in the formula. */
export interface BindingDefinition {
  readonly name: string;
  /** Tried in order; the first source that applies to the event and yields a value wins. */
  readonly extractors: readonly ValueSource[];
}

export interface PropositionDefinition {
  readonly name: string;
  readonly predicate: Predicate;
}

export type StateValueExpression =
  | { readonly from: "literal"; readonly value: Scalar }
  | { readonly from: "event"; readonly path: readonly string[] }
  | { readonly from: "delete" };

export interface StateUpdateDefinition {
  readonly when: Predicate;
  readonly set: Readonly<Record<string, StateValueExpression>>;
}

export interface AssertionDefinition {
  readonly id: string;
  readonly version: number;
  readonly tenantId: string;
  readonly name: string;
  readonly formula: MonitorFormula;
  readonly scope: { readonly keys: readonly ScopeKeyDefinition[] };
  readonly bindings?: readonly BindingDefinition[];
  readonly propositions: readonly PropositionDefinition[];
  readonly stateUpdates?: readonly StateUpdateDefinition[];
  /** Bounded inspection cache; the durable trace is stored independently. */
  readonly checkpointTraceLimit?: number;
}

export interface CompiledAssertion extends AssertionDefinition {
  readonly formula: MonitorFormula;
  readonly atomNames: readonly string[];
  /** Variables each proposition compares against; empty for propositions that need no binding. */
  readonly propositionVariables: Readonly<Record<string, readonly string[]>>;
  readonly checkpointTraceLimit: number;
}

export interface PredicateEvaluation {
  readonly value: boolean;
  readonly explanation: string;
  readonly missingPaths: readonly string[];
}

export interface PropositionEvaluationResult {
  readonly valuation: PropositionValuation;
  readonly evaluations: Readonly<Record<string, PredicateEvaluation>>;
}

const namePattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const unsafeSegments = new Set(["__proto__", "prototype", "constructor"]);
const missing = Symbol("missing");

function assertName(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !namePattern.test(value)) throw new Error(`${label} is invalid`);
}

function assertScalar(value: unknown, label: string): asserts value is Scalar {
  if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`${label} must be a JSON scalar`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function exactKeys(candidate: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(candidate)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unknown field ${JSON.stringify(key)}`);
  }
}

function validateSegments(segments: unknown, label: string): asserts segments is readonly string[] {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 32) {
    throw new Error(`${label} must contain 1 to 32 path segments`);
  }
  for (const segment of segments) {
    if (typeof segment !== "string" || segment.length === 0 || segment.length > 100) {
      throw new Error(`${label} contains an invalid path segment`);
    }
    if (unsafeSegments.has(segment)) throw new Error(`${label} contains unsafe path segment ${JSON.stringify(segment)}`);
  }
}

function validatePath(path: unknown, label: string): asserts path is DataPath {
  if (typeof path !== "object" || path === null || Array.isArray(path)) throw new Error(`${label} must be a data path`);
  const candidate = path as Partial<DataPath> & Record<string, unknown>;
  exactKeys(candidate, ["root", "segments"], label);
  if (candidate.root !== "event" && candidate.root !== "state") throw new Error(`${label}.root is invalid`);
  validateSegments(candidate.segments, `${label}.segments`);
}

function validateSource(source: unknown, label: string): asserts source is ValueSource {
  if (typeof source !== "object" || source === null || Array.isArray(source)) throw new Error(`${label} must be a value source`);
  const candidate = source as Record<string, unknown>;
  const options = ["provider", "pattern"];
  if (candidate.provider !== undefined && !providers.includes(candidate.provider as Provider)) throw new Error(`${label}.provider is unsupported`);
  if (candidate.pattern !== undefined && !Object.prototype.hasOwnProperty.call(valuePatterns, String(candidate.pattern))) {
    throw new Error(`${label}.pattern is not a supported named pattern`);
  }
  if (candidate.from === "subject") {
    exactKeys(candidate, ["from", "type", "field", ...options], label);
    if (candidate.type !== undefined) assertName(candidate.type, `${label}.type`);
  } else if (candidate.from === "relationship") {
    exactKeys(candidate, ["from", "type", "field", ...options], label);
    assertName(candidate.type, `${label}.type`);
  } else if (candidate.from === "event" || candidate.from === "payload") {
    exactKeys(candidate, ["from", "path", ...options], label);
    validateSegments(candidate.path, `${label}.path`);
  } else if (candidate.from === "literal") {
    exactKeys(candidate, ["from", "value", ...options], label);
    if (typeof candidate.value !== "string" || candidate.value.length === 0) throw new Error(`${label}.value must be a non-empty string`);
  } else throw new Error(`${label}.from is unsupported`);
  if ((candidate.from === "subject" || candidate.from === "relationship") && candidate.field !== undefined && candidate.field !== "id" && candidate.field !== "name") {
    throw new Error(`${label}.field must be id or name`);
  }
}

function validateOperand(candidate: Record<string, unknown>, label: string): void {
  if ((candidate.path === undefined) === (candidate.source === undefined)) throw new Error(`${label} needs exactly one of path or source`);
  if (candidate.path !== undefined) validatePath(candidate.path, `${label}.path`);
  else validateSource(candidate.source, `${label}.source`);
}

function validatePredicate(predicate: unknown, label: string, depth = 0): asserts predicate is Predicate {
  if (depth > 32) throw new Error(`${label} predicate nesting is too deep`);
  if (typeof predicate !== "object" || predicate === null || Array.isArray(predicate)) throw new Error(`${label} must be a predicate object`);
  const candidate = predicate as Record<string, unknown>;
  if (candidate.op === "true" || candidate.op === "false") {
    exactKeys(candidate, ["op"], label);
    return;
  }
  if (candidate.op === "exists") {
    exactKeys(candidate, ["op", "path", "source"], label);
    validateOperand(candidate, label);
    return;
  }
  if (["equal", "notEqual", "lessThan", "lessThanOrEqual", "greaterThan", "greaterThanOrEqual", "contains"].includes(String(candidate.op))) {
    exactKeys(candidate, ["op", "path", "source", "value", "variable"], label);
    validateOperand(candidate, label);
    if (candidate.variable !== undefined) {
      if (Object.prototype.hasOwnProperty.call(candidate, "value")) throw new Error(`${label} needs exactly one of value or variable`);
      assertName(candidate.variable, `${label}.variable`);
    } else assertScalar(candidate.value, `${label}.value`);
    if (candidate.op === "contains" && candidate.variable === undefined && typeof candidate.value !== "string") {
      throw new Error(`${label}.value must be a string for contains`);
    }
    return;
  }
  if (candidate.op === "in") {
    exactKeys(candidate, ["op", "path", "source", "values"], label);
    validateOperand(candidate, label);
    if (!Array.isArray(candidate.values) || candidate.values.length === 0 || candidate.values.length > 100) {
      throw new Error(`${label}.values must contain 1 to 100 scalars`);
    }
    candidate.values.forEach((value, index) => assertScalar(value, `${label}.values[${index}]`));
    return;
  }
  if (candidate.op === "not") {
    exactKeys(candidate, ["op", "operand"], label);
    validatePredicate(candidate.operand, `${label}.operand`, depth + 1);
    return;
  }
  if (candidate.op === "and" || candidate.op === "or") {
    exactKeys(candidate, ["op", "operands"], label);
    if (!Array.isArray(candidate.operands) || candidate.operands.length < 2 || candidate.operands.length > 100) {
      throw new Error(`${label}.operands must contain 2 to 100 predicates`);
    }
    candidate.operands.forEach((operand, index) => validatePredicate(operand, `${label}.operands[${index}]`, depth + 1));
    return;
  }
  throw new Error(`${label} has unsupported predicate operator ${JSON.stringify(candidate.op)}`);
}

function readPath(root: unknown, segments: readonly string[]): unknown | typeof missing {
  let value = root;
  for (const segment of segments) {
    if (typeof value !== "object" || value === null) return missing;
    if (Array.isArray(value)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) return missing;
      value = value[index];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return missing;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function displayPath(path: DataPath): string {
  return `${path.root}.${path.segments.join(".")}`;
}

function displaySource(source: ValueSource): string {
  const base = source.from === "literal" ? `literal(${JSON.stringify(source.value)})`
    : source.from === "event" || source.from === "payload" ? `${source.from}.${source.path.join(".")}`
      : `${source.from}${source.type === undefined ? "" : `[${source.type}]`}.${source.field ?? "id"}`;
  return `${source.provider === undefined ? "" : `${source.provider}:`}${base}${source.pattern === undefined ? "" : `~${source.pattern}`}`;
}

const parsedPayloads = new WeakMap<NormalizedEvent, unknown>();

function payloadOf(event: NormalizedEvent): unknown | typeof missing {
  if (parsedPayloads.has(event)) return parsedPayloads.get(event);
  const raw = event.evidence.originalPayload;
  let parsed: unknown = missing;
  if (raw !== undefined) {
    try { parsed = JSON.parse(raw); } catch { parsed = missing; }
  }
  parsedPayloads.set(event, parsed);
  return parsed;
}

/** Reads one value from an observation; `undefined` when the source does not apply or yields nothing. */
export function extractValue(source: ValueSource, event: NormalizedEvent): string | undefined {
  if (source.provider !== undefined && source.provider !== event.provider) return undefined;
  let raw: unknown;
  if (source.from === "literal") raw = source.value;
  else if (source.from === "subject") {
    raw = source.type === undefined || event.subject.type === source.type
      ? (source.field === "name" ? event.subject.name : event.subject.id)
      : undefined;
  } else if (source.from === "relationship") {
    const relationship = event.relationships.find((candidate) => candidate.type === source.type);
    raw = source.field === "name" ? relationship?.name : relationship?.id;
  } else if (source.from === "event") raw = readPath(event, source.path);
  else {
    const payload = payloadOf(event);
    raw = payload === missing ? undefined : readPath(payload, source.path);
  }
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const text = String(raw);
  const value = source.pattern === undefined ? text : valuePatterns[source.pattern](text);
  return value === undefined || value.length === 0 ? undefined : value;
}

export function evaluatePredicate(
  predicate: Predicate,
  event: NormalizedEvent,
  state: StateSnapshot,
  env: BindingEnvironment = {},
): PredicateEvaluation {
  const operandValue = (node: { readonly path?: DataPath; readonly source?: ValueSource }): unknown | typeof missing => {
    if (node.source !== undefined) return extractValue(node.source, event) ?? missing;
    return readPath(node.path!.root === "event" ? event : state, node.path!.segments);
  };
  const operandName = (node: { readonly path?: DataPath; readonly source?: ValueSource }): string =>
    node.source !== undefined ? displaySource(node.source) : displayPath(node.path!);
  const evaluate = (node: Predicate): PredicateEvaluation => {
    if (node.op === "true" || node.op === "false") {
      return { value: node.op === "true", explanation: node.op, missingPaths: [] };
    }
    if (node.op === "not") {
      const nested = evaluate(node.operand);
      return { value: !nested.value, explanation: `not (${nested.explanation})`, missingPaths: nested.missingPaths };
    }
    if (node.op === "and" || node.op === "or") {
      const nested = node.operands.map(evaluate);
      return {
        value: node.op === "and" ? nested.every((item) => item.value) : nested.some((item) => item.value),
        explanation: nested.map((item) => `(${item.explanation})`).join(node.op === "and" ? " and " : " or "),
        missingPaths: [...new Set(nested.flatMap((item) => item.missingPaths))],
      };
    }
    const actual = operandValue(node);
    const path = operandName(node);
    if (actual === missing) {
      return { value: false, explanation: `${path} is missing`, missingPaths: [path] };
    }
    if (node.op === "exists") return { value: true, explanation: `${path} exists`, missingPaths: [] };
    if (node.op === "in") {
      const value = node.values.some((candidate) => Object.is(candidate, actual));
      return { value, explanation: `${path} in ${JSON.stringify(node.values)} was ${JSON.stringify(actual)} => ${String(value)}`, missingPaths: [] };
    }
    let expected: Scalar;
    let expectedText: string;
    if (node.variable !== undefined) {
      const bound = env[node.variable];
      if (bound === undefined) return { value: false, explanation: `${node.variable} is not bound here`, missingPaths: [] };
      if (bound === null) return { value: false, explanation: `${node.variable} had no value where it was bound`, missingPaths: [] };
      expected = bound;
      expectedText = `${node.variable}=${JSON.stringify(bound)}`;
    } else {
      expected = node.value;
      expectedText = JSON.stringify(node.value);
    }
    let value: boolean;
    if (node.op === "equal") value = Object.is(actual, expected);
    else if (node.op === "notEqual") value = !Object.is(actual, expected);
    else if (node.op === "contains") value = typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    else {
      const comparable = (typeof actual === "number" && typeof expected === "number")
        || (typeof actual === "string" && typeof expected === "string");
      if (!comparable) value = false;
      else if (node.op === "lessThan") value = (actual as string | number) < expected!;
      else if (node.op === "lessThanOrEqual") value = (actual as string | number) <= expected!;
      else if (node.op === "greaterThan") value = (actual as string | number) > expected!;
      else value = (actual as string | number) >= expected!;
    }
    return { value, explanation: `${path} ${node.op} ${expectedText} was ${JSON.stringify(actual)} => ${String(value)}`, missingPaths: [] };
  };
  return evaluate(predicate);
}

export function compileAssertion(definition: AssertionDefinition): CompiledAssertion {
  assertName(definition.id, "assertion id");
  if (!Number.isSafeInteger(definition.version) || definition.version <= 0) throw new Error("assertion version must be a positive integer");
  if (typeof definition.tenantId !== "string" || definition.tenantId.length === 0) throw new Error("tenantId is required");
  if (typeof definition.name !== "string" || definition.name.length === 0) throw new Error("assertion name is required");
  if (!Array.isArray(definition.propositions) || definition.propositions.length === 0) throw new Error("at least one proposition is required");
  const bindingNames = new Set<string>();
  for (const [index, binding] of (definition.bindings ?? []).entries()) {
    assertName(binding.name, `bindings[${index}].name`);
    if (bindingNames.has(binding.name)) throw new Error(`duplicate binding ${JSON.stringify(binding.name)}`);
    bindingNames.add(binding.name);
    if (!Array.isArray(binding.extractors) || binding.extractors.length === 0) throw new Error(`binding ${binding.name} needs an extractor`);
    binding.extractors.forEach((source, sourceIndex) => validateSource(source, `bindings[${index}].extractors[${sourceIndex}]`));
  }
  const names = new Set<string>();
  const propositionVariables: Record<string, readonly string[]> = {};
  for (const [index, proposition] of definition.propositions.entries()) {
    assertName(proposition.name, `propositions[${index}].name`);
    if (names.has(proposition.name)) throw new Error(`duplicate proposition ${JSON.stringify(proposition.name)}`);
    names.add(proposition.name);
    validatePredicate(proposition.predicate, `propositions[${index}].predicate`);
    const variables = [...predicateVariables(proposition.predicate)].sort();
    for (const variable of variables) {
      if (!bindingNames.has(variable)) throw new Error(`proposition ${proposition.name} uses undeclared binding ${JSON.stringify(variable)}`);
    }
    propositionVariables[proposition.name] = variables;
  }
  const formula = validateFormula(definition.formula, { atoms: [...names] });
  if (formula.kind !== "deadline") checkBindingUse(formula, propositionVariables, bindingNames);
  if (!Array.isArray(definition.scope?.keys) || definition.scope.keys.length === 0) throw new Error("at least one scope key is required");
  const scopeNames = new Set<string>();
  for (const [index, key] of definition.scope.keys.entries()) {
    assertName(key.name, `scope.keys[${index}].name`);
    if (scopeNames.has(key.name)) throw new Error(`duplicate scope key ${JSON.stringify(key.name)}`);
    scopeNames.add(key.name);
    if (!Array.isArray(key.extractors) || key.extractors.length === 0) throw new Error(`scope key ${key.name} needs an extractor`);
    key.extractors.forEach((extractor: unknown, extractorIndex: number) => validateSource(extractor, `scope key ${key.name} extractors[${extractorIndex}]`));
  }
  for (const [index, update] of (definition.stateUpdates ?? []).entries()) {
    validatePredicate(update.when, `stateUpdates[${index}].when`);
    if (predicateVariables(update.when).size > 0) throw new Error(`stateUpdates[${index}].when cannot use bound variables`);
    if (typeof update.set !== "object" || update.set === null || Array.isArray(update.set)) throw new Error(`stateUpdates[${index}].set must be an object`);
    for (const [key, expression] of Object.entries(update.set)) {
      assertName(key, `stateUpdates[${index}].set key`);
      if (expression.from === "literal") assertScalar(expression.value, `stateUpdates[${index}].set.${key}.value`);
      else if (expression.from === "event") validateSegments(expression.path, `stateUpdates[${index}].set.${key}.path`);
      else if (expression.from !== "delete") throw new Error(`stateUpdates[${index}].set.${key} has unsupported value expression`);
    }
  }
  const checkpointTraceLimit = definition.checkpointTraceLimit ?? 100;
  if (!Number.isSafeInteger(checkpointTraceLimit) || checkpointTraceLimit < 1 || checkpointTraceLimit > 10_000) {
    throw new Error("checkpointTraceLimit must be between 1 and 10000");
  }
  return { ...definition, formula, atomNames: [...names], propositionVariables, checkpointTraceLimit };
}

function predicateVariables(predicate: Predicate, output = new Set<string>()): Set<string> {
  if (predicate.op === "not") predicateVariables(predicate.operand, output);
  else if (predicate.op === "and" || predicate.op === "or") predicate.operands.forEach((operand) => predicateVariables(operand, output));
  else if ("variable" in predicate && typeof predicate.variable === "string") output.add(predicate.variable);
  return output;
}

/** Every atom must sit under a `bind` (or carry a frozen value) for each variable its proposition compares against. */
function checkBindingUse(
  formula: LtlFormula,
  propositionVariables: Readonly<Record<string, readonly string[]>>,
  declared: ReadonlySet<string>,
  bound: ReadonlySet<string> = new Set(),
): void {
  switch (formula.kind) {
    case "true":
    case "false": return;
    case "atom": {
      for (const variable of propositionVariables[formula.name] ?? []) {
        if (!bound.has(variable) && !(formula.env !== undefined && variable in formula.env)) {
          throw new Error(`atom ${formula.name} uses ${variable} outside any bind(${variable})`);
        }
      }
      return;
    }
    case "bind":
      if (!declared.has(formula.variable)) throw new Error(`bind(${formula.variable}) has no binding definition`);
      checkBindingUse(formula.operand, propositionVariables, declared, new Set([...bound, formula.variable]));
      return;
    case "not":
    case "next":
    case "always":
    case "eventually": checkBindingUse(formula.operand, propositionVariables, declared, bound); return;
    case "and":
    case "or": formula.operands.forEach((operand) => checkBindingUse(operand, propositionVariables, declared, bound)); return;
    case "implies":
    case "until":
      checkBindingUse(formula.left, propositionVariables, declared, bound);
      checkBindingUse(formula.right, propositionVariables, declared, bound);
  }
}

function firstValue(sources: readonly ValueSource[], event: NormalizedEvent): string | undefined {
  for (const source of sources) {
    const value = extractValue(source, event);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The value `bind(variable)` captures from this observation, if any source yields one. */
export function extractBinding(assertion: CompiledAssertion, variable: string, event: NormalizedEvent): string | undefined {
  const binding = assertion.bindings?.find((candidate) => candidate.name === variable);
  if (binding === undefined) throw new Error(`Assertion ${assertion.id} has no binding ${variable}`);
  return firstValue(binding.extractors, event);
}

export function extractScope(assertion: CompiledAssertion, event: NormalizedEvent): Readonly<Record<string, string>> | undefined {
  const scope: Record<string, string> = {};
  for (const key of assertion.scope.keys) {
    const binding = firstValue(key.extractors, event);
    if (binding === undefined) return undefined;
    scope[key.name] = binding;
  }
  return scope;
}

export function applyStateUpdates(
  assertion: CompiledAssertion,
  event: NormalizedEvent,
  previous: StateSnapshot,
): StateSnapshot {
  const state: Record<string, Scalar> = { ...previous };
  for (const update of assertion.stateUpdates ?? []) {
    if (!evaluatePredicate(update.when, event, state).value) continue;
    for (const [key, expression] of Object.entries(update.set)) {
      if (expression.from === "delete") delete state[key];
      else if (expression.from === "literal") state[key] = expression.value;
      else {
        const value = readPath(event, expression.path);
        if (value !== missing && (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
          state[key] = value;
        }
      }
    }
  }
  return state;
}

export function evaluatePropositions(
  assertion: CompiledAssertion,
  event: NormalizedEvent,
  state: StateSnapshot,
): PropositionEvaluationResult {
  const valuation: Record<string, boolean> = {};
  const evaluations: Record<string, PredicateEvaluation> = {};
  for (const proposition of assertion.propositions) {
    // Propositions over bound variables are evaluated per frozen environment during progression.
    if ((assertion.propositionVariables[proposition.name] ?? []).length > 0) continue;
    const evaluation = evaluatePredicate(proposition.predicate, event, state);
    valuation[proposition.name] = evaluation.value;
    evaluations[proposition.name] = evaluation;
  }
  return { valuation, evaluations };
}
