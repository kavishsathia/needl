# Synthetic fixture provenance

Every JSON file in this directory is synthetic. Names, IDs, URLs, amounts, and timestamps were invented for tests; no live or sandbox customer payload was captured.

Shapes were derived from official documentation reviewed on 2026-10-14:

- `gitlab-pipeline.json` — [GitLab webhook events](https://docs.gitlab.com/user/project/integrations/webhook_events/)
- `linear-issue.json` — [Linear webhook payload](https://linear.app/developers/webhooks)
- `launchdarkly-flag.json` — [LaunchDarkly webhook/audit entry](https://launchdarkly.com/docs/api/webhooks)
- `sentry-issue.json` — [Sentry Integration Platform webhooks](https://docs.sentry.io/organization/integrations/integration-platform/webhooks/)
- `posthog-event.json` — [PostHog configurable webhook destination](https://posthog.com/docs/cdp/destinations/webhook), using the Needl template documented in `docs/providers.md`
- `intercom-ticket.json` — [Intercom webhook topics](https://developers.intercom.com/docs/references/webhooks/webhook-models)
- `stripe-payment.json` — [Stripe Event object and webhook handling](https://docs.stripe.com/webhooks)

Signatures are generated at test runtime from plainly synthetic test-only secrets.

