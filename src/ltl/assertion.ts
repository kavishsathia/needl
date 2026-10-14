import type { NormalizedEvent } from "../core/types.js";
import { validateFormula } from "./formula.js";
import type { MonitorFormula, PropositionValuation } from "./types.js";

export type Scalar = string | number | boolean | null;
export type StateSnapshot = Readonly<Record<string, Scalar>>;

export interface DataPath {
  readonly root: "event" | "state";
  readonly segments: readonly string[];
}

export type Predicate =
  | { readonly op: "true" }
  | { readonly op: "false" }
  | { readonly op: "exists"; readonly path: DataPath }
  | { readonly op: "equal" | "notEqual" | "lessThan" | "lessThanOrEqual" | "greaterThan" | "greaterThanOrEqual"; readonly path: DataPath; readonly value: Scalar }
  | { readonly op: "in"; readonly path: DataPath; readonly values: readonly Scalar[] }
  | { readonly op: "not"; readonly operand: Predicate }
  | { readonly op: "and"; readonly operands: readonly Predicate[] }
  | { readonly op: "or"; readonly operands: readonly Predicate[] };

export type ScopeExtractor =
  | { readonly from: "subject"; readonly type?: string }
  | { readonly from: "relationship"; readonly type: string }
  | { readonly from: "event"; readonly path: readonly string[] }
  | { readonly from: "literal"; readonly value: string };

export interface ScopeKeyDefinition {
  readonly name: string;
  readonly extractors: readonly ScopeExtractor[];
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
  readonly propositions: readonly PropositionDefinition[];
  readonly stateUpdates?: readonly StateUpdateDefinition[];
  /** Bounded inspection cache; the durable trace is stored independently. */
  readonly checkpointTraceLimit?: number;
}

export interface CompiledAssertion extends AssertionDefinition {
  readonly formula: MonitorFormula;
  readonly atomNames: readonly string[];
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
  const candidate = path as Partial<DataPath>;
  if (candidate.root !== "event" && candidate.root !== "state") throw new Error(`${label}.root is invalid`);
  validateSegments(candidate.segments, `${label}.segments`);
}

