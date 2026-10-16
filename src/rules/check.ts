import type { ValueSource } from "../ltl/assertion.js";
import { providers, type Provider } from "../core/types.js";
import {
  catalogue,
  catalogueEvents,
  fieldNames,
  resolveField,
  type CatalogueEvent,
  type CatalogueField,
  type FieldOption,
  type FieldType,
} from "./catalogue.js";
import { parseRule, parts, RuleSyntaxError, subExpressions, type ComparisonOp, type Condition, type Expr, type Span, type Value } from "./syntax.js";

export interface RuleIssue {
  readonly message: string;
  readonly span: Span;
  /** Problems confined to a note (`#"…"`); dropping that note leaves a valid rule read mechanically. */
  readonly kind?: "note";
}

export type EventExpr = Extract<Expr, { type: "event" }>;
export type BindExpr = Extract<Expr, { type: "bind" }>;

export interface ResolvedCondition {
  readonly condition: Condition;
  readonly field: CatalogueField;
}

export interface ResolvedEvent {
  readonly expr: EventExpr;
  readonly event: CatalogueEvent;
  readonly conditions: readonly ResolvedCondition[];
  readonly binds: readonly { readonly name: string; readonly field: CatalogueField }[];
}

export interface BindingInfo {
  readonly name: string;
  readonly provider: Provider;
  readonly event: CatalogueEvent;
  readonly field: CatalogueField;
  readonly span: Span;
}

export interface ParamUsage {
  readonly event: CatalogueEvent;
  readonly field: CatalogueField;
  readonly op: ComparisonOp;
  readonly span: Span;
}

/** An external binding (`$name`): chosen when the rule is set up; its type and options come from where it is used. */
export interface ParamInfo {
  readonly name: string;
  readonly type: FieldType;
  /** Used with `in`, so it takes several values. */
  readonly list: boolean;
  /** Noun for the picker, from the first field it is compared with. */
  readonly label: string;
  readonly usages: readonly ParamUsage[];
  /** Present when every usage is a provider-fixed field: only these values are allowed. */
  readonly options?: readonly FieldOption[];
}

/** Monitoring is split per value of `variable` when the rule is about one entity at a time. */
export interface Partition {
  readonly variable: string;
  readonly extractors: readonly ValueSource[];
}

export interface CheckedRule {
  readonly source: string;
  readonly ast: Expr;
  readonly events: ReadonlyMap<EventExpr, ResolvedEvent>;
  readonly prefixBinds: ReadonlyMap<BindExpr, BindingInfo>;
  readonly bindings: ReadonlyMap<string, BindingInfo>;
  readonly params: readonly ParamInfo[];
  readonly partition?: Partition;
}

export type CheckResult =
  | { readonly ok: true; readonly rule: CheckedRule; readonly warnings: readonly RuleIssue[] }
  | { readonly ok: false; readonly errors: readonly RuleIssue[] };

export interface CheckOptions {
  /** Values chosen for `$` bindings; notes may not spell them out. */
  readonly paramValues?: Readonly<Record<string, unknown>>;
}

const opsByType: Readonly<Record<FieldType, readonly ComparisonOp[]>> = {
  string: ["=", "!=", "contains", "starts_with", "in"],
  number: ["=", "!=", "<", "<=", ">", ">=", "in"],
  boolean: ["=", "!="],
};
const maximumWindowMs = 365 * 86_400_000;

