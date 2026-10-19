# Needl deployment

Needl runs on Vercel as project `needl`, at:

```text
https://needl.dev
```

`www.needl.dev` redirects there; `https://needl-sigma.vercel.app` still serves the same deployment, so webhooks registered against it keep working.

`vercel.json` installs both packages and runs `npm --prefix apps/web run build:vercel`, which writes Vercel's Build Output API directly: the Vite frontend as static files and the whole `/api` surface as one bundled Node function (`apps/web/backend/vercel.ts`, wrapping the same `createNeedlApp()` the local server uses). Deploy with `vercel deploy --prod` from the repository root.

Time-bounded rules have no background timer on Vercel. They advance on incoming requests (at most every 2 seconds; the open UI polls every few seconds) and on a daily cron to `/api/cron/tick`, which requires `CRON_SECRET`. Hobby plans cannot run crons more often than daily.

## Environment

- `DATABASE_URL`: Neon Postgres, provisioned through the Vercel Marketplace (`needl-db`) and injected automatically. Postgres is the only supported database; local development uses `postgres://localhost:5432/needl` from the repository `.env`.
- `OPENAI_API_KEY`: server-side API key; it must never be exposed through a `VITE_` variable.
- `NEEDL_SIGNUP_ALLOWLIST`: comma-separated approved email addresses. An empty value closes production signup.
- `BETTER_AUTH_SECRET`: at least 32 random characters.
- `BETTER_AUTH_URL`, `NEEDL_TRUSTED_ORIGINS`, `NEEDL_PUBLIC_URL`: the production URL above. Webhook URLs shown during setup use `NEEDL_PUBLIC_URL`.
- `NEEDL_SECRET_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts webhook signing secrets saved through the Connections page. Production refuses to start without it; changing it makes saved secrets unreadable, so every connection would need its secret pasted again.
- `NEEDL_AUTO_MIGRATE=true`: runs Better Auth migrations when a function instance starts (application migrations always run).
- `NEEDL_DB_POOL_MAX=3`: keeps each function instance's connection pool small.
- `CRON_SECRET`: authorizes the cron route.

## Connecting tools

Each workspace connects its tools from the Connections page: Connect creates a webhook route and shows its URL, step-by-step instructions for that provider, and a field for the signing secret, which is validated for the provider's format and stored encrypted with `NEEDL_SECRET_KEY`. The route accepts deliveries once the secret is saved; the page then shows the outcome of the latest delivery (verified, signature mismatch, stale timestamp, unsupported event) so setup problems are visible immediately.

## Server-managed provider configuration

Operators can still provision routes without the UI. Create integration records only after the first approved user has signed up and `/api/workspace` has returned that user's opaque `tenantId`. Put non-secret configuration in a restricted JSON file; put token/signing values in hosting environment variables referenced by `secretEnvName`.

```json
[
  {
    "id": "int_needl_gitlab_events",
    "tenantId": "ten_REPLACE_FROM_AUTHENTICATED_WORKSPACE",
    "provider": "gitlab",
    "enabled": true,
    "secretEnvName": "NEEDL_GITLAB_WEBHOOK_SECRET",
    "config": {
      "purpose": "ingestion",
      "authMode": "signing-token",
      "enabledEvents": ["pipeline.success", "deployment.success"],
      "kindMappings": {
        "pipeline.success": "fix.deployed",
        "deployment.success": "fix.deployed"
      }
    }
  },
  {
    "id": "int_needl_gitlab_investigation",
    "tenantId": "ten_REPLACE_FROM_AUTHENTICATED_WORKSPACE",
    "provider": "gitlab",
    "enabled": true,
    "secretEnvName": "NEEDL_GITLAB_FLOW_TOKEN",
    "config": {
      "purpose": "investigation",
      "baseUrl": "https://gitlab.com",
      "projectId": "REPLACE_WITH_DEDICATED_PROJECT_ID_OR_PATH",
      "consumerId": 123,
      "tokenType": "private-token"
    }
  }
]
```

Do not enable the investigation record until the dedicated project, numeric AI Catalog consumer ID, read-only flow, entitlement, and scoped token have been verified. Add `callbackHookId` and `callbackSecretEnvName` only when signed Duo flow callbacks are available. Apply the reviewed file from a secure shell:

```sh
npm --prefix apps/web run db:configure-integrations -- /restricted/path/needl-integrations.json
```

The signed ingestion URL is `https://needl.dev/api/hooks/<integration-id>`. The optional flow callback URL is `https://needl.dev/api/hooks/gitlab-flow/<integration-id>`.

## Hosted acceptance

After publishing, verify separately: health, allowlisted signup, signin/signout, authenticated workspace access, cross-account isolation, database save/reload, server-side translation and confirmation, exact-byte signed delivery plus duplicate, service restart persistence, explicit GitLab launch, GraphQL refresh, and signed terminal callback. Never use learner/customer data or a real commerce action for smoke tests.
