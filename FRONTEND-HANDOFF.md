# Needl frontend handoff

Status: implemented and locally verified on 2026-10-14. No deployment, push, provider connection, paid API, or external mutation was performed.

## Delivered

The approved Needl frontend now lives in `apps/web` as a responsive React/TypeScript application. It preserves the engine package and its exports while adding a localhost-only Node bridge for deterministic demo replay.

The complete local journey includes:

- a graphite, warm-white, and restrained amber assertion workspace matching the approved desktop composition;
- a Keep-like variable-height assertion collage with search, status filters, three sort modes, and compact/comfortable density;
- explicit template-guided authoring that keeps the user's natural-language expectation but does not claim general AI translation;
- an editable LTL/formula field and full structured assertion JSON editor validated by the existing parser/compiler;
- enable and pause controls, version increments, validated browser persistence, and rejection of malformed or executable-looking restored predicate data;
- deterministic violating and healthy replays through the existing `RuntimeMonitor` and `InMemoryMonitorStore`;
- genuine engine checkpoints, predicate evaluations, deadline ticks, counterexample traces, and outbox state in the interface;
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

Replay requests contain validated assertion definitions and a `violating` or `healthy` scenario name. `apps/web/demo.ts` constructs fixed synthetic normalized observations, registers the supplied active definitions with the actual runtime, processes each observation, advances the explicit support deadline clock, and returns the store's real checkpoints, counterexamples, traces, predicate explanations, and outbox requests.

The three reviewed templates use the engine's existing presets:

- Linear completion + linked GitLab deployment + Sentry recurrence;
- persisted LaunchDarkly disabled state + explicitly attributed Sentry error; and
- Stripe payment + PostHog provisioning failure + an Intercom support deadline.

All fixture timestamps are anchored on 2026-02-18 UTC and all evidence is labeled synthetic. Replay is in-memory and deterministic. User-authored assertions are stored separately in `localStorage` under the versioned `needl.assertions.v1` envelope. Restores are compiled before acceptance; an invalid envelope is discarded as a unit and safe samples are restored. Resetting sample rules preserves locally authored rules. Removing authored rules requires confirmation.

## Authoring boundary

Natural-language LLM translation is not implemented. The composer therefore opens an explicit interpretation-template picker. Choosing a template copies its reviewed formula, predicates, state updates, and scope while preserving the user's expectation text. The structured editor supports arbitrary valid engine definitions and ordinary LTL text (or deadline JSON) without arbitrary JavaScript execution.

The local bridge caps replay payloads at 1 MB and 25 assertions, requires the synthetic demo tenant, rejects duplicate IDs, and relies on the existing compiler's closed predicate validation.

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

Final observed results:

```text
npm run check
  typecheck                 PASS
  legacy tests             PASS — 10 files, 47 tests
  engine build             PASS
  package smoke            PASS — linear/Issue.create + LTL

npm run web:test
  frontend tests           PASS — 3 files, 11 tests

npm run web:build
  app + server typecheck   PASS
  Vite production build   PASS — 37 modules
  CSS                      27.56 kB (6.86 kB gzip)
  JS                       264.76 kB (81.97 kB gzip)

npm run web:e2e
  Playwright Chromium      PASS — 5 tests
```

The Playwright suite exercises create/template selection, edit/version, enable/pause state, filter/search, detail/back/focus, actual violating and healthy engine replay, counterexample timelines, persistence across reload, invalid restore rejection, Activity and Connections navigation, mobile overflow, browser console errors, reduced motion, and a missing-View-Transitions fallback.

## Reviewed screenshots

- [Desktop board](apps/web/artifacts/screenshots/needl-desktop.png)
- [Desktop board with detail](apps/web/artifacts/screenshots/needl-desktop-detail.png)
- [Mobile board](apps/web/artifacts/screenshots/needl-mobile.png)
- [Mobile detail](apps/web/artifacts/screenshots/needl-mobile-detail.png)

All four were captured from the freshly built output and visually inspected. The desktop detail screenshot most closely mirrors the approved split-board reference; the narrow screenshots confirm readable cards, a full-width detail surface, and bottom navigation without horizontal overflow.

## Integration boundaries and honest limits

- No LLM or authoring provider is connected. The provider seam is represented by typed, explicit templates.
- No live webhook source is connected. The Connections page reports fixture counts and missing credentials honestly.
- No live GitLab investigation dispatcher exists. Engine outbox requests are shown as pending simulated response state; the launch control is disabled.
- No browser secrets or API keys are used. The bridge contacts no external system.
- The local bridge uses in-memory monitor storage for each replay. Durable SQLite behavior remains covered by the existing engine tests and examples, not duplicated in the frontend.
- A custom assertion whose scope does not bind any fixture is shown as unavailable/no matching evidence, never satisfied.
- Analytics are derived only from current replay events, checkpoints, violations, and outbox records.
- The synthetic evidence URLs are displayed as fixture provenance and are not presented as working provider links.
- This is a local demonstration server, not a production API, authentication boundary, or deployment configuration.
