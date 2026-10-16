# Provider coverage and setup

Documentation was reviewed on 2026-10-14. Provider behavior changes; re-check the linked official source before production rollout. No live accounts, real webhook registrations, or external mutations were used for this implementation.

## Common configuration

Every adapter accepts:

- `secrets`: non-empty array ordered current first, followed by previous keys accepted during a rotation window.
- `enabledEvents`: optional exact normalized provider event names. Omit to accept every event this adapter supports.
- `kindMappings`: optional map from exact provider event name to a caller-owned normalized kind.
- `payloadRetention`: `"projection"` by default, or explicit `"full"` to attach the exact authenticated UTF-8 JSON for a controlled evidence store.
- `clock`: injectable clock for deterministic verification.

Unknown authenticated events return `ignored/unknown_event`; configured-out events return `ignored/not_subscribed`. Neither is classified as malformed.

### Evidence policy

The normalized event always keeps identifiers, statuses/actions needed to interpret the observation, explicit relationship values with source paths, safe evidence URLs, and a SHA-256 digest of the authenticated raw body. Exact JSON retention is opt-in with `payloadRetention: "full"` because provider bodies can contain personal or sensitive customer data. Use that mode only with encryption, retention limits, access control, and redaction appropriate to the tenant; the package never logs it.

## Coverage summary

| Provider | Authentication | Implemented event surface | Delivery identity |
| --- | --- | --- | --- |
| GitLab | Standard Webhooks HMAC-SHA256 signing token, or explicit legacy `X-Gitlab-Token` mode | push, pipeline, deployment, merge request, issue | `webhook-id`, then `Idempotency-Key`, then event UUID |
| Linear | raw-body HMAC-SHA256 plus payload timestamp window | Issue, Comment, IssueSLA actions | `Linear-Delivery`, then `webhookId` |
| LaunchDarkly | raw-body HMAC-SHA256 | flag, environment, project audit entries | audit entry `_id` |
| Sentry | raw-body HMAC-SHA256 with integration client secret | issue, event alert, error, metric alert | `Request-ID`, otherwise normalized body identity |
| PostHog | Standard Webhooks signing, or an explicitly configured shared header | any analytics event matching the documented Needl destination template | `webhook-id`, then event `uuid` |
| Intercom | `sha1=`-prefixed raw-body HMAC-SHA1 | selected conversation, ticket, and contact topics | notification `id` |
| Stripe | timestamped `v1` HMAC-SHA256 | selected snapshot payment, charge, dispute, invoice, subscription events | Event `id` |

## GitLab