function distance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0]!;
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column]!;
      previous[column] = Math.min(above + 1, previous[column - 1]! + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

function didYouMean(input: string, candidates: readonly string[]): string {
  const best = candidates
    .map((candidate) => ({ candidate, score: distance(input.toLowerCase(), candidate.toLowerCase()) }))
    .sort((left, right) => left.score - right.score)[0];
  return best !== undefined && best.score <= Math.max(2, Math.floor(input.length / 3)) ? ` Did you mean ${best.candidate}?` : "";
}

/** A field read as text, for bindings, partitions and comparisons with bound values. */
export function textSource(field: CatalogueField, provider: Provider): ValueSource {
  const source: ValueSource = field.read.from === "path" ? { from: "event", path: field.read.segments } : field.read.source;
  return { ...source, provider };
}

function literalText(value: Value): string[] {
  if (value.type === "string") return [value.value];
  if (value.type === "number") return [String(value.value)];
  if (value.type === "list") return value.items.flatMap(literalText);
  return [];
}

export function checkRule(source: string, options: CheckOptions = {}): CheckResult {
  let ast: Expr;
  try {
    ast = parseRule(source);
  } catch (error) {
    if (error instanceof RuleSyntaxError) return { ok: false, errors: [{ message: error.message.replace(/ \(line \d+, column \d+\)$/, ""), span: error.span }] };
    throw error;
  }
  const errors: RuleIssue[] = [];
  const warnings: RuleIssue[] = [];
  const events = new Map<EventExpr, ResolvedEvent>();
  const prefixBinds = new Map<BindExpr, BindingInfo>();
  const bindings = new Map<string, BindingInfo>();
  const usedBindings = new Set<string>();
  const paramUsages = new Map<string, { usage: ParamUsage; list: boolean }[]>();
  let hasNext = false;
  const fail = (message: string, span: Span): void => { errors.push({ message, span }); };

  const resolveEvent = (provider: string, name: string, span: Span): CatalogueEvent | undefined => {
    if (!providers.includes(provider as Provider)) {
      fail(`Unknown integration "${provider}". Integrations: ${providers.join(", ")}.${didYouMean(provider, providers)}`, span);
      return undefined;
    }
    const event = catalogueEvents.get(`${provider}.${name}`);
    if (event === undefined) {
      const names = catalogue.find((entry) => entry.provider === provider)!.events.map((candidate) => candidate.name);
      fail(`${provider} has no event "${name}". Its events are: ${names.join(", ")}.${didYouMean(name, names)}`, span);
    }
    return event;
  };

  const resolveEventField = (event: CatalogueEvent, name: string, span: Span): CatalogueField | undefined => {
    const field = resolveField(event, name);
    if (field === undefined) {
      const names = fieldNames(event);
      fail(`${event.provider}.${event.name} has no field "${name}". Its fields are: ${names.join(", ")}.${didYouMean(name, names)}`, span);
    }
    return field;
  };

  const checkLiteral = (value: Value, field: CatalogueField, eventName: string): void => {
    if (value.type === "list") { value.items.forEach((item) => checkLiteral(item, field, eventName)); return; }
    if (value.type === "param" || value.type === "var") {
      fail("Lists may contain only literal values; to let the user choose several values write `in $name`", value.span);
      return;
    }
    if (value.type !== field.type) {
      fail(`${eventName}.${field.name} is a ${field.type}, but ${JSON.stringify(value.value)} is a ${value.type}`, value.span);
      return;
    }
    if (field.values.kind === "fixed" && !field.values.options.some((option) => option.value === value.value)) {
      fail(`${JSON.stringify(value.value)} is not a value of ${eventName}.${field.name}. Allowed: ${field.values.options.map((option) => JSON.stringify(option.value)).join(", ")}`, value.span);
    }
    if (field.literal !== undefined && typeof value.value === "string" && !field.literal.pattern.test(value.value)) {
      fail(`${JSON.stringify(value.value)} is not a valid ${eventName}.${field.name}: it holds ${field.literal.description}`, value.span);
    }
  };

  const checkCondition = (condition: Condition, event: CatalogueEvent, scope: ReadonlyMap<string, BindingInfo>): ResolvedCondition | undefined => {
    const field = resolveEventField(event, condition.field, condition.fieldSpan);
    if (field === undefined) return undefined;
    const eventName = `${event.provider}.${event.name}`;
    if (!opsByType[field.type].includes(condition.op)) {
      fail(`${eventName}.${field.name} is a ${field.type}; use ${opsByType[field.type].join(", ")}`, condition.span);
      return undefined;
    }
    const value = condition.value;
    if (condition.op === "in") {
      if (value.type === "param") {
        paramUsages.set(value.name, [...paramUsages.get(value.name) ?? [], { usage: { event, field, op: condition.op, span: value.span }, list: true }]);
      } else if (value.type === "list") {
        if (value.items.length === 0) fail("A list needs at least one value", value.span);
        checkLiteral(value, field, eventName);
      } else fail("`in` takes a list such as [\"a\", \"b\"] or a $choice", value.span);
      return { condition, field };
    }
    if (value.type === "list") { fail(`A list needs \`in\`, not \`${condition.op}\``, value.span); return undefined; }
    if (value.type === "param") {
      paramUsages.set(value.name, [...paramUsages.get(value.name) ?? [], { usage: { event, field, op: condition.op, span: value.span }, list: false }]);
      return { condition, field };
    }
    if (value.type === "var") {
      const binding = scope.get(value.name);
      if (binding === undefined) {
        const reason = bindings.has(value.name) ? "is not bound at this point; it is only available inside the part where it is bound" : "is not bound";
        fail(`"${value.name}" ${reason}. Bind it first (event bind ${value.name} = field -> …), use a $choice, or quote it as a "string".`, value.span);
        return undefined;
      }
      usedBindings.add(value.name);
      if (!["=", "!=", "contains", "starts_with"].includes(condition.op)) fail(`Bound values compare as text; use =, !=, contains or starts_with`, condition.span);
      if (field.type !== "string" && binding.field.type !== field.type) fail(`${value.name} comes from a ${binding.field.type} field but ${eventName}.${field.name} is a ${field.type}`, value.span);
      return { condition, field };
    }
    checkLiteral(value, field, eventName);
    return { condition, field };
  };

  const checkWithin = (within: { ms: number; span: Span } | undefined): void => {
    if (within !== undefined && within.ms > maximumWindowMs) fail("Time windows can be at most 365d", within.span);
  };

  const addBinding = (info: BindingInfo, scope: Map<string, BindingInfo>): void => {
    if (scope.has(info.name)) fail(`"${info.name}" is already bound here; choose another name`, info.span);
    else if (bindings.has(info.name)) fail(`"${info.name}" is bound twice in this rule; choose another name`, info.span);
    scope.set(info.name, info);
    bindings.set(info.name, info);
  };

  /** Returns the bindings an antecedent event introduces for the right side of `->`. */
  const visit = (expr: Expr, scope: ReadonlyMap<string, BindingInfo>, negated: boolean, antecedent: boolean): Map<string, BindingInfo> => {
    const introduced = new Map<string, BindingInfo>();
    const liveness = (message: string): void => fail(message, expr.span);
    switch (expr.type) {
      case "event": {
        const event = resolveEvent(expr.provider, expr.event, expr.refSpan);
        if (event === undefined) break;
        const conditions = expr.conditions.flatMap((condition) => checkCondition(condition, event, scope) ?? []);
        const binds: { name: string; field: CatalogueField }[] = [];
        if (expr.binds.length > 0 && !antecedent) {
          fail("`bind` after an event only works on the left of `->`. Elsewhere write `bind name = provider.event.field in …`.", expr.binds[0]!.span);
        }
        const local = new Map(scope);
        for (const bind of expr.binds) {
          const field = resolveEventField(event, bind.field, bind.span);
          if (field === undefined) continue;
          binds.push({ name: bind.name, field });
          const info: BindingInfo = { name: bind.name, provider: event.provider, event, field, span: bind.span };
          addBinding(info, local);
          introduced.set(bind.name, info);
        }
        events.set(expr, { expr, event, conditions, binds });
        break;
      }
      case "constant": break;
      case "not": visit(expr.operand, scope, !negated, false); break;
      case "never":
        if (negated) liveness("`not never …` means something must eventually happen, with no time limit, so it can never be caught breaking.");
        visit(expr.operand, scope, !negated, false);
        break;
      case "next": hasNext = true; visit(expr.operand, scope, negated, false); break;
      case "always":
        checkWithin(expr.within);
        if (expr.within === undefined && negated) liveness("`not always …` means something must eventually stop holding, with no time limit, so it can never be caught breaking.");
        visit(expr.operand, scope, negated, false);
        break;
      case "eventually":
        checkWithin(expr.within);
        if (expr.within === undefined && !negated) liveness("`eventually` has no time limit, so it can never be caught breaking. Give it one: `eventually within 30m …`.");
        visit(expr.operand, scope, negated, false);
        break;
      case "until":
        checkWithin(expr.within);
        if (expr.within === undefined && !negated) liveness("`until` also requires its right side to happen eventually, with no time limit. Use `unless` if it never has to happen, or `until within 30m`.");
        visit(expr.left, scope, negated, false);
        visit(expr.right, scope, negated, false);
        break;
      case "unless":
        if (expr.within !== undefined) fail("`unless` cannot take a time window; use `until within …` or `always within …`", expr.within.span);
        if (negated) liveness("`not … unless …` requires something to happen eventually, with no time limit, so it can never be caught breaking.");
        visit(expr.left, scope, negated, false);
        visit(expr.right, scope, negated, false);
        break;
      case "and":
      case "or": expr.operands.forEach((operand) => visit(operand, scope, negated, false)); break;
      case "implies": {
        const bound = visit(expr.left, scope, !negated, true);
        visit(expr.right, new Map([...scope, ...bound]), negated, false);
        break;
      }
      case "bind": {
        const local = new Map(scope);
        const info = resolveBindSource(expr);
        if (info !== undefined) {
          prefixBinds.set(expr, info);
          addBinding(info, local);
        }
        visit(expr.body, local, negated, false);
        break;
      }
    }
    return introduced;
  };

  const resolveBindSource = (expr: BindExpr): BindingInfo | undefined => {
    if (!providers.includes(expr.provider as Provider)) {
      fail(`Unknown integration "${expr.provider}". Integrations: ${providers.join(", ")}.${didYouMean(expr.provider, providers)}`, expr.sourceSpan);
      return undefined;
    }
    const segments = expr.path.split(".");
    for (let split = segments.length - 1; split >= 1; split -= 1) {
      const event = catalogueEvents.get(`${expr.provider}.${segments.slice(0, split).join(".")}`);
      if (event === undefined) continue;
      const field = resolveEventField(event, segments.slice(split).join("."), expr.sourceSpan);
      return field === undefined ? undefined : { name: expr.name, provider: event.provider, event, field, span: expr.sourceSpan };
    }
    fail(`"${expr.provider}.${expr.path}" is not provider.event.field; for example gitlab.deployment.ref.issue_key`, expr.sourceSpan);
    return undefined;
  };

  visit(ast, new Map(), false, false);
  if (ast.type !== "never" && !(ast.type === "always" && ast.within === undefined) && !(ast.type === "constant")) {
    fail("Start the rule with `always (…)` or `never …` so it applies at every event; without it, it only checks the first event Needl receives.", ast.span);
  }

  for (const name of bindings.keys()) {
    if (!usedBindings.has(name)) warnings.push({ message: `"${name}" is bound but never used`, span: bindings.get(name)!.span });
  }

  const params: ParamInfo[] = [];
  for (const [name, entries] of paramUsages) {
    const [first] = entries;
    const types = new Set(entries.map((entry) => entry.usage.field.type));
    if (types.size > 1) {
      fail(`$${name} is compared with fields of different types (${[...types].join(" and ")})`, first!.usage.span);
      continue;
    }
    const lists = new Set(entries.map((entry) => entry.list));
    if (lists.size > 1) {
      fail(`$${name} is used with \`in\` in one place and as a single value in another; use two choices`, first!.usage.span);
      continue;
    }
    const fixedSets = entries.map((entry) => entry.usage.field.values);
    let optionsList: FieldOption[] | undefined;
    if (fixedSets.every((values) => values.kind === "fixed")) {
      optionsList = (fixedSets[0] as Extract<typeof fixedSets[0], { kind: "fixed" }>).options
        .filter((option) => fixedSets.every((values) => values.kind === "fixed" && values.options.some((candidate) => candidate.value === option.value)));
      if (optionsList.length === 0) fail(`$${name} is compared with fields that share no allowed value`, first!.usage.span);
    }
    params.push({
      name,
      type: first!.usage.field.type,
      list: first!.list,
      label: first!.usage.field.label,
      usages: entries.map((entry) => entry.usage),
      ...(optionsList === undefined ? {} : { options: optionsList }),
    });
  }

  checkNotes(ast, events, options.paramValues ?? {}, (message, span) => errors.push({ message, span, kind: "note" }));
  if (errors.length > 0) return { ok: false, errors };
  const partition = hasNext ? undefined : findPartition(ast, events, prefixBinds);
  return {
    ok: true,
    rule: { source, ast, events, prefixBinds, bindings, params, ...(partition === undefined ? {} : { partition }) },
    warnings,
  };
}

const eventReference = new RegExp(`\\b(?:${providers.join("|")})\\.[A-Za-z_]`, "i");

function checkNotes(
  ast: Expr,
  events: ReadonlyMap<EventExpr, ResolvedEvent>,
  paramValues: Readonly<Record<string, unknown>>,
  fail: (message: string, span: Span) => void,
): void {
  const valuesIn = (expr: Expr): string[] => {
    const own = expr.type === "event"
      ? expr.conditions.flatMap((condition) => {
        const literal = literalText(condition.value);
        const resolved = events.get(expr)?.conditions.find((entry) => entry.condition === condition);
        const labels = resolved?.field.values.kind === "fixed"
          ? resolved.field.values.options.filter((option) => literal.includes(String(option.value)) || condition.value.type === "param").map((option) => option.label)
          : [];
        const chosen = condition.value.type === "param" ? [paramValues[condition.value.name]].flat().filter((value) => value !== undefined).map(String) : [];
        return [...literal, ...labels, ...chosen];
      })
      : [];
    return [...own, ...subExpressions(expr).flatMap(valuesIn)];
  };
  const visit = (expr: Expr): void => {
    if (expr.note !== undefined) {
      const { text, span } = expr.note;
      const count = parts(expr).length;
      const slots = [...text.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1]));
      const prose = text.replace(/\{\d+\}/g, " ");
      if (text.trim().length === 0 || text.length > 300) fail("A note must be 1 to 300 characters", span);
      for (let slot = 1; slot <= count; slot += 1) {
        const uses = slots.filter((candidate) => candidate === slot).length;
        if (uses !== 1) fail(`This note must use {${slot}} exactly once (it has ${count} part${count === 1 ? "" : "s"}: ${describeParts(expr)})`, span);
      }
      const extra = slots.filter((slot) => slot < 1 || slot > count);
      if (extra.length > 0) fail(`This note refers to {${extra[0]}}, but the part has only ${count} part${count === 1 ? "" : "s"}`, span);
      if (/[{}]/.test(prose)) fail("Write slots as {1}, {2} …; other braces are not allowed in notes", span);
      if (/\d/.test(prose)) fail("Notes cannot contain numbers; values and time limits must come from slots", span);
      if (eventReference.test(prose)) fail("Notes cannot name events like provider.event; describe them or use slots", span);
      for (const value of new Set(valuesIn(expr))) {
        if (value.length === 0) continue;
        const pattern = new RegExp(`(^|[^A-Za-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9])`, "i");
        if (pattern.test(prose)) fail(`Notes cannot spell out the value ${JSON.stringify(value)}; put it in a slot so the reading always shows the real value`, span);
      }
    }
    subExpressions(expr).forEach(visit);
  };
  visit(ast);
}

