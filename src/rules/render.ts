import type { CatalogueField } from "./catalogue.js";
import { sentenceSlot, type CheckedRule, type ParamInfo, type ParamValue, type ParamValues } from "./check.js";
import { effectiveValues } from "./compile.js";
import { parseDuration, type Condition, type Duration, type Expr, type Value } from "./syntax.js";

/**
 * A rule read back as English. Values and time limits are always their own segments, so a reading can never show a
 * value the rule does not use; `choice` segments are the rule's inputs and render as pickers.
 */
export type ReadingSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value"; readonly text: string }
  | { readonly kind: "choice"; readonly param: string; readonly label: string; readonly text?: string }
  | { readonly kind: "duration"; readonly text: string }
  | { readonly kind: "bound"; readonly name: string; readonly text: string };

/** `sentence` uses the rule's own sentence when it has one; `mechanical` reads the rule word for word. */
export type ReadingMode = "sentence" | "mechanical";

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
  if (param.type === "duration") {
    const ms = typeof value === "string" ? parseDuration(value) : undefined;
    return ms === undefined ? String(value) : durationText(ms);
  }
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

export function readRule(rule: CheckedRule, chosen: ParamValues, mode: ReadingMode = "sentence"): ReadingSegment[] {
  const values = effectiveValues(rule, chosen);
  const text = (value: string): ReadingSegment => ({ kind: "text", text: value });
  const choice = (param: ParamInfo): ReadingSegment => {
    const shown = choiceText(param, values[param.name]);
    return { kind: "choice", param: param.name, label: param.label, ...(shown === undefined ? {} : { text: shown }) };
  };

  if (mode === "sentence" && rule.sentence !== undefined) {
    const template = rule.sentence.text;
    const output: ReadingSegment[] = [];
    let last = 0;
    for (const match of template.matchAll(sentenceSlot)) {
      if (match.index > last) output.push(text(template.slice(last, match.index)));
      const param = rule.params.find((candidate) => candidate.name === match[1]);
      output.push(param === undefined ? text(match[0]) : choice(param));
      last = match.index + match[0].length;
    }
    if (last < template.length) output.push(text(template.slice(last)));
    return sentence(output);
  }

  const valueSegments = (value: Value, field: CatalogueField | undefined): ReadingSegment[] => {
    switch (value.type) {
      case "string":
      case "number":
      case "boolean": return [{ kind: "value", text: optionLabel(field, value.value) }];
      case "list": return [{ kind: "value", text: listText(value.items.map((item) => "value" in item ? optionLabel(field, item.value) : ""), "or") }];
      case "var": return [{ kind: "bound", name: value.name, text: `that ${humanize(value.name)}` }];
      case "param": return [choice(rule.params.find((candidate) => candidate.name === value.name)!)];
    }
  };

  const durationSegment = (within: Duration): ReadingSegment => {
    if (within.ms !== undefined) return { kind: "duration", text: durationText(within.ms) };
    return choice(rule.params.find((candidate) => candidate.name === within.param)!);
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

  const read = (expr: Expr): ReadingSegment[] => {
    switch (expr.type) {
      case "event": return eventSegments(expr);
      case "constant": return [text(expr.value ? "anything" : "nothing")];
      case "not": return expr.operand.type === "event" ? [text("not "), ...read(expr.operand)] : [text("it is not the case that "), ...read(expr.operand)];
      case "never": return eventLike(expr.operand)
        ? [text("there must never be "), ...read(expr.operand)]
        : [text("it must never be that "), ...read(expr.operand)];
      case "next": return expr.operand.type === "event"
        ? [text("the very next event must be "), ...read(expr.operand)]
        : [text("at the next event, "), ...read(expr.operand)];
      case "always": {
        if (expr.within !== undefined) return [text("for "), durationSegment(expr.within), text(", at every event, "), ...read(expr.operand)];
        if (expr.operand.type === "implies") {
          return [text("whenever there is "), ...read(expr.operand.left), text(", "), ...read(expr.operand.right)];
        }
        return [text("at all times, "), ...read(expr.operand)];
      }
      case "eventually": {
        const subject = expr.operand.type === "event" ? [text("there must be "), ...read(expr.operand)] : read(expr.operand);
        return expr.within === undefined
          ? [text("eventually "), ...subject]
          : [text("within "), durationSegment(expr.within), text(", "), ...subject];
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
          : [...read(expr.left), text(" until there is "), ...read(expr.right), text(", which must happen within "), durationSegment(expr.within)];
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
function eventLike(expr: Expr): boolean {
  return expr.type === "event" || (expr.type === "or" && expr.operands.every(eventLike));
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
