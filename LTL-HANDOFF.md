# Needl LTL runtime handoff

## Delivered

Needl now includes a working, importable TypeScript runtime-verification engine
alongside the existing webhook integrations. No provider, remote repository,
deployment, or external agent service was contacted or mutated.

The implementation includes:

- a strict JSON LTL AST plus a human-readable parser and formatter;
- formula validation with declared-atom checking, exact fields, depth/node
  limits, safe atom names, and explicit rejection of unsupported operators;
- standard formula progression for live finite prefixes;
- a separately implemented recursive complete finite-trace evaluator;
- declarative, non-executable event/state predicates with explicit missing-path
  behavior;
- configurable state updates evaluated before each observation's propositions;
- partitions keyed by tenant, assertion ID/version, and required correlation
  fields;
- zero-lateness event ordering, scoped input deduplication, explicit timer
  ticks, complete-trace finalization, and rule-version isolation;
- durable counterexamples with source references, predicate explanations,
  state/valuation trace, trace range, and an honest non-minimality marker;
- deterministic violation/outbox IDs and a dispatcher-attempt persistence seam;
- optimistic transactional `MonitorStore` semantics, an in-memory store, and a
  SQLite implementation;
- restart-safe checkpoints and deterministic rebuilding from the existing
  durable normalized event log;
- reusable cross-provider assertion presets and a runnable synthetic demo; and
- package exports from the root, `@needl/integrations/ltl`,
  `@needl/integrations/ltl/sqlite`, and the combined SQLite entrypoint.

The normative semantics are in [docs/ltl-semantics.md](docs/ltl-semantics.md).
Usage and package entrypoints are in [README.md](README.md).

## Architecture

The existing authenticated adapters still produce `NormalizedEvent` values.
The new monitor path is:

```text
NormalizedEvent
  -> explicit scope extractors
  -> tenant/assertion/version/entity monitor instance
  -> configured state updates
  -> closed predicate evaluation
  -> LTL progression or deadline-obligation transition
  -> atomic input dedupe + trace + checkpoint + violation + outbox commit
```

Key implementation files:

- `src/ltl/types.ts` — ordinary LTL and timed-extension AST types.
- `src/ltl/formula.ts` — validation, parser/formatter, progression, and complete
  finite-trace evaluation.
- `src/ltl/assertion.ts` — assertion schema, paths, predicates, scope binding,
  proposition extraction, and state updates.
- `src/ltl/runtime.ts` — partitioned observation/tick/finalization state machine.
- `src/ltl/runtime-types.ts` — checkpoint, trace, violation, outbox, and store
  contracts.
- `src/ltl/memory-store.ts` and `src/ltl/sqlite.ts` — transactional store
  implementations.
- `src/ltl/presets.ts` — the three concrete cross-provider rules.
- `examples/ltl-demo.ts` — SQLite-backed synthetic counterexample demo.

SQLite commits the processed input, appended trace item, optimistic checkpoint,
new counterexamples, and outbox items inside one `BEGIN IMMEDIATE` transaction.
A duplicate input cannot advance a formula or create a second outbox item.
Revision conflicts cause the runtime to reload and retry. The outbox seam
records failed/successful dispatcher attempts but deliberately invokes no
external service.

## Operator and verdict support

Ordinary LTL supports Boolean constants, atoms, negation, conjunction,
disjunction, implication, strong next (`X`), always (`G`), eventually (`F`),
and strong until (`U`). The parser accepts those operators with parentheses and
safe identifiers; callers can instead supply the typed JSON AST.

Live prefix results are:

- `violated` when progression reaches `false`, providing a sufficient bad
  prefix;
- `satisfied` when progression reaches `true`, providing a prefix no future
  continuation can undo; and
- `inconclusive` otherwise.

Thus an unbounded `F p` stays inconclusive without `p`, and a non-failing `G p`
does not become permanently satisfied merely because input stopped. Explicit
`finalize()` uses strong finite-trace semantics, including false pending `F`,
`U`, and end-of-trace `X` obligations. Finalization closes that exact partition.

`deadline` is a separately identified Needl timed extension equivalent in
intent to `G(trigger -> F[0,d] response)`. Its trigger/response must be
propositional, its integral duration is limited to 365 days, and each trigger
opens a durable obligation. A response event at the due timestamp succeeds; an
explicit tick at the same timestamp closes and expires it. Later observations
expire overdue obligations before evaluating their response.

## Observation and correlation contract

Every scope key must bind through an ordered explicit extractor from the event
subject, a typed relationship, an event field, or a configured literal. Missing
keys produce `missing_scope`; timestamp proximity never correlates entities.
The full key includes tenant and assertion version, so neither tenants nor rule
updates share state accidentally.

