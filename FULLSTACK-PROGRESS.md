# Needl full-stack progress

## 2026-10-15 — inherited implementation checkpoint

- Resumed from `7f103e3` and preserved the existing dirty implementation.
- Verified the core package: 10 files / 47 tests pass.
- Verified the web package: 6 files / 33 tests pass.
- Verified the web production build and TypeScript checks.
- Confirmed the shared secret store contains an OpenAI API key without printing it.
- Confirmed a Neon MCP entry exists. A fresh connection currently requires interactive OAuth reauthorization; no project, database, or billing state was changed.
- Verified the server-side Responses API implementation against the current official Structured Outputs contract (`text.format` with a strict JSON schema).
- Current implemented foundation: Better Auth email/password sessions, tenant-owned durable assertions and versions, replay persistence, translation quotas/proposals/confirmation, production PostgreSQL requirement, local SQLite fallback, CSRF/origin checks, security headers, and authenticated frontend workspace sync.
- Remaining work: signed live ingestion through the durable runtime, GitLab investigation dispatch/callback/status persistence, full-stack A/B/auth/security tests, bounded live OpenAI/database smokes, deployment files, UX integration status, and final handoff.

External checks remain separate from local evidence. No push or deployment has been performed.

## 2026-10-15 — signed ingestion and investigation checkpoint

- Added an opaque, server-managed signed webhook route. Provider and tenant are resolved from durable configuration; browser input cannot select either or supply a credential.
- Added a transactional live monitor store with per-scope checkpoints, traces, processed-input dedupe, counterexamples, and outbox persistence.
- Connected verified normalized events to the actual runtime monitor and preserved event/restart dedupe semantics.
- Added GitLab custom-flow launch using the researched REST contract, compact redacted counterexample context, one explicit attempt, and `launch_unknown` handling with no blind retry.
- Added Standard Webhooks verification and event-id dedupe for GitLab flow callbacks; terminal callbacks cannot be overwritten by later progress.
- Added server-managed integration summaries and honest frontend connection/investigation states. No configured credential is represented as live.
- Production signup is closed unless `NEEDL_SIGNUP_ALLOWLIST` explicitly lists approved addresses; auth and translation rate limits remain durable.
- Added unit/integration coverage for signed-byte tampering, webhook dedupe, live monitor restart, investigation correlation, ambiguous launch behavior, auth enforcement, CSRF/origin checks, signout, and A/B route isolation.
- Verification: web tests 8 files / 39 tests pass; production TypeScript/Vite build passes.

Neon remains unchanged: the configured OAuth connection still requires interactive reauthorization. No GitLab project credential was discovered, so no external flow was launched.
