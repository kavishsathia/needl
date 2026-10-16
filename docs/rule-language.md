# Needl rule language

Rules are how people (and the authoring agent) tell Needl what must never go wrong across their tools. A rule names each integration's **own** events — `gitlab.deployment`, `sentry.issue`, `stripe.invoice.paid` — rather than a canonical cross-provider shape, and connects them through values captured from one event and the passage of time.

The same code parses, checks and reads rules in the browser and on the server (`src/rules`). The web app stores a rule's source and its chosen values; the monitor that runs is compiled from them and checked to match on every save.

```text
always (
  #"once {1}, {2}"
  (
    #"a branch for an issue gets a {1} deploy to {2}, keeping {3}"
    gitlab.deployment(status = "success", environment = $environment) bind issue = ref.issue_key
    ->
    #"{1} must never appear there again"
    never (
      #"an error alert tagged {1} in {2}"
      sentry.event_alert(tags.linear_issue.issue_key = issue, environment = $environment)
      or #"an error tagged {1} in {2}"
      sentry.error(tags.linear_issue.issue_key = issue, environment = $environment)
    )
  )
)
```

The complete grammar and semantics, as given to the authoring agent, are in [`src/rules/describe.ts`](../src/rules/describe.ts) (`ruleLanguageGuide`). In short:

| Part | Meaning |
| --- | --- |
| `provider.event(field op value, …)` | One observation of that event whose fields satisfy every condition. Ops: `= != < <= > >= contains starts_with in`. |
| `and`, `or`, `not`, `A -> B` | Logic at the current event. |
| `always A`, `never A`, `next A` | Every event from here on; no event from here on; the very next event. |
| `A unless B` | A at every event until B happens; B never has to happen (weak until). |
| `eventually within 30m A`, `A until within 2h B`, `always within 1h A` | Time-bounded operators; the window opens where the part is first evaluated. |
| `event bind x = field -> …` | Captures `field` from that event for the right side of `->`. `bind x = provider.event.field in …` is the general form. |
| `$name` | A choice the user makes (a dropdown); its type and suggested values come from the fields it is compared with. |
| `#"… {1} …"` | A note: the English reading of the next part, with `{n}` slots for that part's own parts. |

Every rule starts with `always` or `never`, because a rule is checked from the first event Needl receives.

## The catalogue

[`src/rules/catalogue.ts`](../src/rules/catalogue.ts) lists, per integration, the events its adapter accepts and the fields it reliably extracts in projection mode, with types, how each is read from the normalized event, and where its possible values come from:

- **fixed**: closed sets the provider documents (GitLab deployment status, Sentry issue actions, Stripe subscription status). Literals outside the set are rejected.
- **observed**: open sets (environments, projects, releases). Suggestions come from events the workspace has received.
- **identifier**: ids meant to be bound from another event. Some declare a literal shape (Linear UUIDs, Stripe `cus_…`) so invented values such as `"done"` are rejected.

A test checks that every relationship and payload key the catalogue reads is one its adapter writes. Fields an adapter does not keep cannot be used; notably, Linear webhooks carry only the workflow state's UUID in Needl's projection, not its name.

## Checking

`checkRule` parses the source and reports every problem with its line and column:

- unknown integrations, events and fields, with the valid names and a "did you mean";
- type mismatches, comparisons a field type does not support, and values outside a fixed set or literal shape;
- bound names used outside the part where they are bound, rebinding, and `bind` after an event anywhere but the left of `->`;
- `$` choices compared with fields of different types, or used both with `in` and as a single value;
- rules that do not start with `always` or `never`;
- anything that is not a safety property (below);
- notes that skip or repeat a slot, or that contain numbers, `provider.event` names, literal values from their part, or a value chosen for a `$` binding — so a reading can never show a value the rule does not use.

### Safety only

After pushing negations inwards, a rule may use events, `and`, `or`, `next`, `always`, `never`, `unless`, `bind` and the time-bounded operators. Unbounded `eventually`, `until` without a time limit, `not always`, `not never` and `not … unless …` are rejected with the reason. Every LTL-expressible safety property can be written in this fragment, so nothing that can be caught breaking is lost. The engine applies the same check to compiled formulas (`findLiveness` in `src/ltl/safety.ts`), which is the product policy for every stored assertion.

## Compiling and monitoring

`compileRule` turns a checked rule and its chosen values into an engine assertion: one proposition per event pattern (provider, event type and conditions), `bind` operators and binding extractors, and the formula. Time-bounded operators compile to the engine's timed kinds (`eventuallyWithin`, `alwaysWithin`, `untilWithin`), which open a window with an absolute end when first evaluated.

A rule of the form `always (event bind x = … -> …)` in which every other event compares a field with `x` is monitored separately per value of `x` (each issue, each customer), so one violation never ends monitoring for the others. Events in which the value cannot be found are not about any entity and are skipped. Other rules run as one shared monitor.

Time limits are also enforced without new events: the server delivers a clock tick to each live monitor whose window has closed (`NEEDL_TICK_INTERVAL_MS`, default 5 s), at one millisecond past the window's end and only after a grace period (`NEEDL_TICK_GRACE_MS`, default 5 s) so webhooks that occurred inside the window but arrive slightly late are processed first.

## Reading rules back

`readRule` produces the English shown in the app as segments: text, literal values, durations, bound names and `$` choices (rendered as dropdowns). In **notes** mode a noted part uses its note with each slot filled by that part's own reading; parts without notes are read mechanically. **Mechanical** mode ignores notes and reads the rule word for word; the app offers it as "Show exact reading", since a structurally valid note can still be worded misleadingly.

## Choices

Each `$` binding's type, options and label come from the fields it is compared with. `POST /api/rules/suggestions` returns, per choice, the provider-fixed values plus the values seen in the workspace's own signed-webhook events, with counts per place the choice is used. A rule cannot be saved until every choice is made.

## Authoring agent

`translateToRule` (in `apps/web/backend/translator.ts`) gives the model the language guide, the catalogue (marking connected integrations), and the three worked examples, and asks for a structured answer: rule source, initial choices, a name and an explanation, or a reason it cannot be written. The answer goes through `checkRule`; errors, with line and column, are sent back for repair, up to three model calls. Problems confined to notes are fixed by dropping the note and reading that part mechanically. Only a rule that passes the checker is ever returned, and it is created paused for the person to review.