Paths traverse own properties only and reject `__proto__`, `prototype`, and
`constructor`. Missing values make `exists` and all comparisons—including
`notEqual`—false. Boolean negation remains explicit. Predicates accept only JSON
scalars and fixed operators; they cannot execute code.

State starts empty. Updates occur only from configured matching observations
and run before proposition evaluation. Silence creates no state. This preserves
LaunchDarkly disabled/enabled status and Linear Done state across later provider
events without treating them as one-tick pulses or inventing unknown initial
values.

The logical clock is `occurredAt`, falling back to `receivedAt`. Timestamps are
normalized to ISO form. An older event is returned as `out_of_order` with no
state change. Equal timestamps use durable arrival order. This intentional
zero-lateness policy requires upstream buffering when a deployment needs a
different distributed-order policy.

## Demonstrated scenarios

`npm run demo:ltl` uses in-memory SQLite and clearly labeled synthetic
observations. It persists and prints three counterexamples plus their pending
outbox requests:

1. Linear Done, then an explicitly linked GitLab deployment, then the matching
   Sentry recurrence in the same environment.
2. LaunchDarkly disabled state followed by a Sentry error explicitly attributed
   to that feature/environment.
3. Stripe payment plus an explicit PostHog provisioning failure, followed by
   deadline expiry without the matching Intercom ticket.

Tests also prove that wrong issues/environments/features/orders remain isolated,
re-enable changes feature state, a ticket before the inclusive deadline
discharges the obligation, unrelated tickets do not, and Stripe payment without
an explicit provisioning-failure signal creates no obligation.

These are synthetic runtime observations, not fabricated claims of live
provider results. Some demo relationships (especially order and cross-provider
issue/feature attribution) require an upstream explicit mapping. Provider
adapters do not infer those links.

## Evidence and resource behavior

Checkpoints retain a configurable recent trace cache (default 100, maximum
10,000) for convenient inspection. Formula residuals, projected state, and
deadline obligations are separate, so cache truncation cannot change a verdict.
Both durable stores maintain the complete append-only monitor trace; SQLite
violations snapshot the full trace available at detection and record its range.
Source references retain provider/type/kind, subject, explicit relationships,
evidence links, body digest, and occurrence/receipt times.

The included stores do not silently prune traces, violations, or outbox items.
That preserves evidence but means storage grows with processed observations and
counterexample snapshots can become large. A production backend needs an
explicit archival/retention policy that preserves referenced evidence. Formula
progression is simplified but residual size can also grow for complex nested
formulas; the initial AST is bounded, while long-running formula/resource
quotas remain a backend operational responsibility.

## Verification

Local verification used Node `v22.23.1` and npm `10.9.8`.

```text
npm run check          PASS
  typecheck            PASS
  tests                PASS — 10 files, 47 tests
  build                PASS
  package smoke        PASS — receiver + root LTL + LTL SQLite imports

npm run demo:ltl       PASS — 3 counterexamples, 3 pending outbox items
npm audit              PASS — 0 vulnerabilities
npm pack --dry-run     PASS — LTL JS/types and semantics documentation included
```

The formula suite exhaustively enumerates all two-proposition traces of lengths
0 through 3 for representative nested formulas and compares the implementation
to an independently recursive evaluator. Other suites cover malformed and
injection-shaped inputs, all operators, pending eventualities, until/next/end
semantics, missing paths, state transitions, duplicate inputs, tenant/entity
partitions, rule versions, stale input, deadline boundaries, finalization,
restart recovery, normalized-event replay, full trace preservation, outbox
attempts, package imports, and the three required provider scenarios. All
pre-existing integration tests remain green.

## Honest limits and next backend work

- This is runtime verification of observations, not formal verification of the
  service or proof that quiet/unobserved sources are healthy.
- No past-time operators, release/weak-until, quantifiers, arbitrary metric
  temporal nesting, or natural-language translation are implemented.
- The timed extension is top-level and its trigger/response are propositional.
  One response discharges all currently open obligations in the exact same
  partition; rules needing one-to-one response identity should add another
  scope key.
- The runtime intentionally rejects event-time regression instead of buffering
  and reordering. Upstream ingestion must enforce any nonzero lateness window.
- Assertion versions start empty. State/checkpoint migration must be explicit in
  a future backend.
- `finalize()` is irreversible for the partition and relies on the caller's
  assertion that the finite trace is complete.
- The local SQLite store is a runnable single-node implementation. Production
  horizontal processing needs an equivalent shared transactional store and
  operational retention/backup policy.
- Node 22 reports `node:sqlite` as experimental; SQLite remains isolated behind
  optional package entrypoints.
- Outbox IDs and requests are deduplicated, but external agent execution can
  still be retried. Exactly-once GitLab flow execution is neither claimed nor
  implemented.
- There is no frontend, LLM authoring layer, live GitLab dispatcher, provider
  hydration client, deployment, credential-dependent test, or live webhook
  registration in this work.

