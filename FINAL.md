# Implementation handoff

## Delivered

- Strict TypeScript package targeting supported Node.js 22.13+.
- Framework-independent common adapter/result/event contracts.
- Substantive authenticated adapters for GitLab, Linear, LaunchDarkly, Sentry, PostHog, Intercom, and Stripe.
- Raw-byte authentication, secret rotation arrays, replay windows where the provider protocol supports signed timestamps, strict schemas, exact subscription filters, custom kind mappings, explicit ignored/rejected outcomes, and bounded evidence.
- Tenant/provider-scoped route resolution and durable deduplication contract.
- In-memory sink and restart-safe SQLite store with ordered list/replay.
- Thin runnable Node HTTP server registering all seven providers, with configurable payload limit and no default payload/secret logging.
- Synthetic documented fixtures, unit tests, receiver failure/tenant/dedupe tests, SQLite restart/replay tests, and a signed HTTP-to-SQLite end-to-end test.
- Provider setup, permissions, rotation, delivery, coverage, and unsupported-event documentation.
- Local-only incremental Git commit history. Nothing was published, deployed, registered, or pushed.

## Verification

The final verification commands and results are recorded after the last clean run below:

```text
npm run typecheck  # pending final run
npm test           # pending final run
npm run build      # pending final run
npm audit          # pending final run
package import     # pending final run
```

## Exact remaining limitations

- Verification is synthetic/local only. No provider sandbox or live credential test was performed, and no webhook was registered.
- Stripe support is for snapshot v1 Event objects, not thin v2 notifications.
- PostHog requires the documented Needl destination template because PostHog bodies are user-configurable. Standard Webhooks is preferred; configured shared-header mode cannot provide body integrity.
- The package normalizes one observation per delivery. A LaunchDarkly audit entry with multiple `accesses` retains every resource/action as evidence but remains one observation.
- Full unrestricted payloads are not persisted. The event stores a bounded evidence projection; an encrypted raw archive is a caller responsibility if policy requires it.
- No reference hydration/API clients are included. Missing relationships and timestamps remain missing.
- Sentry examples do not consistently supply a delivery ID; `Request-ID` is used when present and a stable content identity otherwise.
- Providers without a signed timestamp in their documented scheme rely on scoped durable deduplication rather than a pre-parse replay window.
- The included SQLite sink is intended for a single local process. A horizontally scaled deployment needs a shared transactional implementation of `DeduplicatingEventSink`.
- On the Node 22 runtime used for verification, `node:sqlite` emits Node's experimental-feature warning. SQLite is isolated to the optional `@needl/integrations/sqlite` entrypoint; the core package does not load it.
- The example binds locally and provides HTTP only. Production requires an HTTPS reverse proxy/server, operational secret management, monitoring, and provider registration—all deliberately outside this assignment.

These limitations are intentional boundaries, not claims of provider coverage.

