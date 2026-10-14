# Needl LTL runtime semantics

This document is the contract for Needl's runtime monitor. It deliberately
separates finite-prefix runtime verification from claims about a complete,
infinite execution.

## Formula language

The ordinary LTL subset is represented by a typed JSON AST and by the
equivalent text syntax below.

| AST kind | Text | Meaning |
| --- | --- | --- |
| `true`, `false` | `true`, `false` | Boolean constants |
| `atom` | `payment_failed` | Configured proposition |
| `not` | `! p` | Negation |
| `and`, `or` | `p & q`, `p \| q` | Boolean conjunction/disjunction |
| `implies` | `p -> q` | Boolean implication |
| `next` | `X p` | `p` at the next observation |
| `always` | `G p` | `p` now and at every future observation |
| `eventually` | `F p` | `p` now or at a future observation |
| `until` | `p U q` | `q` eventually, with `p` holding before it |

The text parser accepts identifiers matching
`[A-Za-z_][A-Za-z0-9_.-]*`, parentheses, and the operators above. It does not
evaluate JavaScript or accept calls, property access, interpolation, or other
code. AST validation rejects unknown fields, unknown operators, invalid atom
names, excessive nesting, and formulas that reference undeclared atoms.

`deadline` is a **Needl timed obligation extension**, not ordinary LTL. It
means: every observation satisfying a propositional trigger must be followed
by a matching propositional response in the same monitor partition no later
than `withinMs`. Temporal operators are rejected inside its trigger and
response. Each trigger creates its own durable obligation. Durations must be
positive integral milliseconds and cannot exceed 365 days.

## Prefix verdicts and finalization

For ordinary LTL, the monitor progresses a residual formula after every
valuation. A residual simplified to `false` is `violated`: the observed prefix
is a sufficient bad prefix and no infinite continuation can repair it. A
residual simplified to `true` is `satisfied`: no infinite continuation can
undo it. Every other residual is `inconclusive`.

Consequently, `F p` stays inconclusive forever until `p` is observed. A quiet
source or the passage of wall-clock time never violates an unbounded
eventuality. Likewise, `G p` remains inconclusive on every non-violating live
prefix; Needl does not call a running service permanently safe.

Complete-trace finalization is an explicit, separate operation using strong
finite-trace semantics: an outstanding `F` or `U` is false, `G` is true if it
has not failed, and `X p` is false when there is no next observation. An empty
complete trace makes atoms false. Finalization says only what the caller's
declared-complete finite trace means; it is not a proof about later events.

Deadline obligations are inconclusive while open. An event response at exactly
its due time is accepted. A later event first expires the obligation, and an
explicit timer tick at the due time expires it. This distinction lets callers
order same-time event ingestion before a closing tick. Finalizing a deadline
partition violates every still-open obligation because the caller has declared
the trace complete.

## Observations, propositions, and state

The runtime consumes existing `NormalizedEvent` values. An assertion declares:

1. scope-key extractors;
2. named proposition predicates; and
3. optional state-update rules.

Predicates are a closed JSON data language over normalized event fields and a
persisted per-partition state object. Supported comparisons are equality,
membership, existence, ordered numeric/string comparison, and Boolean
composition. Paths are arrays of own-property segments. Missing paths are not
coerced: `exists` is false, and every value comparison (including `notEqual`)
is false. Negating such a predicate is explicit. Values are JSON scalars; no
functions, regular expressions, or executable strings are accepted.

State updates run before propositions are evaluated for an observation. A rule
can set or delete configured state keys using a literal or an event value. This
is how a LaunchDarkly disable remains true across later Sentry observations and
how a re-enable changes it. State begins empty. Unknown initial state is never
invented, provider silence does not update state, and replay applies the same
rules in the same order.

Atoms are evaluated on every observation. Event predicates should therefore
include an event-kind/provider guard when they denote a pulse. State predicates
remain true until an explicit update changes them.

## Partitioning and correlation

A monitor instance key is the tuple:

```text
(tenantId, assertionId, assertionVersion, environment, configured entity keys...)
```

Each scope key supplies ordered, explicit extractors from the subject,
relationships, or normalized event fields. Every required key must bind.
Unbound events are reported as ignored and cannot create or join a partition.
Needl never correlates events merely because timestamps are close. Assertions
that need provider-specific identifiers must receive explicit relationships or
configured mappings upstream.

New assertion versions start new partitions with empty state and formula
history. No checkpoint is silently migrated across versions.

## Time, delivery order, and deduplication

An observation's logical time is `occurredAt`, falling back to `receivedAt`.
Within a partition, logical time must be monotonic. An event older than the
partition clock is returned as `out_of_order` without changing state. Equal
timestamps are processed in durable arrival order. Needl intentionally uses a
zero-lateness policy: it does not pretend to reconstruct a distributed total
order. Callers that need a lateness window must reorder upstream before passing
events to the monitor.

Normalized event IDs and explicit tick IDs are deduplicated per full monitor
instance. Applying an input, appending its trace item, updating its checkpoint,
and writing any violation/outbox record is one optimistic transaction. Store
implementations reject stale checkpoint revisions so concurrent processors can
reload and retry deterministically.

## Evidence, storage, and dispatch

A violation contains the assertion/version/scope, deterministic violation ID,
cause, source event references, atom valuations with explanations, and the
relevant persisted trace. It is a sufficient violation witness, not a claim of
mathematical minimality.

Checkpoints keep a bounded recent-trace cache for inspection, but progression,
state, and obligations are stored separately and are never truncated. Durable
stores append the complete monitor trace independently of that cache. A
violation snapshots the available trace and also records its durable trace
range, so cache truncation neither changes a verdict nor erases source
evidence. The included SQLite implementation does not automatically delete
trace or violations; production retention/archival is a backend policy.

Every new violation atomically creates a deterministic pending outbox item.
Dispatchers can claim and record attempts through the store seam. This provides
deduplicated requests to a future GitLab agent-flow dispatcher, not exactly-once
external execution. The monitor itself performs no network action.
