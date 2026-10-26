import type { Provider } from "../core/types.js";
import { advanceFormulaTime, nextDeadline, progressFormula } from "../ltl/formula.js";
import type { LtlFormula } from "../ltl/types.js";
import type { CheckedRule } from "./check.js";
import { compileRuleWithAtoms, type ParamValues } from "./compile.js";
import { durationText, readEventPattern, type ReadingSegment } from "./render.js";

/** An event arriving, in an example that breaks a rule. */
export interface BreakEvent {
  readonly kind: "event";
  readonly provider: Provider;
  readonly segments: readonly ReadingSegment[];
}

/** One step of an example: an event arrives, any one of several events arrives, or a time limit runs out. */
export type BreakStep =
  | BreakEvent
  | { readonly kind: "anyOf"; readonly events: readonly BreakEvent[] }
  | { readonly kind: "time"; readonly text: string };

export interface BreakExample {
  readonly steps: readonly BreakStep[];
}

interface Path {
  readonly formula: LtlFormula;
  readonly now: number;
  /** Atom names, or "time" for a time limit running out. */
  readonly letters: readonly string[];
  readonly steps: readonly (BreakEvent | { readonly kind: "time"; readonly text: string })[];
}

const start = Date.parse("2026-01-01T00:00:00.000Z");

/**
 * The shortest ways a rule can break, found by trying short sequences of the rule's own event patterns (and its
 * time limits running out) against the compiled formula. Every event in an example is about the same entity, so a
 * rule that joins tools on a key ("the same flag", "the same customer") is shown breaking for one of them.
 */
export function breakingExamples(rule: CheckedRule, chosen: ParamValues, options: { readonly maxSteps?: number; readonly limit?: number } = {}): BreakExample[] {
  const maxSteps = options.maxSteps ?? 4;
  const limit = options.limit ?? 6;
  const { definition, atoms } = compileRuleWithAtoms(rule, chosen, { id: "example", version: 1, tenantId: "example", name: "example" });
  // Rules compile to plain LTL; the engine's separate deadline form never comes from a rule.
  if (definition.formula.kind === "deadline") return [];
  const letters = [...atoms].map(([name, expr]) => ({
    name,
    step: { kind: "event", provider: expr.provider as Provider, segments: readEventPattern(rule, chosen, expr) } satisfies BreakEvent,
  }));
  const key = (formula: LtlFormula): string => JSON.stringify(formula);

  const broken: Path[] = [];
  const seen = new Set<string>([key(definition.formula)]);
  let frontier: Path[] = [{ formula: definition.formula, now: start, letters: [], steps: [] }];
  for (let depth = 0; depth < maxSteps && broken.length < limit && frontier.length > 0; depth += 1) {
    const next: Path[] = [];
    for (const path of frontier) {
      const successors: Path[] = letters.map((letter) => {
        const now = path.now + 60_000;
        const formula = progressFormula(path.formula, { atom: (name) => name === letter.name, bind: () => "same", at: new Date(now).toISOString() });
        return { formula, now, letters: [...path.letters, letter.name], steps: [...path.steps, letter.step] };
      });
      const deadline = nextDeadline(path.formula);
      if (deadline !== undefined) {
        const now = Date.parse(deadline) + 1;
        successors.push({
          formula: advanceFormulaTime(path.formula, new Date(now).toISOString()),
          now,
          letters: [...path.letters, "time"],
          steps: [...path.steps, { kind: "time", text: `The time limit runs out (${durationText(now - 1 - path.now)} later)` }],
        });
      }
      for (const successor of successors) {
        if (successor.formula.kind === "false") {
          broken.push(successor);
          continue;
        }
        // A step that leaves the rule where it was, or somewhere already reached, adds nothing to an example.
        const id = key(successor.formula);
        if (successor.formula.kind === "true" || seen.has(id)) continue;
        seen.add(id);
        next.push(successor);
      }
    }
    frontier = next;
  }
  return group(withoutPadding(broken)).slice(0, limit);
}

/** Drops examples that are a shorter example with an extra step added. */
function withoutPadding(paths: readonly Path[]): Path[] {
  const kept: Path[] = [];
  const known = new Set<string>();
  for (const path of paths) {
    const padded = path.letters.some((_, index) => known.has(path.letters.filter((__, other) => other !== index).join(" ")));
    known.add(path.letters.join(" "));
    if (!padded) kept.push(path);
  }
  return kept;
}

/** Merges examples that differ only in their last event into one example ending in "any one of". */
function group(paths: readonly Path[]): BreakExample[] {
  const groups = new Map<string, Path[]>();
  for (const path of paths) {
    const last = path.steps.at(-1);
    const prefix = last?.kind === "event" ? path.letters.slice(0, -1).join(" ") : `${path.letters.join(" ")} #`;
    groups.set(prefix, [...groups.get(prefix) ?? [], path]);
  }
  return [...groups.values()].map((members) => {
    const first = members[0]!;
    if (members.length === 1) return { steps: first.steps };
    const events = members.map((member) => member.steps.at(-1) as BreakEvent);
    return { steps: [...first.steps.slice(0, -1), { kind: "anyOf", events }] };
  });
}
