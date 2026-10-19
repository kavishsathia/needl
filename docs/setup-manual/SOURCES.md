# Evidence map for the setup manual

- Needl repository pinned at `16eec52c23ceae4b2433813e1f92dfe9b3d8acda` (main, 2026-10-19).
- Vendor pages were checked on 2026-10-19 by reading public documentation only. No vendor account was signed in to, and no webhook, integration, MCP server or cloud resource was created.
- Line numbers refer to the pinned commit.

## Needl behaviour the manual relies on

| Manual statement | Source |
| --- | --- |
| Seven providers: GitLab, Linear, LaunchDarkly, Sentry, PostHog, Intercom, Stripe | `src/core/types.ts:1-9` |
| Card names, the Connections nav item, and the hash route `#/connections` | `apps/web/src/App.tsx:48-56`, `:87-98`, `:401` |
| Card button `Connect` / `Finish setup` / `Add another`; route rows with `Setup` and `Disconnect`; `secret saved in Needl` / `secret in server settings` / `no secret yet` | `apps/web/src/App.tsx:1010-1020` |
| Dialog: `Webhook URL` with `Copy`/`Copied`, steps, modes radiogroup `How webhooks are verified`, password secret field, `Generate`, `Paste this into the provider too`, `Save and start receiving` / `Replace secret`, `Then send a test:` | `apps/web/src/App.tsx:819-875` |
| Per-provider secret labels and modes (`Signing token` / `Secret token`; `Signing secret` / `Authorization header`), PostHog body template, Intercom topics | `apps/web/src/connectionGuides.ts:28-122` |
| Exact status texts (stored, duplicate, ignored, no_secret, rejected variants, retry) | `apps/web/src/connectionGuides.ts:124-140`, `apps/web/src/App.tsx:827-830` |
| Secret validation messages (whsec_ for GitLab signing token, PostHog signing secret, Stripe) | `apps/web/backend/connections.ts:9-24` |
| Connect creates a tenant-scoped route `int_<provider>_<12 hex>`, disabled until a secret is saved; saving enables it | `apps/web/backend/repository.ts:319-339`, `apps/web/backend/app.ts:206-220` |
| Deliveries to a route without a secret get 404 and record `no_secret` | `apps/web/backend/ingestion.ts:66-73` |
| Webhook URL = `NEEDL_PUBLIC_URL` (production `https://needl.dev`) + `/api/hooks/<id>` | `apps/web/backend/app.ts:199-203`, `apps/web/backend/repository.ts:363`, `docs/deployment.md` |
| Only `POST` is accepted on `/api/hooks/<id>`; other methods (including HEAD) fall through to `404 Unknown Needl endpoint` | `apps/web/backend/app.ts:170-176`, `:327` |
| Header names and signature schemes per adapter | `src/adapters/{gitlab,linear,launchdarkly,sentry,posthog,intercom,stripe}.ts` |
| Supported event names (used for the event selections) | `src/adapters/*.ts` lookup tables; `src/rules/catalogue.ts` |
| PostHog standard-webhooks verification strips `whsec_` and base64-decodes | `src/adapters/posthog.ts` (`verifyStandard`) |
| Stripe accepts snapshot `Event` objects only; thin payloads are malformed | `src/adapters/stripe.ts` (`stripePayload`), `docs/providers.md` (Stripe) |
| GitLab Duo flow panel is a separate connection (personal access token, flow, auto-launch) | `apps/web/src/App.tsx:880-973`, `apps/web/backend/flow-connection.ts` |
| A stored event can launch an opted-in flow (reason not to push just to test) | `apps/web/backend/app.ts:171-175` |

## Claude Code

| Fact | Source |
| --- | --- |
| `claude mcp add [options] <name> <url>`, `--transport http`, `--scope user`, `claude mcp list/get/remove`, `/mcp` sign-in, `Re-authenticate`, `claude mcp login/logout`, status markers `✔ Connected`, `! Needs authentication`, `✘ Failed to connect` | https://code.claude.com/docs/en/mcp |
| Flags verified locally with `claude mcp add --help`, `claude mcp --help` and `claude mcp login --help` (Claude Code 2.1.302). No server was added on this host. | local CLI help |

## Provider MCP servers (all official, vendor-hosted)

| Provider | Endpoint / auth | Webhook tools? | Source |
| --- | --- | --- | --- |
| GitLab | `https://gitlab.com/api/v4/mcp`, HTTP, OAuth DCR; GA in 19.5; Free tier since 19.2; group Owner setting `Allow connection to GitLab` (on by default) | No tool manages webhooks | https://docs.gitlab.com/user/model_context_protocol/mcp_server/ , https://docs.gitlab.com/user/model_context_protocol/mcp_server_tools/ , https://docs.gitlab.com/user/group/access_and_permissions/ |
| Linear | `https://mcp.linear.app/mcp`, Streamable HTTP, OAuth 2.1 (read-only variant `/mcp/readonly`) | None documented | https://linear.app/docs/mcp |
| LaunchDarkly | `https://mcp.launchdarkly.com/mcp/launchdarkly`, HTTP, OAuth; not on EU/federal; Writer/Developer role | Observability alert tools only (`create-alert`, …); no Integrations → Webhooks tool | https://launchdarkly.com/docs/home/getting-started/mcp-hosted , https://mcp.launchdarkly.com/mcp/launchdarkly |
| Sentry | `https://mcp.sentry.dev/mcp` (optional `/{org}/{project}`), HTTP, OAuth | None for integrations | https://mcp.sentry.dev/ |
| PostHog | `https://mcp.posthog.com/mcp`, HTTP, OAuth, region auto-routing | Not used; webhook *sources* ≠ destinations | https://posthog.com/docs/model-context-protocol/claude-code |
| Intercom | `https://mcp.intercom.com/mcp` (US), `https://mcp.eu.intercom.com/mcp` (EU), OAuth or bearer; AU unsupported; 14 tools | None | https://developers.intercom.com/docs/guides/mcp |
| Stripe | `https://mcp.stripe.com`, HTTP, OAuth (choose accounts/sandboxes) or agent API key; `stripe_api_write` can reach webhook endpoints / event destinations | Possible via generic API tool, deliberately not used | https://docs.stripe.com/mcp |

