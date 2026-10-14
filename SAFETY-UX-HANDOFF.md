# Needl safety-only UX handoff

Status: implemented, browser-tested, and visually inspected on 2026-10-14. No deployment, push, provider connection, paid API call, or external mutation was performed.

## Outcome

The local Needl product is now safety-only and meaning-first while the reusable engine retains general LTL and deadline support.

- Cards and detail views lead with normal business sentences. Inline chips are keyboard-accessible selectors backed by canonical definition builders.
- A chip edit increments the assertion version and changes formula atoms, predicates, state/scope data, and discriminating replay output. Collection validation rebuilds the monitor from the selected meaning and rejects cosmetic mismatches.
- The reviewed product templates are fix recurrence, disabled-feature errors, and order fulfillment before observed payment.
- The order scenario begins at an explicit correlated `order.accepted` boundary. The violating fixture fulfills before payment is observed; the healthy fixture records payment first.
- Formula and JSON editing moved under a collapsed **Advanced specification** affordance. It passes through the same safety validator as authoring and enablement.
- Eventuality/deadline intent receives friendly unsupported feedback plus an explicit user-confirmed safety alternative. Needl does not silently rewrite the user's text.
- Product restore migrates older eventuality/deadline rules to disabled `needs-review` records while preserving their wording, complete definition, version, and additional user-owned record fields.
- Replay omits migrated records and the localhost API independently rejects eventuality/deadline formulas even when marked paused or `needs-review`.
- Expanded counterexamples lead with a concrete business explanation and show engine-backed source, UTC time, normalized event, correlations, predicate values, and synthetic source link.
- Selecting a rule phrase highlights the corresponding trace evidence; selecting an evidence role highlights its rule phrase. Both keyboard and mouse paths are tested.
- Quiet active rules say **Watching · No violations observed**. Unsupported fixture selections say **No matching evidence**. Neither is called safe or satisfied.
- Investigation state distinguishes an engine-created simulated request from a real started agent. No live connection or running agent is claimed.

The conservative policy and supported structured shapes are documented in [`docs/safety-product-policy.md`](docs/safety-product-policy.md). In short, the product recognizes only `G φ` and `G (φ -> G ψ)` where the inner formulas are propositional. The library continues to support and test `F`, `U`, `X`, finite-trace finalization, and deadline obligations.

## Prior repair verification

Before safety work began, the existing repair branch was verified without modifying its regression tests:

```text
npm run check:all
  engine tests             PASS — 10 files, 47 tests
  frontend tests           PASS — 3 files, 15 tests
  typecheck/build/smoke    PASS

npm run web:e2e
  Playwright Chromium      PASS — 10 tests
```

Those replay-clock, collection-capacity, request-race, paused-validation, and malformed-route regressions remain in the final suites.

## Final verification

Commands were run from the repository root against the final source:

```bash
git diff --check
npm run check:all
npm run web:e2e
```

Observed results:

```text
git diff --check           PASS

npm run check:all
  engine typecheck         PASS
  engine tests             PASS — 10 files, 47 tests
  engine build             PASS
  package smoke            PASS — linear/Issue.create + LTL
  frontend tests           PASS — 4 files, 24 tests
  app + server typecheck   PASS
  Vite production build    PASS — 40 modules
  CSS                      31.55 kB (7.68 kB gzip)
  JS                       282.33 kB (86.71 kB gzip)

npm run web:e2e
  Playwright Chromium      PASS — 13 tests, fresh production build
```

The browser suite covers the complete create/edit/enable/persist journey, violating and healthy engine paths, friendly eventuality rejection and confirmed alternative, advanced-editor safety gating, canonical chip edits with changed runtime output, keyboard/mouse phrase-to-trace linking, needs-review migration, API safety rejection, all previous replay races and validation/capacity/navigation regressions, mobile overflow, console errors, reduced motion, and the Firefox-compatible no-View-Transitions fallback.

## Inspected screenshots

- [Desktop safety board](apps/web/artifacts/screenshots/safety-desktop-board.png)
- [Expanded counterexample evidence](apps/web/artifacts/screenshots/safety-desktop-evidence.png)
- [Mobile safety board](apps/web/artifacts/screenshots/safety-mobile-board.png)
- [Mobile safety detail](apps/web/artifacts/screenshots/safety-mobile-detail.png)

All four were captured by Playwright from the freshly built application and inspected at original resolution. The desktop evidence view shows the real three-event recurrence trace; the 390×844 mobile captures show readable chips/detail content, fixed navigation, and no horizontal overflow.

## Honest boundaries

- Template-assisted interpretation is a provider seam, not general natural-language translation. No LLM is wired.
- All observations and source links are clearly labeled deterministic synthetic fixtures.
- The bridge uses an in-memory monitor store per replay and binds only to localhost. Durable engine behavior remains covered by the package tests.
- Outbox records are simulated pending investigation requests. There is no live GitLab dispatcher or started agent.
- Product safety rejection is intentionally stricter than engine compilation. Direct internal deadline replay remains covered so the safety revision does not remove or weaken library capability.