Official sources: [webhook configuration, security, delivery, and retries](https://docs.gitlab.com/user/project/integrations/webhooks/), [event payloads](https://docs.gitlab.com/user/project/integrations/webhook_events/).

Setup:

1. Create a project webhook as a Maintainer/Owner, or a group webhook as an Owner.
2. On GitLab 19.0+ configure a signing token and set `authMode: "signing-token"`. Signing became generally available in 19.1 according to the current docs.
3. For versions without signing-token support, configure a secret token and explicitly set `authMode: "secret-token"`.
4. Subscribe only to Push, Pipeline, Deployment, Merge request, and Issue events needed by the backend.

Signing-token mode implements Standard Webhooks exactly: `webhook-id.webhook-timestamp.rawBody`, a base64-decoded `whsec_` key, and one or more space-separated `v1,<base64>` signatures. The timestamp tolerance defaults to 300 seconds. It does not silently accept `X-Gitlab-Token` when a signature is absent or invalid. For zero-downtime migration, run separately configured legacy and signed routes or change the explicit route mode only after signed deliveries are confirmed.

Normalized event names include an action/status when present, such as `pipeline.success`, `merge_request.merge`, `issue.update`, and `deployment.success`; otherwise they are `push`, `pipeline`, `deployment`, `merge_request`, or `issue`.

Evidence includes project/repository, commit, ref, and environment identifiers only when present. Issue or merge-request state is an observation; the adapter never turns `closed` or `merged` into a claim that some other incident was fixed.

GitLab retry behavior and webhook disabling vary with version and response class. Current docs identify `webhook-id`/`Idempotency-Key` as stable across retries and describe temporary disablement after four failures and permanent disablement after forty consecutive failures. Treat ordering as unconstrained. Rotate by supplying `[new, old]`, updating GitLab, observing signed traffic, then removing `old`.

Unsupported: notes/comments, jobs, releases, tags as a distinct mapping, members, system hooks, custom templates with a different required shape, and all other hook types. Authenticated unsupported hooks are ignored explicitly.

## Linear

Official source: [Linear webhooks](https://linear.app/developers/webhooks).

Setup requires a workspace admin, or an OAuth application with `admin` scope, to create/read webhooks. Configure a team or all-public-teams webhook and select the resource types needed by the backend.

The adapter verifies `Linear-Signature` as the hex HMAC-SHA256 of exact raw bytes, then requires `webhookTimestamp` within 60 seconds by default. It supports:

- `Issue.create`, `Issue.update`, `Issue.remove`
- `Comment.create`, `Comment.update`, `Comment.remove`
- `IssueSLA.<action>` including provider actions such as `set`, `highRisk`, and `breached`

Issue identifier, team, project, and comment-to-issue relationships are preserved only from explicit fields. Issue events also keep the workflow state's name and type (`stateName`, `stateType`, from `data.state`) and whether this update changed the state (`stateChanged`, from `updatedFrom.stateId`). `updatedFrom` is kept as bounded change evidence; changing a workflow state is not interpreted as a fix.

Linear documents a five-second response deadline and up to three retries after roughly 1 minute, 1 hour, and 6 hours. Deduplicate using `Linear-Delivery`. Rotate with `[new, old]` for the shortest practical overlap.

Unsupported: the other currently available Linear data-change models, OAuth revocation, attachments, labels, reactions, projects, cycles, customers, and customer requests.

## LaunchDarkly

Official sources: [webhook setup/signing](https://launchdarkly.com/docs/home/infrastructure/webhooks), [payload and retry behavior](https://launchdarkly.com/docs/api/webhooks), [audit log schema](https://launchdarkly.com/docs/api/audit-log/get-audit-log-entry).

Create a webhook under organization Integrations, enable signing, and add policy statements that restrict events to relevant projects/environments/flags. Available UI, roles, and plan entitlements can vary; use the least-privileged role that can manage the integration in your account.

`X-LD-Signature` is verified as a hex HMAC-SHA256 over raw bytes. The payload is an audit-log entry. The adapter covers `flag.<actions>`, `environment.<actions>`, and `project.<actions>`, with all `accesses[].resource` values preserved as explicit LaunchDarkly resource specifiers. It does not derive the enabled state from prose such as `titleVerb`; if state matters, include and validate an explicit field in a future mapping.

LaunchDarkly says delivery can be out of chronological order, recommends the payload `date` for reordering, retries a non-2xx response once, and does not guarantee delivery. Rotate by overlapping `[new, old]` while updating the webhook secret.

Unsupported: member/account/integration audit kinds and detailed interpretation of JSON/semantic patches.

## Sentry

Official sources: [Integration Platform webhooks](https://docs.sentry.io/organization/integrations/integration-platform/webhooks/), [custom integration representation and event subscriptions](https://docs.sentry.io/api/integration/retrieve-the-custom-integrations-created-by-an-organization/).

Create an internal/custom integration, set the webhook URL, subscribe only to needed webhook events, and copy the integration client secret. Choose read scopes appropriate to the selected resources (for example `event:read` and `org:read` where required); this receiver itself makes no Sentry API calls.

The adapter verifies `Sentry-Hook-Signature` as a hex HMAC-SHA256 over raw bytes. `Sentry-Hook-Resource` selects these slices:

- `issue.<action>` with issue/project/status evidence
- `event_alert.<action>` with event/project/release/environment evidence
- `error.<action>` when an error object is present
- `metric_alert.<action>` with alert-rule evidence

Sentry does not provide a provider delivery ID in every documented example; `Request-ID` is used when supplied and the normalized content identity is the fallback. Do not assume a retry count or ordering guarantee not stated by the account's current Sentry documentation. The durable receiver is idempotent for redelivery. Rotate the integration client secret with `[new, old]` only if the Sentry configuration permits an overlap; otherwise coordinate a short route/config cutover.

Unsupported: comments, installation lifecycle as an observation, external issue actions, and arbitrary new resource types.

## PostHog

Official sources: [webhook destination configuration and signing](https://posthog.com/docs/cdp/destinations/webhook), [destination retry/health behavior](https://posthog.com/docs/cdp/destinations).

PostHog destinations are configurable, so there is no universal body shape. Configure this JSON body contract:

```json
{
  "event": "{event}",
  "project_id": "<hard-coded PostHog project id>",
  "relationships": []
}
```

The `{event}` object must expose `uuid`, `event`, and optionally `timestamp`, `distinct_id`, and `properties`. `relationships` is an optional Needl-specific array of explicit `{ "type", "id", "url" }` objects. Do not derive business relationships from arbitrary analytics properties.

Current PostHog documentation exposes an optional Signing secret following Standard Webhooks. Use `authentication: { mode: "standard-webhooks" }` with a `whsec_` secret when available. This is not treated as an undocumented built-in assumption: the alternative is an explicitly configured destination header, for example `Authorization: Bearer <secret>`, with `mode: "shared-header"`, `headerName`, and `prefix`. Shared-header mode authenticates possession but does not cryptographically bind the body; prefer Standard Webhooks.

PostHog says non-OK destination calls can be retried up to three times depending on status and unhealthy/slow destinations may be quarantined or disabled. Destination filters are the primary subscription control; `enabledEvents` is a receiver-side second boundary. Rotate Standard Webhooks keys with `[new, old]`; for a shared header, coordinate the destination header and overlap only if two destinations/routes are available.

Unsupported: arbitrary custom destination body templates, person snapshots, and any claim that PostHog supplies a stable delivery ID in shared-header mode beyond the event `uuid` included by this required template.

## Intercom

Official sources: [setup and permissions](https://developers.intercom.com/docs/webhooks/setting-up-webhooks), [notification signing and response behavior](https://developers.intercom.com/docs/references/1.1/webhooks/webhook-models), [ordering and duplicates](https://developers.intercom.com/docs/webhooks/webhook-notifications), [topic schemas](https://developers.intercom.com/docs/references/webhooks/webhook-models).

Configure an HTTPS endpoint in the app Developer Hub (it must accept Intercom's validation `HEAD` during real registration), select topics, and grant their displayed permissions. Public apps require approved scopes; private apps access their own workspace. Notifications for an app can span every workspace where it is installed, so `app_id` is retained as source scope and tenant routing must still be configured correctly.

Intercom signs raw bytes with the app `client_secret` using HMAC-SHA1 and sends `X-Hub-Signature: sha1=<hex>`. SHA-1 here follows the provider protocol; it is used only as an HMAC verifier.

Covered topics:

- `conversation.user.created`
- `conversation.admin.replied`
- `conversation.admin.closed`
- `ticket.created`, `ticket.updated`
- `contact.created`, `contact.updated`

The notification ID is the delivery identity. Intercom documents no ordering guarantee, recommends checking `created_at`, and can deliver duplicates when a 200 is not received within five seconds. Its current docs describe retry/throttle behavior by response class; do not return 410 unless intentionally disabling a subscription. Rotate the app client secret through a coordinated configuration window; `[new, old]` accepts either at the receiver.

Unsupported: all other topics, translated-reply variants, deletion-specific schemas, content stats, and data connector execution events.

## Stripe

Official sources: [receive webhook events](https://docs.stripe.com/webhooks), [signature verification](https://docs.stripe.com/events/manage-webhook-endpoints), [snapshot event types](https://docs.stripe.com/api/events/types).

Create a webhook event destination in Workbench, select Snapshot payloads and only required event types, then copy that endpoint's `whsec_` secret. Live registered endpoints require public HTTPS/TLS 1.2 or later. The local Stripe CLI uses a different signing secret from a Workbench endpoint.

The adapter verifies every `v1` candidate in `Stripe-Signature` against `HMAC-SHA256(secret, timestamp + "." + rawBody)` and enforces a 300-second tolerance by default. It handles multiple signatures and multiple rotation secrets.

Covered snapshot events:

- `payment_intent.succeeded`, `payment_intent.payment_failed`
- `charge.succeeded`, `charge.failed`, `charge.dispute.created`
- `invoice.paid`, `invoice.payment_failed`
- `customer.subscription.updated`, `customer.subscription.deleted`

Customer, payment intent, invoice, subscription, and charge relationships are included only from direct object fields. Event ID is the delivery identity. Stripe documents occasional duplicates, no ordering guarantee, and automatic live-mode retries for up to three days with exponential backoff (sandbox retries are shorter). Use Event IDs for duplicate delivery and retrieve missing resources separately if order-independent business processing needs them.

Stripe supports secret rolling in Workbench; retain old and new values during its overlap. This implementation supports snapshot events only. Thin v2 event notifications require a different schema and usually authenticated read-only hydration, which is intentionally not implemented.

## Operational notes

- Default maximum payload: 1 MiB; set a provider-appropriate lower or higher value deliberately.
- Put TLS termination and any IP allowlisting in front of the example server. Signature verification remains mandatory.
- A 503 means durable persistence did not complete and must not be converted to 2xx by upstream middleware.
- SQLite is appropriate for the local example and single-process evaluation. Use a transactional shared store implementing `DeduplicatingEventSink` for horizontally scaled production receivers.
- Provider delivery order is not a causal order. Consumers should use explicit identifiers and `occurredAt`, and tolerate late observations.
- Replay emits stored observations to a caller callback. It never invokes provider APIs or agent actions.