## Provider webhook interfaces

| Provider | Facts used | Source |
| --- | --- | --- |
| GitLab | Maintainer/Owner required; Settings → Webhooks → Add new webhook; `Generate signing token` (shown once, `whsec_`); Test dropdown; Recent events; disabled after 4 failures | https://docs.gitlab.com/user/project/integrations/webhooks/ |
| Linear | Workspace admin; Settings → API; `New webhook`; Label/URL; signing secret on the detail page; `Linear-Signature`; 60 s timestamp guidance; no test button | https://linear.app/developers/webhooks |
| LaunchDarkly | Organization settings → Integrations → Webhooks → `Add integration` → `Create a webhook`; Name/URL; `Sign this webhook`; policy (default: all flag changes in production); terms box; `Save settings`; one retry; no test button | https://launchdarkly.com/docs/home/infrastructure/webhooks |
| LaunchDarkly | `Secret` value appears after ticking `Sign this webhook` (*third-party guide*) | https://ngrok.com/docs/integrations/webhooks/launchdarkly-webhooks |
| Sentry | Internal integration auto-installs; resources issue/error/event_alert/metric_alert/installation; issue actions created/resolved/assigned/archived/unresolved; error webhooks Business/Enterprise only | https://docs.sentry.io/organization/integrations/integration-platform/internal-integration/ , https://docs.sentry.io/organization/integrations/integration-platform/webhooks/ , https://docs.sentry.io/organization/integrations/integration-platform/webhooks/issues/ , https://docs.sentry.io/organization/integrations/integration-platform/webhooks/errors/ |
| Sentry | Form labels `Custom Integrations` → `Create New Integration` → `Internal Integration` → `Next`, `Issue & Event: Read`, `issue` checkbox, `Save Changes`, Client Secret shown after save under Credentials (*third-party guides*) | https://docs.port.io/build-your-software-catalog/sync-data-to-catalog/apm-alerting/sentry/ , https://ngrok.com/docs/integrations/webhooks/sentry-webhooks |
| PostHog | Data pipelines → Destinations → `+ New` → `Destination` → search Webhook → `+ Create`; `Create & Enable`; Testing → `Start testing` → `Test function`; retries ≤3; quarantine | https://posthog.com/docs/cdp/destinations/webhook , https://posthog.com/docs/cdp/destinations |
| PostHog | Template `HTTP Webhook` (`free: false`), inputs `Webhook URL`, `Method`, `JSON Body`, `Headers`, `Secret headers`, `Signing secret` (Standard Webhooks, user-supplied), `Log responses`; secret must be base64 (optional `whsec_`) and at least 24 bytes | PostHog source at commit `fe9924edba3ddd857c844808fb8fd657b73357d2`: `nodejs/src/cdp/templates/_destinations/webhook/webhook.template.ts`, `nodejs/src/cdp/utils/standard-webhooks.ts` |
| Intercom | Developer Hub → app → Configure → Webhooks; HTTPS; HEAD validation; topics dropdown; permissions on the Authentication page; `Save`; client secret on Basic Info; `X-Hub-Signature: sha1=`; ping always subscribed; 5000 ms; suspension after 7 days (private apps), `Set live` | https://developers.intercom.com/docs/webhooks/setting-up-webhooks , https://developers.intercom.com/docs/references/1.1/webhooks/webhook-models , https://developers.intercom.com/docs/webhooks/webhook-notifications , https://developers.intercom.com/docs/build-an-integration/getting-started |
| Intercom | `Send a test request` button (*third-party guide*) | https://ngrok.com/docs/integrations/webhooks/intercom-webhooks |
| Stripe | Workbench Webhooks → `Create an event destination` → `Your account` → Thin/Snapshot (+API version) → events → `Continue` → `Webhook endpoint` → `Continue` → Endpoint URL; `Reveal secret` (`whsec_`); `stripe trigger payment_intent.succeeded` in Shell or CLI; CLI `stripe listen` secret differs | https://docs.stripe.com/webhooks |
| Stripe | Shell: Developers → Workbench → Shell tab; read-only in live mode; sandboxes via the account picker | https://docs.stripe.com/workbench/shell , https://docs.stripe.com/sandboxes |

## Not verified

- No authenticated vendor UI was exercised. Labels marked *third-party guide* above are not stated in vendor docs.
- Intercom HEAD validation against Needl was inferred from code and not tried live.
- The exact output text of `claude mcp add` / `claude mcp login` on the user's Mac version.
- Whether PostHog Cloud already ships the `Signing secret` input from the source commit above, and PostHog plan gating.
- The Intercom `ping` payload passing Needl's schema (`type`, `id`, `topic`, `app_id`, `data.item`) was inferred from the documented notification shape.
