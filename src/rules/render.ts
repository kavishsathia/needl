import type { CatalogueField } from "./catalogue.js";
import type { CheckedRule, ParamInfo } from "./check.js";
import type { ParamValue, ParamValues } from "./compile.js";
import { parts, type Condition, type Expr, type Part, type Value } from "./syntax.js";

/**
 * A rule read back as English. Values and time limits are always their own segments, so a reading can never show a
 * value the rule does not use; `choice` segments are the user's `$` bindings and render as pickers.
 */
export type ReadingSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value"; readonly text: string }
  | { readonly kind: "choice"; readonly param: string; readonly label: string; readonly text?: string }
  | { readonly kind: "duration"; readonly text: string }
  | { readonly kind: "bound"; readonly name: string; readonly text: string };

export type ReadingMode = "notes" | "mechanical";

const unitNames: readonly [string, number][] = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000], ["second", 1_000], ["millisecond", 1]];

export function durationText(ms: number): string {
  const pieces: string[] = [];
  let rest = ms;
  for (const [unit, size] of unitNames) {
    const count = Math.floor(rest / size);
    if (count > 0) pieces.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    rest %= size;
  }
  return pieces.join(" ") || "0 seconds";
}

export function humanize(name: string): string {
  return name.replaceAll("_", " ");
}

