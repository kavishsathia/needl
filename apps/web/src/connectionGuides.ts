import type { Provider } from "../../../src/core/types.js";

/** One way to verify a provider's webhooks, when it offers more than one. */
export interface SecretMode {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** Needl can generate this secret for you to paste into the provider. */
  readonly generate?: "whsec" | "token";
}

export interface ConnectionGuide {
  readonly provider: Provider;
  readonly steps: readonly string[];
  /** What the provider calls its signing secret. */
  readonly secretLabel: string;
  readonly modes?: readonly SecretMode[];
  /** Text to paste into the provider, such as PostHog's webhook body. */
  readonly template?: { readonly label: string; readonly text: string };
  readonly test?: string;
}

/**
 * Setup steps per provider. Menu names change over time, so steps name the destination and what to copy rather than
 * every click; the provider documentation linked in docs/providers.md is the reference.
 */
export const connectionGuides: Readonly<Record<Provider, ConnectionGuide>> = {
  gitlab: {
    provider: "gitlab",
    steps: [
      "In your GitLab project, open Settings → Webhooks and add a new webhook.",
      "Paste the webhook URL above.",
      "Under Trigger, select the events your rules use: Push, Pipeline, Deployment, Merge request and Issue events.",
      "If GitLab offers a signing token (GitLab 19 and later), copy it. Otherwise type a secret token into GitLab — or generate one here and paste it there.",
    ],
    secretLabel: "Signing token or secret token",
    modes: [
      { id: "signing-token", label: "Signing token", hint: "Recommended. GitLab signs each delivery; the token starts with whsec_." },
      { id: "secret-token", label: "Secret token", hint: "Older GitLab versions send this token in a header with each delivery.", generate: "token" },
    ],
    test: "Use Test → Push events on the saved webhook.",
  },
  sentry: {
    provider: "sentry",
    steps: [
      "In Sentry, open Settings → Developer Settings → Custom Integrations and create an internal integration.",
      "Paste the webhook URL above and turn on Alert Rule Action if you want alert rules to send events.",
      "Under Webhooks, subscribe to issue and error events, then save.",
      "Copy the integration's Client Secret.",
    ],
    secretLabel: "Client Secret",
    test: "Resolve and unresolve an issue, or trigger an alert rule that uses this integration.",
  },
  stripe: {
    provider: "stripe",
    steps: [
      "In the Stripe Dashboard, open Developers → Webhooks (Workbench) and add a destination.",
      "Choose Snapshot payloads and select the events your rules use, e.g. invoice.paid, charge.succeeded, customer.subscription.deleted.",
      "Paste the webhook URL above as the endpoint.",
      "Copy the destination's signing secret (it starts with whsec_).",
    ],
    secretLabel: "Signing secret",
    test: "Use Send test event on the destination, or the Stripe CLI: stripe trigger invoice.paid.",
  },
  linear: {
    provider: "linear",
    steps: [
      "In Linear, open Settings → API → Webhooks (workspace admin) and create a webhook.",
      "Paste the webhook URL above and choose the team or all public teams.",
      "Select Issues, Comments and Issue SLAs.",
      "Copy the webhook's signing secret.",
    ],
    secretLabel: "Signing secret",
    test: "Change an issue's state in the selected team.",
  },
  launchdarkly: {
    provider: "launchdarkly",
    steps: [
      "In LaunchDarkly, open Integrations → Webhooks and add a webhook.",
      "Paste the webhook URL above and turn on Sign this webhook.",
      "Optionally add a policy so only the projects and environments you care about send events.",
      "Copy the signing secret LaunchDarkly shows.",
    ],
    secretLabel: "Signing secret",
    test: "Toggle a flag in an environment the policy allows.",
  },
  posthog: {
    provider: "posthog",
    steps: [
      "In PostHog, open Data pipelines → Destinations and create a Webhook destination.",
      "Paste the webhook URL above, method POST.",
      "Replace the body with the JSON below.",
      "If PostHog shows a signing secret, copy it. Otherwise add an Authorization header to the destination with Bearer and a token you generate here.",
    ],
    secretLabel: "Signing secret or header token",
    modes: [
      { id: "standard-webhooks", label: "Signing secret", hint: "Recommended. PostHog signs each delivery; the secret starts with whsec_." },
      { id: "shared-header", label: "Authorization header", hint: "Add the header Authorization: Bearer <token> to the destination. This proves the sender, but does not sign the body.", generate: "token" },
    ],
    template: {
      label: "Webhook body",
      text: `{
  "event": "{event}",
  "project_id": "{project.id}",
  "relationships": []
}`,
    },
    test: "Use the destination's test button, or capture an event that matches its filters.",
  },
  intercom: {
    provider: "intercom",
    steps: [
      "In the Intercom Developer Hub, open your app → Webhooks.",
      "Paste the webhook URL above as the endpoint.",
      "Select the topics your rules use: conversation.user.created, conversation.admin.replied, conversation.admin.closed, ticket.created, ticket.updated, contact.created, contact.updated.",
      "Copy the app's Client secret from Basic information — Intercom signs webhooks with it.",
    ],
    secretLabel: "Client secret",
    test: "Use Send test request in the webhook settings, or reply to a conversation.",
  },
};

/** What the last delivery outcome means for the person setting things up. */
export function deliveryExplanation(outcome: string | undefined, detail: string | undefined): { readonly tone: "ok" | "waiting" | "error" | "warning"; readonly text: string } {
  switch (outcome) {
    case undefined: return { tone: "waiting", text: "Waiting for the first webhook…" };
    case "stored": return { tone: "ok", text: `Receiving events${detail === undefined ? "" : ` · last: ${detail}`}` };
    case "duplicate": return { tone: "ok", text: "Receiving events · last one was a retry Needl already had" };
    case "ignored": return { tone: "warning", text: `Connected and verified, but the last event isn't one Needl reads${detail === undefined ? "" : ` (${detail.replace("unknown_event: ", "")})`}. Select the events listed in the steps.` };
    case "no_secret": return { tone: "warning", text: "Webhooks are arriving. Save the signing secret below to start verifying them." };
    case "rejected":
      if (detail === "unauthenticated") return { tone: "error", text: "A webhook arrived but its signature didn't match. The secret saved here is different from the one in the provider — copy it again." };
      if (detail === "stale") return { tone: "error", text: "A webhook arrived with an old timestamp. Check this server's clock, or ignore it if the provider was retrying an old delivery." };
      if (detail === "malformed") return { tone: "error", text: "A webhook arrived but wasn't in the expected format. Check the webhook type and, for PostHog, the body template." };
      if (detail === "payload_too_large") return { tone: "error", text: "A webhook arrived but was larger than Needl accepts (1 MiB)." };
      return { tone: "error", text: `A webhook was rejected (${detail ?? "unknown reason"}).` };
    case "retry": return { tone: "error", text: "A webhook arrived but couldn't be stored; the provider will retry it." };
    default: return { tone: "warning", text: `Last delivery: ${outcome}` };
  }
}
