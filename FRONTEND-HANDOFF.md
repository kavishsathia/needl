# Needl frontend handoff

Status: implemented and locally verified on 2026-10-14. No deployment, push, provider connection, paid API, or external mutation was performed.

Current product scope is the safety-only, meaning-first revision documented in `SAFETY-UX-HANDOFF.md` and `docs/safety-product-policy.md`. The reusable engine remains broader than the product UI.

## Delivered

The approved Needl frontend now lives in `apps/web` as a responsive React/TypeScript application. It preserves the engine package and its exports while adding a localhost-only Node bridge for deterministic demo replay.

The complete local journey includes:

- a graphite, warm-white, and restrained amber assertion workspace matching the approved desktop composition;
- a Keep-like variable-height assertion collage with search, status filters, three sort modes, and compact/comfortable density;
- explicit template-guided authoring that keeps the user's natural-language expectation but does not claim general AI translation;
- readable sentence rules with accessible, data-backed inline chips whose changes version and rebuild canonical formula, predicates, state, and scope;
- a collapsed advanced formula/JSON inspector validated by both the existing compiler and the product safety gate;
- enable and pause controls, version increments, validated browser persistence, and rejection of malformed or executable-looking restored predicate data;
- deterministic violating and healthy replays through the existing `RuntimeMonitor` and `InMemoryMonitorStore`;
- generic replay-horizon clock advancement for every actually instantiated timed partition, including custom IDs and scopes, without advancing beyond the fixture horizon;
- genuine engine checkpoints, predicate evaluations, counterexample traces, source evidence links, and outbox state in the interface;
- a shared 25-rule collection contract across authoring, editing, persistence, restore, and replay API validation, with friendly pre-save capacity feedback;
- latest-request replay state management so stale successes and stale failures cannot overwrite current evidence or error state;
- safe malformed-hash fallback that preserves accepted browser-local assertion data;
- detail views with overview, counterexamples, and matching activity, plus derived replay analytics;
- View Transitions API card/detail morphing, a no-API fallback, reduced-motion behavior, history/back handling, focus restoration, and board-scroll restoration;
- real Activity, Connections, and Settings navigation;
- seven clearly labeled fixture sources without false live-connection claims;
- explicitly simulated GitLab investigation state with the unavailable live-launch control disabled and explained; and
- responsive narrow-screen layout with a fixed mobile navigation bar and no horizontal overflow in the tested viewport.

## Architecture and data flow

The browser never imports the Node-dependent runtime. `apps/web/server.ts` binds only to `127.0.0.1` and exposes three local routes:

```text
GET  /api/health
GET  /api/demo/bootstrap
POST /api/demo/replay
```

Replay requests contain validated assertion definitions and a `violating` or `healthy` scenario name. `apps/web/demo.ts` constructs fixed synthetic normalized observations, validates and compiles every supplied definition before filtering paused records, registers active definitions with the actual runtime, processes each observation, advances all instantiated timed checkpoints to the explicit 12:11 UTC replay horizon, and returns the store's real checkpoints, counterexamples, traces, predicate explanations, and outbox requests.

The three reviewed product templates are safety properties:

- Linear completion + linked GitLab deployment + Sentry recurrence;
- persisted LaunchDarkly disabled state + explicitly attributed Sentry error; and
- explicit PostHog order-accepted lifecycle state + correlated Stripe payment + PostHog fulfillment-before-payment evidence.

All fixture timestamps are anchored on 2026-02-18 UTC and all evidence is labeled synthetic. Replay is in-memory and deterministic. User-authored assertions are stored separately in `localStorage` under the versioned `needl.assertions.v1` envelope. Restores are compiled and collection-validated before acceptance; an invalid envelope is discarded as a unit and safe samples are restored. Invalid authoring or editing attempts do not replace the last accepted collection. Resetting sample rules preserves locally authored rules. Removing authored rules requires confirmation.

## Authoring boundary

Natural-language LLM translation is not implemented. The composer therefore opens an explicit interpretation-template picker. Choosing a template preserves the user's wording and creates a readable, editable meaning backed by a reviewed formula, predicates, state updates, and scope. Eventuality/deadline wording receives friendly unsupported feedback and requires explicit confirmation of an offered safety alternative; it is never silently rewritten.

The normal journey requires no formula or JSON. The collapsed advanced editor supports only the documented product safety shapes and uses the same validation as enablement and the replay API. Existing unsupported saved rules are preserved as disabled `needs-review` records; the reusable engine's general LTL/deadline implementation and tests remain intact.

