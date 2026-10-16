import type { AssertionDefinition, BindingDefinition, Predicate, PropositionDefinition, Scalar } from "../ltl/assertion.js";
import type { LtlFormula } from "../ltl/types.js";
import type { CatalogueEvent, CatalogueField } from "./catalogue.js";
import { textSource, type CheckedRule, type ParamInfo, type ResolvedCondition } from "./check.js";
import type { ComparisonOp, Expr } from "./syntax.js";

/** Values chosen for a rule's `$` bindings: a scalar, or a list for bindings used with `in`. */
export type ParamValue = string | number | boolean | readonly (string | number | boolean)[];
export type ParamValues = Readonly<Record<string, ParamValue>>;

export class RuleChoiceError extends Error {
  constructor(message: string, readonly params: readonly string[]) {
    super(message);
    this.name = "RuleChoiceError";
  }
}

/** Problems with the chosen `$` values; empty when the rule can be compiled. */
export function choiceIssues(rule: CheckedRule, values: ParamValues): { readonly param: string; readonly message: string }[] {
  const issues: { param: string; message: string }[] = [];
  for (const param of rule.params) {
    const value = values[param.name];
    const missing = value === undefined || (Array.isArray(value) && value.length === 0) || value === "";
    if (missing) { issues.push({ param: param.name, message: `Choose ${param.list ? "at least one" : /^[aeiou]/i.test(param.label) ? "an" : "a"} ${param.label}` }); continue; }
    const items = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) !== param.list) {
      issues.push({ param: param.name, message: param.list ? `Choose a list of ${param.label} values` : `Choose a single ${param.label}` });
      continue;
    }
    for (const item of items) {
      if (typeof item !== param.type) { issues.push({ param: param.name, message: `${JSON.stringify(item)} is not a ${param.type}` }); break; }
      if (param.options !== undefined && !param.options.some((option) => option.value === item)) {
        issues.push({ param: param.name, message: `${JSON.stringify(item)} is not an allowed ${param.label}` });
        break;
      }
    }
  }
  for (const name of Object.keys(values)) {
    if (!rule.params.some((param) => param.name === name)) issues.push({ param: name, message: `$${name} is not used by this rule` });
  }
  return issues;
}

const predicateOps: Readonly<Record<Exclude<ComparisonOp, "in">, Exclude<Predicate["op"], "true" | "false" | "exists" | "in" | "not" | "and" | "or">>> = {
  "=": "equal", "!=": "notEqual", "<": "lessThan", "<=": "lessThanOrEqual", ">": "greaterThan", ">=": "greaterThanOrEqual",
  contains: "contains", starts_with: "startsWith",
};

function all(operands: Predicate[]): Predicate {
  return operands.length === 1 ? operands[0]! : { op: "and", operands };
}

function eventTypePredicate(event: CatalogueEvent): Predicate | undefined {
  const type = { root: "event" as const, segments: ["providerEventType"] };
  const options: Predicate[] = [
    ...(event.types.exact === undefined || event.types.exact.length === 0 ? [] : [event.types.exact.length === 1
      ? { op: "equal" as const, path: type, value: event.types.exact[0]! }
      : { op: "in" as const, path: type, values: event.types.exact }]),
    ...(event.types.prefixes ?? []).filter((prefix) => prefix.length > 0).map((prefix): Predicate => ({ op: "startsWith", path: type, value: prefix })),
  ];
  if ((event.types.prefixes ?? []).includes("")) return undefined;
  if (options.length === 0) return undefined;
  return options.length === 1 ? options[0]! : { op: "or", operands: options };
}

function fieldOperand(field: CatalogueField, provider: CatalogueEvent["provider"], asText: boolean): { readonly path: { root: "event"; segments: readonly string[] } } | { readonly source: ReturnType<typeof textSource> } {
  if (!asText && field.read.from === "path") return { path: { root: "event", segments: field.read.segments } };
  return { source: textSource(field, provider) };
}

