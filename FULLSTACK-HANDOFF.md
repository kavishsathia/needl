# Needl full-stack handoff

**Date:** 2026-10-15 UTC  
**Branch:** `main` (local only; no push)  
**Starting point:** `7f103e3` plus inherited dirty work  
**Prepared URL:** `https://needl-monitoring-preview.onrender.com` (not deployed or reserved)

## Outcome

The repository now contains a deployable authenticated full-stack Needl application, not a frontend-only simulation. It retains deterministic safety replay for product demonstration while adding server-side OpenAI translation, tenant-owned persistence, signed provider ingestion into the actual runtime monitor, and an explicitly launched read-only GitLab investigation lifecycle.

No external success is implied by local UI state. Connection cards are marked live only when an enabled server-managed integration record exists. A `201` GitLab launch is shown as running/accepted, never completed. Ambiguous POST outcomes become `launch_unknown` and are not retried.

## Scoped commits

- `0525747 feat(web): wire authenticated durable workspace`
- `52c9331 feat(web): add signed monitoring and investigations`
- `f4ebdb0 feat(web): harden deployment and live integrations`
- final documentation/test checkpoint follows this handoff

## Implemented

### Authentication and tenancy

- Better Auth email/password accounts with maintained password hashing, secure production cookies, seven-day database sessions, origin/CSRF protection, database-backed rate limits, and no telemetry.
- Production signup is closed unless `NEEDL_SIGNUP_ALLOWLIST` contains the submitted email. This prevents anonymous account multiplication against paid translation.
- Every assertion, version, translation proposal/quota, event, checkpoint, trace, counterexample, outbox item, integration summary, and investigation query is scoped by the authenticated tenant.
- Browser recovery cache keys include the opaque tenant ID. Legacy global data is read once as migration input, then written only to the tenant key.

### Persistence and runtime

- PostgreSQL via `DATABASE_URL` in production with TLS certificate verification; production refuses SQLite fallback.
- SQLite remains available only outside production for local work and tests.
- Non-destructive application tables cover tenants, assertions/versions, normalized events, demo and live monitor state, live traces/processed inputs, counterexamples, outbox, translation usage/proposals, integrations, investigations, and callback deliveries.
- Live monitor commits atomically persist optimistic checkpoints, trace items, input dedupe, counterexamples, and outbox requests per tenant/assertion/version/scope.
- Concurrent assertion edits use a version predicate; concurrent translation requests use an atomic increment. Tests prove one stale-write winner and a hard quota cap.

### OpenAI translation

- `OPENAI_API_KEY` is read only in the Node server process.
- The Responses API uses strict Structured Outputs (`text.format` JSON Schema), a 300-token output cap, and `gpt-4o-mini` by default.
- Results can select only `recurrence`, `feature`, `order`, or `none`; malformed/unknown output is rejected.
- Local liveness/deadline detection rejects unsupported intent before any model request.
- Proposals are durable, tenant-scoped, quota-limited, and require an explicit template choice/confirmation before a draft is created.

### Signed ingestion

- Public route: `POST /api/hooks/<opaque-integration-id>`.
- Tenant, provider, auth mode, allowed events, mappings, and environment-secret references come from the durable server-side integration record—not URL/body/browser selection.
- The existing provider adapters verify exact raw bytes before parsing. Disabled/missing routes return not found. Secret values never enter the database.
- Valid normalized events advance the actual durable monitor and then enter scoped delivery dedupe. Replays do not duplicate state or counterexamples.

### GitLab investigations

- Explicit authenticated action only; no automatic agent launch from an outbox item.
- Launch contract: `POST /api/v4/ai/duo_workflows/workflows`, fixed server-side project/consumer mapping, compact redacted `needl_counterexample`, no user prompt, no merge/deploy/provider write instruction.
- One attempt per `(tenant, integration, violation, assertion version)`; provider retry or double-click cannot create a second flow.
- Timeouts/network failure after a possible write become `launch_unknown` with no automatic retry.
- Owner-scoped GraphQL refresh uses `duoWorkflowWorkflows` and the workflow global ID. Unknown statuses remain running/unresolved.
- Optional callback route: `POST /api/hooks/gitlab-flow/<integration-id>`. It verifies Standard Webhooks HMAC over exact bytes, enforces timestamp skew, deduplicates `event_id`, correlates client reference/workflow, and prevents late progress from overwriting terminal state.

### Deployment readiness