function validatePredicate(predicate: unknown, label: string, depth = 0): asserts predicate is Predicate {
  if (depth > 32) throw new Error(`${label} predicate nesting is too deep`);
  if (typeof predicate !== "object" || predicate === null || Array.isArray(predicate)) throw new Error(`${label} must be a predicate object`);
  const candidate = predicate as Record<string, unknown>;
  if (candidate.op === "true" || candidate.op === "false") return;
  if (candidate.op === "exists") { validatePath(candidate.path, `${label}.path`); return; }
  if (["equal", "notEqual", "lessThan", "lessThanOrEqual", "greaterThan", "greaterThanOrEqual"].includes(String(candidate.op))) {
    validatePath(candidate.path, `${label}.path`);
    assertScalar(candidate.value, `${label}.value`);
    return;
  }
  if (candidate.op === "in") {
    validatePath(candidate.path, `${label}.path`);
    if (!Array.isArray(candidate.values) || candidate.values.length === 0 || candidate.values.length > 100) {
      throw new Error(`${label}.values must contain 1 to 100 scalars`);
    }
    candidate.values.forEach((value, index) => assertScalar(value, `${label}.values[${index}]`));
    return;
  }
  if (candidate.op === "not") { validatePredicate(candidate.operand, `${label}.operand`, depth + 1); return; }
  if (candidate.op === "and" || candidate.op === "or") {
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

export function evaluatePredicate(
  predicate: Predicate,
  event: NormalizedEvent,
  state: StateSnapshot,
): PredicateEvaluation {
  const pathValue = (path: DataPath): unknown | typeof missing => readPath(path.root === "event" ? event : state, path.segments);
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
    const actual = pathValue(node.path);
    const path = displayPath(node.path);
    if (actual === missing) {
      return { value: false, explanation: `${path} is missing`, missingPaths: [path] };
    }
    if (node.op === "exists") return { value: true, explanation: `${path} exists`, missingPaths: [] };
    let value: boolean;
    if (node.op === "in") value = node.values.some((candidate) => Object.is(candidate, actual));
    else if (node.op === "equal") value = Object.is(actual, node.value);
    else if (node.op === "notEqual") value = !Object.is(actual, node.value);
    else {
      const comparable = (typeof actual === "number" && typeof node.value === "number")
        || (typeof actual === "string" && typeof node.value === "string");
      if (!comparable) value = false;
      else if (node.op === "lessThan") value = actual < node.value;
      else if (node.op === "lessThanOrEqual") value = actual <= node.value;
      else if (node.op === "greaterThan") value = actual > node.value;
      else value = actual >= node.value;
    }
    const expected = node.op === "in" ? JSON.stringify(node.values) : JSON.stringify(node.value);
    return { value, explanation: `${path} ${node.op} ${expected} was ${JSON.stringify(actual)} => ${String(value)}`, missingPaths: [] };
  };
  return evaluate(predicate);
}

export function compileAssertion(definition: AssertionDefinition): CompiledAssertion {
  assertName(definition.id, "assertion id");
  if (!Number.isSafeInteger(definition.version) || definition.version <= 0) throw new Error("assertion version must be a positive integer");
  if (typeof definition.tenantId !== "string" || definition.tenantId.length === 0) throw new Error("tenantId is required");
  if (typeof definition.name !== "string" || definition.name.length === 0) throw new Error("assertion name is required");
  if (!Array.isArray(definition.propositions) || definition.propositions.length === 0) throw new Error("at least one proposition is required");
  const names = new Set<string>();
  for (const [index, proposition] of definition.propositions.entries()) {
    assertName(proposition.name, `propositions[${index}].name`);
    if (names.has(proposition.name)) throw new Error(`duplicate proposition ${JSON.stringify(proposition.name)}`);
    names.add(proposition.name);
    validatePredicate(proposition.predicate, `propositions[${index}].predicate`);
  }
  const formula = validateFormula(definition.formula, { atoms: [...names] });
  if (!Array.isArray(definition.scope?.keys) || definition.scope.keys.length === 0) throw new Error("at least one scope key is required");
  const scopeNames = new Set<string>();
  for (const [index, key] of definition.scope.keys.entries()) {
    assertName(key.name, `scope.keys[${index}].name`);
    if (scopeNames.has(key.name)) throw new Error(`duplicate scope key ${JSON.stringify(key.name)}`);
    scopeNames.add(key.name);
    if (!Array.isArray(key.extractors) || key.extractors.length === 0) throw new Error(`scope key ${key.name} needs an extractor`);
    for (const extractor of key.extractors) {
      if (extractor.from === "event") validateSegments(extractor.path, `scope key ${key.name} event path`);
      else if (extractor.from === "relationship") assertName(extractor.type, `scope key ${key.name} relationship type`);
      else if (extractor.from === "subject") {
        if (extractor.type !== undefined) assertName(extractor.type, `scope key ${key.name} subject type`);
      } else if (extractor.from === "literal") {
        if (extractor.value.length === 0) throw new Error(`scope key ${key.name} literal is empty`);
      } else throw new Error(`scope key ${key.name} has unsupported extractor`);
    }
  }
  for (const [index, update] of (definition.stateUpdates ?? []).entries()) {
    validatePredicate(update.when, `stateUpdates[${index}].when`);
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
  return { ...definition, formula, atomNames: [...names], checkpointTraceLimit };
}

export function extractScope(assertion: CompiledAssertion, event: NormalizedEvent): Readonly<Record<string, string>> | undefined {
  const scope: Record<string, string> = {};
  for (const key of assertion.scope.keys) {
    let binding: string | undefined;
    for (const extractor of key.extractors) {
      if (extractor.from === "literal") binding = extractor.value;
      else if (extractor.from === "subject") {
        if (extractor.type === undefined || event.subject.type === extractor.type) binding = event.subject.id;
      } else if (extractor.from === "relationship") {
        binding = event.relationships.find((relationship) => relationship.type === extractor.type)?.id;
      } else {
        const value = readPath(event, extractor.path);
        if (typeof value === "string" || typeof value === "number") binding = String(value);
      }
      if (binding !== undefined && binding.length > 0) break;
    }
    if (binding === undefined || binding.length === 0) return undefined;
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
    const evaluation = evaluatePredicate(proposition.predicate, event, state);
    valuation[proposition.name] = evaluation.value;
    evaluations[proposition.name] = evaluation;
  }
  return { valuation, evaluations };
}
