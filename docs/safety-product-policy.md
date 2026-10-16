# Safety-only product policy

This policy applies to the Needl product layer in `apps/web`. The reusable LTL engine in `src/ltl` still parses, progresses and finalizes general LTL; the product only runs **safety properties**: rules that a single observed event, or a time limit passing, can break.

## Accepted formulas

Every stored assertion is compiled and checked with the engine's syntactic safety check (`findLiveness` in `src/ltl/safety.ts`). After pushing negations to the atoms, a formula may use atoms, `and`, `or`, `next`, `always`, weak until, `bind`, and the time-bounded operators (`eventuallyWithin`, `alwaysWithin`, `untilWithin`, and the top-level `deadline` extension). It may not use unbounded `eventually` or strong `until`, or their duals under negation (`not always`, `not … weak until …`). Every LTL-expressible safety property can be written in this fragment, so the policy loses nothing that can be caught breaking; it rejects exactly what could never be caught.

Rules are written in the [Needl rule language](rule-language.md), whose checker applies the same policy at the source level and points at the offending operator.

## Authoring

People describe what must never go wrong; the authoring agent writes a rule, the checker verifies it (errors go back to the model for repair), and the result is shown read back in English with its choices as dropdowns, created **paused** for review. Without OpenAI, people start from a worked example or write the rule themselves with live checking. A rule's stored monitor must equal what its source compiles to with its chosen values; a mismatch is rejected, so the reading can never drift from what runs.

## Migration

Assertions saved by the earlier template-based flow are rewritten as rules from the matching worked example with a new version, keeping their wording, status and environment choice. An older saved rule outside the safety fragment is retained with its wording and definition, migrates to `needs-review`, stays disabled, and is excluded from replay. It is never silently deleted or coerced into a different meaning.