- [`render.yaml`](render.yaml) defines a single Render free-plan Node service, health check, generated auth secret, explicit public URL/origin, and prompts for Neon/OpenAI/allowlist secrets. It does not create a paid service or database.
- Startup runs application and Better Auth migrations before serving.
- [`docs/deployment.md`](docs/deployment.md) contains exact URLs, environment variables, restricted integration-file examples, and hosted acceptance checks.
- `npm --prefix apps/web run db:configure-integrations -- /restricted/path/file.json` writes reviewed non-secret config plus environment-variable references.

## Verification evidence

### Local automated evidence

| Check | Result |
|---|---|
| Core `npm run check` | 10 test files / 47 tests pass; typecheck, build, package smoke pass |
| Web `npm --prefix apps/web test` | 9 test files / 42 tests pass after final isolation hardening |
| Web production build | TypeScript app/server checks and Vite build pass |
| Chromium E2E | 16/16 pass |
| Signed ingestion | valid exact bytes stored; duplicate acknowledged once; tampered bytes rejected |
| Live runtime restart | checkpoints/events/counterexample survive close/reopen; A/B remain isolated |
| GitLab contract fixtures | single launch, GraphQL refresh, signed terminal callback, duplicate callback, ambiguous no-retry pass |
| HTTP security | anonymous 401, hostile/missing mutation origin 403, signout revocation, A/B workspace/delete/monitor isolation pass |
| Secret scan | real OpenAI key and server-only variable names absent from compiled browser assets |
| Render YAML | parsed successfully |

The final web test and E2E counts above must be refreshed if later edits change them. Browser artifacts are under `apps/web/artifacts`; the retained safety screenshots include:

- `apps/web/artifacts/screenshots/safety-desktop-board.png`
- `apps/web/artifacts/screenshots/safety-desktop-evidence.png`
- `apps/web/artifacts/screenshots/safety-mobile-board.png`
- `apps/web/artifacts/screenshots/safety-mobile-detail.png`

### Live external evidence

- **OpenAI:** passed one bounded authorized translation call. `gpt-4o-mini` returned the reviewed `recurrence` template through the production translator.
- **Neon management OAuth:** not verified. `hermes mcp list` shows an enabled `neon` entry at `https://mcp.neon.tech/mcp`, but `hermes mcp test neon` requires interactive browser reauthorization. No project/database was listed, created, changed, or billed.
- **Neon application database:** not verified because no dedicated Needl `DATABASE_URL` was available after the OAuth failure. No migration or write/read was claimed.
- **GitLab:** no scoped project token, enabled AI Catalog consumer, callback signing token, or dedicated project mapping was present. No external flow/callback/status call was made.
- **Hosting:** not published. The Render service name/URL remains intended configuration until the publishing operator confirms availability and a successful health check.

## Exact external blockers and next authorized actions

1. Reauthorize Neon interactively with `hermes mcp login neon`, then restart/reload MCP exposure and run `hermes mcp test neon`.
2. List existing projects before creating anything. Select or create only a dedicated Needl project/database with provider defaults and no billing upgrade.
3. Obtain its TLS connection string without logging it, set `DATABASE_URL`, run `npm --prefix apps/web run db:migrate`, inspect tables, and perform a rollback-only synthetic write/read plus the application A/B smoke.
4. Confirm the Render service name. If the hostname differs, update both URL variables in `render.yaml` before publishing.
5. Set only `DATABASE_URL`, `OPENAI_API_KEY`, an approved `NEEDL_SIGNUP_ALLOWLIST`, and the generated auth secret. Keep signup closed for all other addresses.
6. Publish and verify the stable alias: allowlisted signup, signin/signout, database save/reload, translation/confirmation, second-account isolation, restart recovery, and absence of offline mode.
7. For GitLab, provision a disposable dedicated project and read-only custom flow, resolve the numeric consumer ID, verify credits/entitlement and token type, then add the reviewed integration record. Do not enable it before those checks.
8. Send one tiny synthetic signed event and verify duplicate/restart behavior. Launch one tiny read-only investigation explicitly, then verify GraphQL state and (only if available) a signed callback.

## Recovery behavior

If server persistence becomes available after a browser has local drafts, the application loads server state when present and otherwise migrates the tenant-scoped local copy. Do not clear browser storage during recovery. If an optimistic save conflicts, reload first; never overwrite the newer server version blindly.

## Commands

```sh
npm run check
npm --prefix apps/web test
npm --prefix apps/web run build
npm --prefix apps/web run e2e

# Authorized bounded live check; load the key through a secret manager first.
npm --prefix apps/web run smoke:openai

# Production database migration.
npm --prefix apps/web run db:migrate
```

No remote push or deployment was performed by this worker.
