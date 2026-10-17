# Needl rule language

Rules are how people (and the authoring agent) tell Needl what must never go wrong across their tools. A rule names each integration's **own** events — `gitlab.deployment`, `sentry.issue`, `stripe.invoice.paid` — rather than a canonical cross-provider shape, and connects them through values captured from one event and the passage of time.

The same code parses, checks and reads rules in the browser and on the server (`src/rules`). The web app stores a rule's source and its chosen values; the monitor that runs is compiled from them and checked to match on every save.

A rule has three parts: one English sentence, the inputs a person sets, and the rule itself.

```text
rule "Once a branch for an issue is successfully deployed to {environment}, no error or error alert tagged with that issue may appear in {environment} again"

input environment: text = "production"

always (
  gitlab.deployment(status = "success", environment = $environment) bind issue = ref.issue_key
  -> never (
    sentry.event_alert(tags.linear_issue.issue_key = issue, environment = $environment)
    or sentry.error(tags.linear_issue.issue_key = issue, environment = $environment)
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
| `rule "… {name} …"` | The sentence: the whole rule in English, first. Each `{name}` shows an input's current value. Optional; without it the rule is read word for word. |
| `input name: type = default` | An input the user sets (a picker), used in the rule as `$name`. Types: `text`, `number`, `boolean`, `duration`, `list of text`, `list of number`. The default is optional. |

Every rule starts with `always` or `never`, because a rule is checked from the first event Needl receives.

## The catalogue

[`src/rules/catalogue.ts`](../src/rules/catalogue.ts) lists, per integration, the events its adapter accepts and the fields it reliably extracts in projection mode, with types, how each is read from the normalized event, and where its possible values come from:

- **fixed**: closed sets the provider documents (GitLab deployment status, Sentry issue actions, Stripe subscription status). Literals outside the set are rejected.
- **observed**: open sets (environments, projects, releases). Suggestions come from events the workspace has received.
- **identifier**: ids meant to be bound from another event. Some declare a literal shape (Linear UUIDs, Stripe `cus_…`) so invented values such as `"done"` are rejected.

A test checks that every relationship and payload key the catalogue reads is one its adapter writes. Fields an adapter does not keep cannot be used.

## Checking

`checkRule` parses the source and reports every problem with its line and column:

- unknown integrations, events and fields, with the valid names and a "did you mean";
- type mismatches, comparisons a field type does not support, and values outside a fixed set or literal shape;
- bound names used outside the part where they are bound, rebinding, and `bind` after an event anywhere but the left of `->`;
- `$name` without an `input` declaration (the error names the declaration its use needs), inputs declared twice or never used, and a declared type that does not fit a place the input is used (`duration` for `within`, `list of …` for `in`, otherwise the field's type);
- defaults of the wrong type or outside a provider-fixed set;
- rules that do not start with `always` or `never`;
- anything that is not a safety property (below);
- a sentence that misses an input, shows a `{name}` that is not an input, or contains numbers, `provider.event` names, or an input's current or default value — so the values a reading shows are always the ones the rule uses. Sentence problems are marked so a caller can drop the sentence and fall back to the word-for-word reading.

### Safety only

After pushing negations inwards, a rule may use events, `and`, `or`, `next`, `always`, `never`, `unless`, `bind` and the time-bounded operators. Unbounded `eventually`, `until` without a time limit, `not always`, `not never` and `not … unless …` are rejected with the reason. Every LTL-expressible safety property can be written in this fragment, so nothing that can be caught breaking is lost. The engine applies the same check to compiled formulas (`findLiveness` in `src/ltl/safety.ts`), which is the product policy for every stored assertion.

## Compiling and monitoring

`compileRule` turns a checked rule and its chosen values into an engine assertion: one proposition per event pattern (provider, event type and conditions), `bind` operators and binding extractors, and the formula. Time-bounded operators compile to the engine's timed kinds (`eventuallyWithin`, `alwaysWithin`, `untilWithin`), which open a window with an absolute end when first evaluated.

A rule of the form `always (event bind x = … -> …)` in which every other event compares a field with `x` is monitored separately per value of `x` (each issue, each customer), so one violation never ends monitoring for the others. Events in which the value cannot be found are not about any entity and are skipped. Other rules run as one shared monitor.

Time limits are also enforced without new events: the server delivers a clock tick to each live monitor whose window has closed (`NEEDL_TICK_INTERVAL_MS`, default 5 s), at one millisecond past the window's end and only after a grace period (`NEEDL_TICK_GRACE_MS`, default 5 s) so webhooks that occurred inside the window but arrive slightly late are processed first.

## Reading rules back

`readRule` produces the English shown in the app as segments: text, literal values, durations, bound names and inputs (rendered as pickers). In **sentence** mode it is the rule's sentence with each `{name}` filled by that input's value. **Mechanical** mode reads the rule itself word for word; the app offers it as "Show exact reading". The checker guarantees the sentence shows every input and the values the rule really uses, but not that its wording matches the logic, so the exact reading is the reference.

## Inputs

Each input's type is declared; its options and label come from the fields it is compared with. A default fills the value until someone changes it (`effectiveValues`). `POST /api/rules/suggestions` returns, per input, the provider-fixed values plus the values seen in the workspace's own signed-webhook events, with counts per place the input is used. A rule cannot be saved until every input without a default is set.

## Rules saved before inputs

Rules used to carry `#"…"` notes on each part and undeclared `$` choices. `upgradeRuleSource` (in `src/rules/upgrade.ts`) drops the notes and adds the declaration each `$name`'s use implies, leaving the logic, and so the compiled monitor, unchanged. Saved assertions are upgraded when they load; a built-in example gets its own sentence, and other rules are read word for word until they are edited.

## Authoring agent

`translateToRule` (in `apps/web/backend/translator.ts`) gives the model the language guide, the catalogue (marking connected integrations), and the three worked examples, and asks for a structured answer: rule source (sentence, inputs with defaults, rule), a name and an explanation, or a reason it cannot be written. The answer goes through `checkRule`; errors, with line and column, are sent back for repair, up to three model calls, as is a missing sentence. If only sentence problems remain on the last attempt, the sentence is dropped and the rule is read word for word. Only a rule that passes the checker is ever returned, and it is created paused for the person to review.
