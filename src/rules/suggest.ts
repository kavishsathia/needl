import { extractValue } from "../ltl/assertion.js";
import type { NormalizedEvent } from "../core/types.js";
import type { CatalogueEvent, CatalogueField, FieldOption } from "./catalogue.js";
import type { CheckedRule, ParamInfo } from "./check.js";
import { durationText } from "./render.js";

/** Common time limits offered for `within $choice`; any other duration can be typed. */
const durationSuggestions = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;

export interface SuggestedValue {
  readonly value: string | number | boolean;
  readonly label: string;
  /** Matching events per place the choice is used, in the order of `ParamInfo.usages`. */
  readonly counts: readonly number[];
  readonly lastSeen?: string;
  /** True when every place the choice is used has seen this value, so picking it can actually match. */
  readonly seenEverywhere: boolean;
  /** Allowed by the provider even if not seen yet. */
  readonly fixed: boolean;
}

export interface ParamSuggestions {
  readonly param: ParamInfo;
  /** Free text is allowed unless the provider fixes the values. */
  readonly freeText: boolean;
  readonly values: readonly SuggestedValue[];
}

export function eventMatches(event: CatalogueEvent, observed: NormalizedEvent): boolean {
  if (observed.provider !== event.provider) return false;
  if (event.types.exact?.includes(observed.providerEventType)) return true;
  return (event.types.prefixes ?? []).some((prefix) => observed.providerEventType.startsWith(prefix));
}

export function readField(field: CatalogueField, observed: NormalizedEvent): string | number | boolean | undefined {
  if (field.read.from === "source") return extractValue(field.read.source, observed);
  let value: unknown = observed;
  for (const segment of field.read.segments) {
    if (typeof value !== "object" || value === null || !Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

/**
 * Suggested values for each `$` binding, from the provider's fixed values and from events this workspace has received.
 * Values seen everywhere the choice is used come first: a value only one side has seen would make the rule watch nothing.
 */
export function suggestChoices(rule: CheckedRule, events: readonly NormalizedEvent[]): ParamSuggestions[] {
  return rule.params.map((param) => {
    if (param.type === "duration") {
      return {
        param,
        freeText: true,
        values: durationSuggestions.map((value) => ({ value, label: durationText(Number.parseInt(value, 10) * (value.endsWith("m") ? 60_000 : value.endsWith("h") ? 3_600_000 : 86_400_000)), counts: [], seenEverywhere: true, fixed: false })),
      };
    }
    const byValue = new Map<string, { value: string | number | boolean; counts: number[]; lastSeen?: string }>();
    const entry = (value: string | number | boolean) => {
      const key = JSON.stringify(value);
      let found = byValue.get(key);
      if (found === undefined) {
        found = { value, counts: param.usages.map(() => 0) };
        byValue.set(key, found);
      }
      return found;
    };
    for (const option of param.options ?? []) entry(option.value);
    param.usages.forEach((usage, index) => {
      for (const observed of events) {
        if (!eventMatches(usage.event, observed)) continue;
        const value = readField(usage.field, observed);
        if (value === undefined || typeof value !== param.type) continue;
        if (param.options !== undefined && !param.options.some((option) => option.value === value)) continue;
        const found = entry(value);
        found.counts[index]! += 1;
        const at = observed.occurredAt ?? observed.receivedAt;
        if (found.lastSeen === undefined || at > found.lastSeen) found.lastSeen = at;
      }
    });
    const labelFor = (value: string | number | boolean): string =>
      (param.options ?? []).find((option: FieldOption) => option.value === value)?.label ?? String(value);
    const values = [...byValue.values()].map((found): SuggestedValue => ({
      value: found.value,
      label: labelFor(found.value),
      counts: found.counts,
      ...(found.lastSeen === undefined ? {} : { lastSeen: found.lastSeen }),
      seenEverywhere: found.counts.every((count) => count > 0),
      fixed: param.options?.some((option) => option.value === found.value) ?? false,
    }));
    values.sort((left, right) =>
      Number(right.seenEverywhere) - Number(left.seenEverywhere)
      || Math.min(...right.counts) - Math.min(...left.counts)
      || right.counts.reduce((sum, count) => sum + count, 0) - left.counts.reduce((sum, count) => sum + count, 0)
      || String(left.value).localeCompare(String(right.value)));
    return { param, freeText: param.options === undefined, values };
  });
}
