# Needl LTL engine implementation assignment

User request: ask Codex to set up the LTL engine in Needl alongside the existing modular webhook integrations. Implement working code, not a scaffold. Read prd.md, BRIEF.md, repository instructions if any, and existing code first. The earlier BRIEF's integrations-only constraint described the previous task; this assignment explicitly authorizes the monitor layer. No frontend or deployment. Frequent focused commits using existing Git identity (kavishsathia); do not override it. Do not push; parent will verify and push.

## Deliverable
A modular TypeScript runtime-verification engine that a future backend can import. Consume existing normalized integration events and produce durable counterexample records. Keep integration exports/backward compatibility intact. No paid APIs, secrets, live provider registration, or external mutations. Natural-language-to-LTL LLM authoring is a future layer; provide typed JSON AST suitable for that layer and a practical human-readable parser/formatter if feasible.

## Semantic requirements
- Define precise trace semantics in documentation before implementation. Runtime monitoring of finite prefixes is not the same as claiming infinite-trace LTL has been satisfied.
- Support a meaningful explicit LTL subset with atoms, boolean operators, next, always, eventually, until, plus deadline-based obligations as a clearly documented timed extension (not silently called ordinary LTL). Reject unsupported or ill-typed formulas explicitly. Use standard progression or a comparably justified algorithm; research primary documentation as needed. Correctness over breadth.
- Distinguish satisfied/violated/inconclusive on prefixes; explain complete-trace finalization separately if exposed. Open-ended eventualities must not time out or be marked violated merely because no next event has arrived.
- Explicit configurable proposition extraction from typed normalized events. No eval of user JS/code. Validate schemas and ensure predicate semantics for missing properties are documented.
- Partition monitor instances by tenant, assertion version and correlated entity/environment keys. Define behavior for unbound/missing relationships. No false cross-entity satisfaction or temporal joins based just on timestamp coincidence.
- Define observation model explicitly: event propositions versus persisted state, and how updates affect predicates. Demo cross-provider rules must preserve necessary prior state rather than treating flag disabled or ticket Done as a one-tick pulse. Document monitor initialization and state snapshots; unknown initial state must not be invented.
- Handle idempotent delivery, deterministic ordering, explicit clocks/timer ticks for deadline expiry, out-of-order arrivals, and rule-version changes. Choose a bounded documented policy rather than pretending to solve distributed ordering universally.
- Counterexamples contain assertion/version/scope, source event references, predicate valuation/evaluation explanation and relevant trace. Distinguish sufficient violation witness from mathematically minimal counterexample; do not claim minimality unless implemented/tested.
- Trace storage/resource behavior must be explicit. A truncation/limit must not silently erase evidence or change verdicts. Offer a durable store seam, persisted checkpoints/replay, and a SQLite-backed or compatible runnable example using the existing store where suitable.
- Violation records should be usable by a later GitLab agent-flow dispatcher. Define a deterministic trigger/outbox seam and deduplication semantics, but do not pretend to implement live agent flows or promise exactly-once external execution.

## Concrete demonstrations
1. Linked issue fix deployed, then matching Sentry issue recurs in the same environment: violation with source evidence. Other issues/environments must not violate it. Include Linear Done if reliable explicit correlation supplied by test scenario.
2. LaunchDarkly feature disabled, then explicitly attributed Sentry error occurs while disabled: violation. Re-enable must alter applicable state correctly; unrelated feature errors must not match.
3. Stripe payment + explicit provisioning failure → Intercom ticket for same customer/order within a deadline. Ticket before deadline discharges the obligation; expiry produces evidence; unrelated ticket does not. Missing provisioning signal is not inferred from Stripe alone. Business events/correlation can be supplied through an explicit generic input/predicate layer.
4. Simple textbook LTL examples including pending eventualities, until, next, negation and prefix/finalization distinctions.

## Verification
Follow TDD: demonstrate failing tests before implementations. Add differential/exhaustive short-trace checks against an independently simple reference evaluator for the supported semantics where possible, not tests that merely reproduce implementation logic. Cover boolean/LTL operators, nested formulas, end-of-trace/empty trace, repeated events, partition isolation, replay/checkpoint restart, deadline boundaries, stale/out-of-order events, rule updates, missing relationships, wrong entities, malformed AST and injection attempts. Preserve all existing integration tests.

Run full check/typecheck/test/build/package import smoke. Supply a reproducible demo command producing real counterexamples from clearly labeled synthetic cross-provider observations. No fabricated live-provider results. Update README, semantics docs, examples and package exports. Write LTL-HANDOFF.md with commands/results, architecture, operator support and honest limits. Commit incrementally; final working tree clean. Work autonomously until implemented and verified.
