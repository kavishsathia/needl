# Safety-only product policy

This policy applies to the Needl product layer in `apps/web`. It does not narrow the reusable LTL engine exported from `src/ltl`: the library continues to parse, validate, progress, finalize, and test general LTL plus the explicit deadline extension.

## Accepted product formulas

The product validator compiles the complete assertion first, including declared atoms, closed predicates, state updates, scope extractors, and resource bounds. It then accepts only these recognized structured shapes:

```text
G φ
G (φ -> G ψ)
G (φ -> bind(x) … G ψ)
```

`φ` and `ψ` must be propositional formulas made from declared atoms, constants, negation, conjunction, disjunction, and implication. The first shape is a global invariant: a finite observation can break it immediately. The second is the reviewed “after this trigger, never again” shape. The third is the same shape with one or more `bind` operators between the trigger and the `G`: each trigger freezes values (an issue key, a customer) that `ψ` compares against, so “never again” applies to that value only. Binds are transparent to safety: they do not add eventualities.

This is deliberately a limited, sound subset. The validator does not claim to decide whether every possible LTL formula is a safety property. Formulas containing `F` (eventually), `U` (until), `X` (next), a top-level formula without `G`, unrecognized temporal nesting, or the timed `deadline` extension are rejected at product authoring, advanced editing, enablement, and replay API boundaries.

The normal interface does not expose formulas. A collapsed **Advanced specification** section is available for expert inspection and editing, but it passes through the same compiler and product-policy validator.

## Authoring and migration

The composer is an honestly labeled template-assisted seam; no natural-language model is connected. Eventuality/deadline wording receives friendly unsupported feedback and a user-confirmed safety alternative. Needl never silently rewrites the supplied intent.

An older saved rule outside the supported subset is retained with its original wording, definition, version, and any additional user-owned record fields. It migrates to `needs-review`, remains disabled, and is excluded from replay requests. It is not silently deleted or coerced into a different meaning. The local replay API independently rejects unsupported formulas even when a caller marks them paused or `needs-review`.

## Editable meaning

Reviewed templates store a template ID and selected meaning values alongside the canonical assertion definition. Collection validation deterministically rebuilds the expected formula, predicates, state updates, and scope from those selections and rejects a mismatch. A chip therefore cannot be cosmetic.

Options identify whether the deterministic fixture has matching evidence. For example, changing the No ghosts environment from production to staging creates a new assertion version, changes the event predicates and scope, then produces **No matching evidence** instead of a quiet “safe” result.

The reviewed templates read only fields the provider adapters actually emit:

| Template | Formula | Binds | Reads |
| --- | --- | --- | --- |
| No ghosts | `G (shipped -> bind(issue) G !haunted)` | issue key from the GitLab deployment `ref` (`issue-key` pattern) | GitLab `deployment.success` + environment; Sentry events tagged `linear_issue` + environment tag |
| Boomerang | `G (resolved -> bind(issue) G !returned)` | Sentry issue id | Sentry `issue.resolved` / `issue.unresolved` |
| Clean break | `G (canceled -> bind(customer) G !charged)` | Stripe `customer` | `customer.subscription.deleted`; `invoice.paid`, `charge.succeeded`, `payment_intent.succeeded` |

Each template also partitions by the same entity, so one violation does not end monitoring for every other issue or customer.
