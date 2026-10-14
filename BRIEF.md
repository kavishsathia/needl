# Needl — modular webhook integrations

## User-authorized assignment
Build the integrations layer in this new local repository. No frontend. Commit frequently at meaningful tested milestones. Do not publish/create a remote repository, push, deploy, provision accounts, register real webhooks, or invoke mutating external APIs. Local Git repository is already initialized. Work only inside this project; do not modify Hermes configuration or other repos. Network use for official documentation and dependency installation is allowed. Never inspect personal credentials or embed secrets.

## Product context and authorship
Needl (user owns needl.dev) is Kavish's assertion-based operations product for a GitLab hackathon. A future Google Keep-style frontend accepts natural-language business expectations, translated to structured LTL. Runtime violations produce counterexample traces which wake GitLab agent flows. This assignment is ONLY the reusable integrations layer, not the frontend, LLM translator, LTL monitor, or full agent execution engine.

Example: a Linear ticket says fixed, a GitLab change is deployed, then a linked Sentry issue recurs. Or a LaunchDarkly flag is disabled but related errors recur. Intercom support commitments and Stripe transactions add business observations. GitHub is NOT part of this product/demo.

## Required providers
GitLab, Linear, LaunchDarkly, Sentry, PostHog, Intercom, Stripe. All use webhooks. Official documentation entry points:
- https://docs.gitlab.com/user/project/integrations/webhooks/
- https://linear.app/developers/webhooks
- https://launchdarkly.com/docs/integrations/webhooks
- https://docs.sentry.io/organization/integrations/integration-platform/webhooks/
- https://posthog.com/docs/cdp/destinations/webhook
- https://developers.intercom.com/docs/webhooks
- https://docs.stripe.com/webhooks
Read actual provider payload/event/security docs before implementing. Do not assume every webhook exposes every event or infer occurrence from issue status updates. Do not invent built-in PostHog signing; its configurable destination can use explicit shared authentication, documented honestly. GitLab has version-dependent signing/secret-token options; implement clearly configured supported modes from docs, not implicit downgrade.

## Implementation direction
Choose TypeScript with strict types and a current supported Node baseline. Produce a reusable package with framework-independent adapters, exports, and a thin runnable HTTP example demonstrating backend consumption. Do not expose UI. Keep architecture straightforward and document decisions.

Each provider should implement a common adapter contract for raw HTTP body/header ingestion, authenticity validation, payload validation, and conversion into normalized events. Preserve provider-specific payload and links to original evidence safely; support stable event identities, provider delivery IDs when supplied, tenant/source scope, occurredAt vs receivedAt, event kind, entity references and explicit relationship evidence (issue keys, repository/commit/release identifiers where available). Do not fabricate missing IDs/timestamps/relationships or pretend a mention proves a fix. Mark unknown types explicitly; distinguish ignored valid event from malformed/unauthenticated event.

Expose configurable event subscriptions/mappings. Cover useful representative events for each provider and document exact coverage/unsupported events. Prefer a small complete vertical slice per provider to a large list of empty handlers. Capture webhook setup instructions, required permissions/plans if documented, example config, secret rotation considerations, payload limits, retries, duplicate delivery and ordering behavior. Never log secrets or unrestricted customer payloads by default.

Provide a backend-friendly receiver abstraction: signature/auth verification over correct raw bytes, strict parsing afterwards where appropriate, configurable payload size, deduplication interface scoped by tenant/provider, durable event sink/acknowledgment boundary, retryable storage failure response vs valid ignored input. Include a real local persistence implementation (SQLite or equivalent appropriate lightweight choice) for the runnable example so ingest/restart/replay behavior is exercised; core package must not require that storage. Do not ack failed persistence. Store counterexample-source evidence without conflating observation with executing an action. Route resolution must keep tenant-specific keys isolated. Baseline fetch-based reference hydration can be added only if useful, read-only, with explicit credentials supplied by caller; it is not necessary to build every REST client.

## Tests and verification
Use test-first where practical. Test provider payload normalization, real documented signature algorithms, tampered body, wrong/missing secret, malformed input, unknown event, duplicate deliveries, tenant separation, persistence failure/retry, and replay/restart. Use clearly labeled synthetic fixtures shaped from cited docs; never claim sandbox/live verification without actually doing it. Exercise the runnable HTTP server with signed/authenticated requests and real storage, not merely unit mocks. Record test/build/typecheck commands and actual results. Include package import/use smoke test. Exclude generated output and secrets appropriately. Use dependency lockfile.

## Work and commits
Make an initial scaffold/brief commit, then frequent focused commits (core contract, provider adapters in small groups, receiver/storage, docs/e2e etc). Read relevant project instructions and skills where available. Continue until all seven have substantive tested implementations and example runs. Do not stop at a stub or plan. If blocked, document exact blocker and continue independent pieces. Use local commits only. Configure repository-local author only if needed; do not change global git config.

## Deliverables
README explaining architecture, setup, importing adapters into future backend, local running/testing; provider capability/setup/source documentation; tests and synthetic fixtures; runnable example; complete package; git commit history; FINAL.md with implementation summary, executed verification, exact remaining limitations, and live credential-dependent checks not performed. Keep all changes committed and working tree clean at completion.