function conditionPredicate(entry: ResolvedCondition, provider: CatalogueEvent["provider"], values: ParamValues): Predicate {
  const { condition, field } = entry;
  const value = condition.value;
  if (value.type === "var") {
    return { op: predicateOps[condition.op as Exclude<ComparisonOp, "in">], ...fieldOperand(field, provider, true), variable: value.name } as Predicate;
  }
  const operand = fieldOperand(field, provider, false);
  const chosen: ParamValue = value.type === "param" ? values[value.name]!
    : value.type === "list" ? value.items.map((item) => (item as { value: string | number | boolean }).value)
      : value.value;
  if (condition.op === "in") return { op: "in", ...operand, values: [chosen].flat() as Scalar[] } as Predicate;
  return { op: predicateOps[condition.op], ...operand, value: chosen as Scalar } as Predicate;
}

function propositionName(index: number, event: CatalogueEvent): string {
  return `e${index}_${event.provider}_${event.name}`.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** Compiles a checked rule with its chosen `$` values into an assertion the runtime monitor executes. */
export function compileRule(
  rule: CheckedRule,
  values: ParamValues,
  identity: { readonly id: string; readonly version: number; readonly tenantId: string; readonly name: string },
): AssertionDefinition {
  const issues = choiceIssues(rule, values);
  if (issues.length > 0) throw new RuleChoiceError(issues.map((issue) => issue.message).join("; "), issues.map((issue) => issue.param));
  const propositions: PropositionDefinition[] = [];
  const bindings: BindingDefinition[] = [];
  const atomFor = new Map<Expr, string>();

  const translate = (expr: Expr): LtlFormula => {
    switch (expr.type) {
      case "event": {
        let name = atomFor.get(expr);
        if (name === undefined) {
          const resolved = rule.events.get(expr)!;
          name = propositionName(propositions.length + 1, resolved.event);
          const typeMatch = eventTypePredicate(resolved.event);
          propositions.push({
            name,
            predicate: all([
              { op: "equal", path: { root: "event", segments: ["provider"] }, value: resolved.event.provider },
              ...(typeMatch === undefined ? [] : [typeMatch]),
              ...resolved.conditions.map((entry) => conditionPredicate(entry, resolved.event.provider, values)),
            ]),
          });
          for (const bind of resolved.binds) bindings.push({ name: bind.name, extractors: [textSource(bind.field, resolved.event.provider)] });
          atomFor.set(expr, name);
        }
        return { kind: "atom", name };
      }
      case "constant": return { kind: expr.value ? "true" : "false" };
      case "not": return { kind: "not", operand: translate(expr.operand) };
      case "never": return { kind: "always", operand: { kind: "not", operand: translate(expr.operand) } };
      case "next": return { kind: "next", operand: translate(expr.operand) };
      case "always":
      case "eventually": {
        const operand = translate(expr.operand);
        if (expr.within === undefined) return { kind: expr.type, operand };
        return { kind: expr.type === "always" ? "alwaysWithin" : "eventuallyWithin", operand, withinMs: expr.within.ms };
      }
      case "and":
      case "or": return { kind: expr.type, operands: expr.operands.map(translate) };
      case "implies": {
        const left = translate(expr.left);
        let right = translate(expr.right);
        const binds = expr.left.type === "event" ? rule.events.get(expr.left)?.binds ?? [] : [];
        for (const bind of [...binds].reverse()) right = { kind: "bind", variable: bind.name, operand: right };
        return { kind: "implies", left, right };
      }
      case "until": {
        const left = translate(expr.left);
        const right = translate(expr.right);
        return expr.within === undefined ? { kind: "until", left, right } : { kind: "untilWithin", left, right, withinMs: expr.within.ms };
      }
      case "unless": return { kind: "weakUntil", left: translate(expr.left), right: translate(expr.right) };
      case "bind": {
        const info = rule.prefixBinds.get(expr)!;
        bindings.push({ name: info.name, extractors: [textSource(info.field, info.provider)] });
        return { kind: "bind", variable: expr.name, operand: translate(expr.body) };
      }
    }
  };

  const formula = translate(rule.ast);
  return {
    id: identity.id,
    version: identity.version,
    tenantId: identity.tenantId,
    name: identity.name,
    formula,
    scope: { keys: [rule.partition === undefined
      ? { name: "rule", extractors: [{ from: "literal", value: "all" }] }
      : { name: rule.partition.variable, extractors: rule.partition.extractors }] },
    ...(bindings.length === 0 ? {} : { bindings }),
    propositions: propositions.length === 0 ? [{ name: "never_used", predicate: { op: "false" } }] : propositions,
  };
}

export function paramByName(rule: CheckedRule, name: string): ParamInfo | undefined {
  return rule.params.find((param) => param.name === name);
}