function describeParts(expr: Expr): string {
  return parts(expr).map((part, index) => {
    const label = part.kind === "expr" ? part.expr.type === "event" ? `${part.expr.provider}.${part.expr.event}` : `the ${part.expr.type} part`
      : part.kind === "value" ? `the value of ${part.condition.field}`
        : part.kind === "duration" ? `the time limit ${part.duration.text}`
          : part.kind === "bindField" ? `the field bound as ${part.bind.name}`
            : `the field bound as ${part.expr.name}`;
    return `{${index + 1}} ${label}`;
  }).join(", ");
}

/**
 * A rule about one entity at a time (`always (event bind x = … -> …)` where every event either is where `x` is bound or
 * compares a field with `x`) is monitored separately per value of `x`, so one violation never ends monitoring for the
 * other entities. Events in which the value cannot be found are not about any entity and are skipped.
 */
function findPartition(
  ast: Expr,
  events: ReadonlyMap<EventExpr, ResolvedEvent>,
  prefixBinds: ReadonlyMap<BindExpr, BindingInfo>,
): Partition | undefined {
  const top = ast;
  if (top.type !== "always" || top.within !== undefined) return undefined;
  let variable: string | undefined;
  let host: EventExpr | undefined;
  let hostEvent: CatalogueEvent | undefined;
  const extractors: ValueSource[] = [];
  const firstBind = (expr: Expr): void => {
    if (variable !== undefined) return;
    if (expr.type === "event" && expr.binds.length > 0) {
      const resolved = events.get(expr);
      const bind = resolved?.binds[0];
      if (resolved !== undefined && bind !== undefined) {
        variable = bind.name;
        host = expr;
        extractors.push(textSource(bind.field, resolved.event.provider));
      }
      return;
    }
    if (expr.type === "bind") {
      const info = prefixBinds.get(expr);
      if (info !== undefined) {
        variable = info.name;
        hostEvent = info.event;
        extractors.push(textSource(info.field, info.provider));
      }
      return;
    }
    subExpressions(expr).forEach(firstBind);
  };
  firstBind(top.operand);
  if (variable === undefined) return undefined;
  let everyEventKeyed = true;
  for (const resolved of events.values()) {
    if (resolved.expr === host || resolved.event === hostEvent) continue;
    const keyed = resolved.conditions.find((entry) => entry.condition.op === "=" && entry.condition.value.type === "var" && entry.condition.value.name === variable);
    if (keyed === undefined) { everyEventKeyed = false; break; }
    extractors.push(textSource(keyed.field, resolved.event.provider));
  }
  if (!everyEventKeyed) return undefined;
  const unique = [...new Map(extractors.map((source) => [JSON.stringify(source), source])).values()];
  return { variable, extractors: unique };
}