function listText(items: readonly string[], conjunction: "and" | "or"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

function optionLabel(field: CatalogueField | undefined, value: string | number | boolean): string {
  if (field?.values.kind === "fixed") {
    const option = field.values.options.find((candidate) => candidate.value === value);
    if (option !== undefined) return option.label;
  }
  return String(value);
}

export function choiceText(param: ParamInfo, value: ParamValue | undefined): string | undefined {
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return undefined;
  const label = (item: string | number | boolean): string => {
    const option = param.options?.find((candidate) => candidate.value === item);
    return option?.label ?? String(item);
  };
  return Array.isArray(value) ? listText(value.map(label), "or") : label(value as string | number | boolean);
}

const opWords: Readonly<Record<Condition["op"], string>> = {
  "=": "is", "!=": "is not", "<": "is less than", "<=": "is at most", ">": "is more than", ">=": "is at least",
  contains: "contains", starts_with: "starts with", in: "is",
};

export function readRule(rule: CheckedRule, values: ParamValues, mode: ReadingMode = "notes"): ReadingSegment[] {
  const text = (value: string): ReadingSegment => ({ kind: "text", text: value });

  const valueSegments = (value: Value, field: CatalogueField | undefined): ReadingSegment[] => {
    switch (value.type) {
      case "string":
      case "number":
      case "boolean": return [{ kind: "value", text: optionLabel(field, value.value) }];
      case "list": return [{ kind: "value", text: listText(value.items.map((item) => "value" in item ? optionLabel(field, item.value) : ""), "or") }];
      case "var": return [{ kind: "bound", name: value.name, text: `that ${humanize(value.name)}` }];
      case "param": {
        const param = rule.params.find((candidate) => candidate.name === value.name)!;
        const chosen = choiceText(param, values[value.name]);
        return [{ kind: "choice", param: value.name, label: param.label, ...(chosen === undefined ? {} : { text: chosen }) }];
      }
    }
  };

  const fieldOf = (expr: Extract<Expr, { type: "event" }>, condition: Condition): CatalogueField | undefined =>
    rule.events.get(expr)?.conditions.find((entry) => entry.condition === condition)?.field;

  const eventSegments = (expr: Extract<Expr, { type: "event" }>): ReadingSegment[] => {
    const resolved = rule.events.get(expr);
    const output: ReadingSegment[] = [text(resolved?.event.phrase ?? `${expr.provider}.${expr.event}`)];
    expr.conditions.forEach((condition, index) => {
      const field = fieldOf(expr, condition);
      output.push(text(`${index === 0 ? " where " : " and "}${field?.label ?? condition.field} ${opWords[condition.op]} ${condition.op === "in" ? "one of " : ""}`));
      output.push(...valueSegments(condition.value, field));
    });
    for (const bind of resolved?.binds ?? []) {
      output.push(text(`, whose ${bind.field.label} is called `), { kind: "bound", name: bind.name, text: `“${humanize(bind.name)}”` });
    }
    return output;
  };

  const partSegments = (part: Part): ReadingSegment[] => {
    switch (part.kind) {
      case "expr": return read(part.expr);
      case "value": {
        const host = findHost(rule.ast, part.condition);
        return valueSegments(part.value, host === undefined ? undefined : fieldOf(host, part.condition));
      }
      case "duration": return [{ kind: "duration", text: durationText(part.duration.ms) }];
      case "bindField": {
        const field = [...rule.events.values()].flatMap((resolved) => resolved.binds).find((bind) => bind.name === part.bind.name)?.field;
        return [text(`its ${field?.label ?? part.bind.field} as `), { kind: "bound", name: part.bind.name, text: `“${humanize(part.bind.name)}”` }];
      }
      case "bindSource": {
        const info = rule.prefixBinds.get(part.expr);
        return [text(info === undefined ? part.expr.path : `the ${info.field.label} of ${info.event.phrase}`)];
      }
    }
  };

  const noted = (expr: Expr): ReadingSegment[] => {
    const exprParts = parts(expr);
    const output: ReadingSegment[] = [];
    let last = 0;
    for (const match of expr.note!.text.matchAll(/\{(\d+)\}/g)) {
      if (match.index! > last) output.push(text(expr.note!.text.slice(last, match.index)));
      output.push(...partSegments(exprParts[Number(match[1]) - 1]!));
      last = match.index! + match[0].length;
    }
    if (last < expr.note!.text.length) output.push(text(expr.note!.text.slice(last)));
    return output;
  };

  const read = (expr: Expr): ReadingSegment[] => {
    if (mode === "notes" && expr.note !== undefined) return noted(expr);
    switch (expr.type) {
      case "event": return eventSegments(expr);
      case "constant": return [text(expr.value ? "anything" : "nothing")];
      case "not": return expr.operand.type === "event" ? [text("not "), ...read(expr.operand)] : [text("it is not the case that "), ...read(expr.operand)];
      case "never": return eventLike(expr.operand, mode)
        ? [text("there must never be "), ...read(expr.operand)]
        : [text("it must never be that "), ...read(expr.operand)];
      case "next": return expr.operand.type === "event"
        ? [text("the very next event must be "), ...read(expr.operand)]
        : [text("at the next event, "), ...read(expr.operand)];
      case "always": {
        if (expr.within !== undefined) return [text("for "), { kind: "duration", text: durationText(expr.within.ms) }, text(", at every event, "), ...read(expr.operand)];
        if (expr.operand.type === "implies") {
          // A noted "once …, …" or "whenever …, …" already says it applies every time.
          if (mode === "notes" && expr.operand.note !== undefined) return read(expr.operand);
          return [text("whenever there is "), ...read(expr.operand.left), text(", "), ...read(expr.operand.right)];
        }
        return [text("at all times, "), ...read(expr.operand)];
      }
      case "eventually": {
        const subject = expr.operand.type === "event" ? [text("there must be "), ...read(expr.operand)] : read(expr.operand);
        return expr.within === undefined
          ? [text("eventually "), ...subject]
          : [text("within "), { kind: "duration", text: durationText(expr.within.ms) }, text(", "), ...subject];
      }
      case "and":
      case "or": return expr.operands.flatMap((operand, index) => [
        ...(index === 0 ? [] : [text(index === expr.operands.length - 1 ? `, ${expr.type} ` : ", ")]),
        ...read(operand),
      ]);
      case "implies": return [text("if there is "), ...read(expr.left), text(", then "), ...read(expr.right)];
      case "until":
        return expr.within === undefined
          ? [...read(expr.left), text(" until there is "), ...read(expr.right)]
          : [...read(expr.left), text(" until there is "), ...read(expr.right), text(", which must happen within "), { kind: "duration", text: durationText(expr.within.ms) }];
      case "unless": return [...read(expr.left), text(", until there is "), ...read(expr.right), text(" (which never has to happen)")];
      case "bind": {
        const info = rule.prefixBinds.get(expr);
        return [
          text(`taking the ${info?.field.label ?? "value"} of ${info?.event.phrase ?? expr.path} as `),
          { kind: "bound", name: expr.name, text: `“${humanize(expr.name)}”` },
          text(", "),
          ...read(expr.body),
        ];
      }
    }
  };

  return sentence(read(rule.ast));
}

/** Events, or alternatives between events, read as a noun phrase ("there must never be …"). */
function eventLike(expr: Expr, mode: ReadingMode): boolean {
  if (mode === "notes" && expr.note !== undefined) return false;
  return expr.type === "event" || (expr.type === "or" && expr.operands.every((operand) => eventLike(operand, mode)));
}

function findHost(expr: Expr, condition: Condition): Extract<Expr, { type: "event" }> | undefined {
  if (expr.type === "event" && expr.conditions.includes(condition)) return expr;
  for (const part of parts(expr)) {
    if (part.kind !== "expr") continue;
    const found = findHost(part.expr, condition);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Capitalizes the first letter, merges adjacent text and ends with a full stop. */
function sentence(segments: readonly ReadingSegment[]): ReadingSegment[] {
  const merged: ReadingSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (segment.kind === "text" && previous?.kind === "text") merged[merged.length - 1] = { kind: "text", text: previous.text + segment.text };
    else if (segment.kind !== "text" || segment.text.length > 0) merged.push(segment);
  }
  const first = merged[0];
  if (first?.kind === "text") merged[0] = { kind: "text", text: first.text.charAt(0).toUpperCase() + first.text.slice(1) };
  const last = merged.at(-1);
  if (last?.kind === "text") {
    if (!/[.!?]$/.test(last.text.trimEnd())) merged[merged.length - 1] = { kind: "text", text: `${last.text.trimEnd()}.` };
  } else merged.push({ kind: "text", text: "." });
  return merged;
}

/** Plain-text reading, e.g. for names and summaries. */
export function readingText(segments: readonly ReadingSegment[]): string {
  return segments.map((segment) => segment.kind === "choice" ? segment.text ?? `[${segment.label}]` : segment.text).join("");
}