The local bridge caps replay payloads at 1 MB and 25 assertions, requires the synthetic demo tenant, rejects duplicate IDs and unknown statuses, and relies on the existing compiler's closed predicate validation. Paused definitions are compiled too, so inactive malformed rules receive a controlled HTTP 400 instead of entering storage or crashing replay.

## Acceptance repair results

All five bounded findings were independently reproduced by new RED regressions and fixed:

- custom timed definitions previously remained at 12:01 with pending obligations; every instantiated timed checkpoint now reaches the 12:11 replay horizon, while longer deadlines remain pending and healthy responses discharge normally;
- browser persistence previously accepted individually valid but invalid collections; duplicate IDs, wrong tenants, and more than 25 rules are now rejected consistently, and ordinary browser authoring stops cleanly at capacity;
- delayed pause responses and late request failures previously replaced newer enabled replay state; request generations now protect evidence, loading, and error state;
- unknown statuses and malformed paused definitions previously bypassed complete replay validation; both now return controlled 400 responses; and
- malformed percent-encoded assertion hashes previously threw during render; routing now falls back to the assertion board without changing accepted local data.

No listed finding was nonreproducible.

## Run locally

Requirements remain Node 22.13 or newer and npm.

```bash
npm install
npm --prefix apps/web ci --legacy-peer-deps
npm run web:dev
```

Development URLs:

- Vite UI: `http://127.0.0.1:5173`
- local demo API bridge: `http://127.0.0.1:4174`

For the freshly built output:

```bash
npm run web:build
npm run web:serve
```

The production-build preview is `http://127.0.0.1:4173`.

## Verification commands

```bash
# Existing engine package
npm run check

# Frontend unit/contracts and strict production build
npm run web:test
npm run web:build

# First machine only, if Chromium is not installed for Playwright
cd apps/web && npx playwright install chromium && cd ../..

# Rebuilds, serves the production output, and runs browser journeys
npm run web:e2e
```

Final observed results on 2026-10-14:

```text
npm run check:all
  typecheck                 PASS
  legacy tests             PASS — 10 files, 47 tests
  engine build             PASS
  package smoke            PASS — linear/Issue.create + LTL
  frontend tests           PASS — 3 files, 15 tests
  app + server typecheck   PASS
  Vite production build   PASS — 38 modules
  CSS                      27.56 kB (6.86 kB gzip)
  JS                       266.48 kB (82.45 kB gzip)

npm run web:e2e
  Playwright Chromium      PASS — 10 tests, fresh production build
```

The Playwright suite exercises create/template selection, edit/version, enable/pause state, filter/search, detail/back/focus, actual violating and healthy engine replay, counterexample timelines, persistence across reload, invalid restore rejection, capacity enforcement, stale-success and stale-failure response ordering, controlled API 400s, malformed hash fallback, Activity and Connections navigation, mobile overflow, browser console errors, reduced motion, and a missing-View-Transitions fallback.

## Reviewed screenshots

- [Safety desktop board](apps/web/artifacts/screenshots/safety-desktop-board.png)
- [Expanded engine evidence](apps/web/artifacts/screenshots/safety-desktop-evidence.png)
- [Safety mobile board](apps/web/artifacts/screenshots/safety-mobile-board.png)
- [Safety mobile detail](apps/web/artifacts/screenshots/safety-mobile-detail.png)

All four were captured from the freshly built output and visually inspected. The desktop detail screenshot most closely mirrors the approved split-board reference; the narrow screenshots confirm readable cards, a full-width detail surface, and bottom navigation without horizontal overflow.

## Integration boundaries and honest limits

- No LLM or authoring provider is connected. The provider seam is represented by typed, explicit templates.
- No live webhook source is connected. The Connections page reports fixture counts and missing credentials honestly.
- No live GitLab investigation dispatcher exists. Engine outbox requests are shown as pending simulated response state; the launch control is disabled.
- No browser secrets or API keys are used. The bridge contacts no external system.
- The local bridge uses in-memory monitor storage for each replay. Durable SQLite behavior remains covered by the existing engine tests and examples, not duplicated in the frontend.
- A meaning choice without fixture coverage is explicitly labeled **No matching evidence**, never satisfied or safe.
- Analytics are derived only from current replay events, checkpoints, violations, and outbox records.
- The synthetic evidence URLs are displayed as fixture provenance and are not presented as working provider links.
- This is a local demonstration server, not a production API, authentication boundary, or deployment configuration.
