import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";

export type SimulatedProvider = "gitlab" | "sentry" | "stripe";

export interface FieldSpec {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
}

export interface SignedDelivery {
  readonly provider: SimulatedProvider;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface EventSpec {
  readonly id: string;
  readonly provider: SimulatedProvider;
  readonly label: string;
  readonly description: string;
  readonly fields: readonly FieldSpec[];
  build(fields: Readonly<Record<string, string>>, at: Date, secret: string): SignedDelivery;
}

function required(fields: Readonly<Record<string, string>>, id: string): string {
  const value = fields[id]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`Field ${id} is required`);
  return value;
}

/** GitLab signing tokens and other Standard Webhooks senders: HMAC-SHA256 over `id.timestamp.body`, keyed by the decoded `whsec_` secret. */
function standardWebhookHeaders(secret: string, body: string, at: Date): Record<string, string> {
  if (!secret.startsWith("whsec_")) throw new Error("Standard Webhooks secrets must start with whsec_");
  const id = `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(at.getTime() / 1_000));
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` };
}

function sentryHeaders(secret: string, body: string, resource: string, at: Date): Record<string, string> {
  return {
    "content-type": "application/json",
    "request-id": randomUUID(),
    "sentry-hook-resource": resource,
    "sentry-hook-timestamp": String(Math.floor(at.getTime() / 1_000)),
    "sentry-hook-signature": createHmac("sha256", secret).update(body).digest("hex"),
  };
}

function stripeHeaders(secret: string, body: string, at: Date): Record<string, string> {
  const timestamp = Math.floor(at.getTime() / 1_000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` };
}

/** GitLab formats hook times as `2026-10-15 10:00:00 +0000`. */
function gitlabTime(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace("T", " ")} +0000`;
}

const project = {
  id: 7,
  name: "shop",
  web_url: "https://gitlab.example.com/acme/shop",
  path_with_namespace: "acme/shop",
  default_branch: "main",
};

function sentryIssue(action: "resolved" | "unresolved", fields: Readonly<Record<string, string>>, at: Date, secret: string): SignedDelivery {
  const issueId = required(fields, "issueId");
  const title = fields.title?.trim() || "CheckoutError: card token expired";
  const body = JSON.stringify({
    action,
    actor: { id: "sentry", name: "Sentry", type: "application" },
    data: {
      issue: {
        id: issueId,
        shortId: `SHOP-${issueId.slice(-3)}`,
        title,
        culprit: "checkout/payment.ts in submitPayment",
        permalink: `https://acme.sentry.io/issues/${issueId}/`,
        level: "error",
        status: action,
        project: { id: "12", name: "shop", slug: "shop", platform: "node" },
        firstSeen: new Date(at.getTime() - 86_400_000).toISOString(),
        lastSeen: at.toISOString(),
      },
    },
    installation: { uuid: "simulated-sentry-installation" },
  });
  return { provider: "sentry", body, headers: sentryHeaders(secret, body, "issue", at) };
}

export const events: readonly EventSpec[] = [
  {
    id: "gitlab.deploy",
    provider: "gitlab",
    label: "Deploy a branch",
    description: "Deployment Hook with status success.",
    fields: [
      { id: "branch", label: "Branch", placeholder: "eng-42-fix-retry-loop" },
      { id: "environment", label: "Environment", placeholder: "production" },
    ],
    build(fields, at, secret) {
      const ref = required(fields, "branch");
      const environment = required(fields, "environment");
      const sha = randomBytes(20).toString("hex");
      const deploymentId = randomInt(100_000, 999_999);
      const body = JSON.stringify({
        object_kind: "deployment",
        status: "success",
        status_changed_at: gitlabTime(at),
        deployment_id: deploymentId,
        deployable_id: deploymentId + 1,
        deployable_url: `${project.web_url}/-/jobs/${deploymentId + 1}`,
        environment,
        environment_tier: environment === "production" ? "production" : "staging",
        environment_slug: environment,
        project,
        short_sha: sha.slice(0, 8),
        user: { id: 1, name: "Needl Simulator", username: "needl-simulator" },
        commit_url: `${project.web_url}/-/commit/${sha}`,
        commit_title: `Merge branch '${ref}'`,
        ref,
      });
      return {
        provider: "gitlab",
        body,
        headers: { "content-type": "application/json", "x-gitlab-event": "Deployment Hook", ...standardWebhookHeaders(secret, body, at) },
      };
    },
  },
  {
    id: "sentry.error",
    provider: "sentry",
    label: "Error event alert",
    description: "event_alert.triggered with linear_issue and environment tags.",
    fields: [
      { id: "issueKey", label: "linear_issue tag", placeholder: "ENG-42" },
      { id: "environment", label: "Environment", placeholder: "production" },
      { id: "title", label: "Title", placeholder: "CheckoutError: retry loop" },
    ],
    build(fields, at, secret) {
      const eventId = randomBytes(16).toString("hex");
      const issueId = String(randomInt(1_000_000_000, 1_999_999_999));
      const body = JSON.stringify({
        action: "triggered",
        actor: { id: "sentry", name: "Sentry", type: "application" },
        data: {
          event: {
            event_id: eventId,
            issue_id: issueId,
            issue_url: `https://acme.sentry.io/api/0/issues/${issueId}/`,
            project: 12,
            release: null,
            timestamp: at.getTime() / 1_000,
            title: fields.title?.trim() || "CheckoutError: retry loop",
            url: `https://acme.sentry.io/api/0/projects/acme/shop/events/${eventId}/`,
            web_url: `https://acme.sentry.io/organizations/acme/issues/${issueId}/events/${eventId}/`,
            tags: [
              ["environment", required(fields, "environment")],
              ["linear_issue", required(fields, "issueKey")],
              ["runtime", "node"],
            ],
          },
          triggered_rule: "Checkout errors",
        },
        installation: { uuid: "simulated-sentry-installation" },
      });
      return { provider: "sentry", body, headers: sentryHeaders(secret, body, "event_alert", at) };
    },
  },
  {
    id: "sentry.resolve",
    provider: "sentry",
    label: "Resolve an issue",
    description: "issue webhook with action resolved.",
    fields: [{ id: "issueId", label: "Issue ID", placeholder: "4815" }],
    build: (fields, at, secret) => sentryIssue("resolved", fields, at, secret),
  },
  {
    id: "sentry.unresolve",
    provider: "sentry",
    label: "Issue comes back",
    description: "issue webhook with action unresolved.",
    fields: [{ id: "issueId", label: "Issue ID", placeholder: "4815" }],
    build: (fields, at, secret) => sentryIssue("unresolved", fields, at, secret),
  },
  {
    id: "stripe.cancel",
    provider: "stripe",
    label: "Cancel a subscription",
    description: "customer.subscription.deleted.",
    fields: [{ id: "customer", label: "Customer", placeholder: "cus_acme" }],
    build(fields, at, secret) {
      const customer = required(fields, "customer");
      const body = JSON.stringify({
        id: `evt_${randomBytes(12).toString("hex")}`,
        object: "event",
        api_version: "2025-09-30.clover",
        created: Math.floor(at.getTime() / 1_000),
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: `sub_${randomBytes(8).toString("hex")}`,
            object: "subscription",
            customer,
            status: "canceled",
            canceled_at: Math.floor(at.getTime() / 1_000),
            description: "Pro plan",
          },
        },
      });
      return { provider: "stripe", body, headers: stripeHeaders(secret, body, at) };
    },
  },
  {
    id: "stripe.invoice-paid",
    provider: "stripe",
    label: "Charge a customer",
    description: "invoice.paid.",
    fields: [
      { id: "customer", label: "Customer", placeholder: "cus_acme" },
      { id: "amount", label: "Amount (cents)", placeholder: "4900" },
    ],
    build(fields, at, secret) {
      const customer = required(fields, "customer");
      const amount = Number(fields.amount?.trim() || "4900");
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Amount must be a positive whole number of cents");
      const invoice = `in_${randomBytes(8).toString("hex")}`;
      const body = JSON.stringify({
        id: `evt_${randomBytes(12).toString("hex")}`,
        object: "event",
        api_version: "2025-09-30.clover",
        created: Math.floor(at.getTime() / 1_000),
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        type: "invoice.paid",
        data: {
          object: {
            id: invoice,
            object: "invoice",
            customer,
            amount_paid: amount,
            currency: "usd",
            status: "paid",
            hosted_invoice_url: `https://invoice.stripe.com/i/${invoice}`,
            description: "Pro plan renewal",
          },
        },
      });
      return { provider: "stripe", body, headers: stripeHeaders(secret, body, at) };
    },
  },
];

export interface StoryStep {
  readonly event: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface Story {
  readonly id: string;
  readonly template: string;
  readonly variant: "violation" | "healthy";
  readonly label: string;
  /** Fresh identifiers every play, so each run is its own monitor instance. */
  steps(): readonly StoryStep[];
}

const issueKey = () => `ENG-${randomInt(100, 1_000)}`;
const issueNumber = () => String(randomInt(1_000_000, 9_999_999));
const customerId = () => `cus_${randomBytes(7).toString("hex")}`;

export const stories: readonly Story[] = [
  {
    id: "ghost.violation",
    template: "No ghosts",
    variant: "violation",
    label: "Ship ENG-n, then its error comes back",
    steps(): readonly StoryStep[] {
      const key = issueKey();
      return [
        { event: "gitlab.deploy", fields: { branch: `${key.toLowerCase()}-fix-retry-loop`, environment: "production" } },
        { event: "sentry.error", fields: { issueKey: key, environment: "production", title: "CheckoutError: retry loop" } },
      ];
    },
  },
  {
    id: "ghost.healthy",
    template: "No ghosts",
    variant: "healthy",
    label: "Ship ENG-n, then a different issue errors",
    steps(): readonly StoryStep[] {
      const key = issueKey();
      const other = issueKey();
      return [
        { event: "gitlab.deploy", fields: { branch: `${key.toLowerCase()}-fix-retry-loop`, environment: "production" } },
        { event: "sentry.error", fields: { issueKey: other === key ? `${key}0` : other, environment: "production", title: "AvatarError: upload timeout" } },
      ];
    },
  },
  {
    id: "boomerang.violation",
    template: "Boomerang",
    variant: "violation",
    label: "Resolve an issue, then it comes back",
    steps(): readonly StoryStep[] {
      const id = issueNumber();
      return [
        { event: "sentry.resolve", fields: { issueId: id } },
        { event: "sentry.unresolve", fields: { issueId: id } },
      ];
    },
  },
  {
    id: "boomerang.healthy",
    template: "Boomerang",
    variant: "healthy",
    label: "Resolve an issue, then a different one comes back",
    steps(): readonly StoryStep[] {
      return [
        { event: "sentry.resolve", fields: { issueId: issueNumber() } },
        { event: "sentry.unresolve", fields: { issueId: issueNumber(), title: "SearchError: index unavailable" } },
      ];
    },
  },
  {
    id: "clean-break.violation",
    template: "Clean break",
    variant: "violation",
    label: "Cancel a customer, then charge them",
    steps(): readonly StoryStep[] {
      const customer = customerId();
      return [
        { event: "stripe.cancel", fields: { customer } },
        { event: "stripe.invoice-paid", fields: { customer, amount: "4900" } },
      ];
    },
  },
  {
    id: "clean-break.healthy",
    template: "Clean break",
    variant: "healthy",
    label: "Cancel a customer, then charge someone else",
    steps(): readonly StoryStep[] {
      return [
        { event: "stripe.cancel", fields: { customer: customerId() } },
        { event: "stripe.invoice-paid", fields: { customer: customerId(), amount: "4900" } },
      ];
    },
  },
];

export function findEvent(id: string): EventSpec {
  const spec = events.find((candidate) => candidate.id === id);
  if (spec === undefined) throw new Error(`Unknown simulated event ${id}`);
  return spec;
}

export function findStory(id: string): Story {
  const story = stories.find((candidate) => candidate.id === id);
  if (story === undefined) throw new Error(`Unknown story ${id}`);
  return story;
}

export function generateSecrets(): Readonly<Record<SimulatedProvider, string>> {
  return {
    gitlab: `whsec_${randomBytes(32).toString("base64")}`,
    sentry: randomBytes(32).toString("hex"),
    stripe: `whsec_${randomBytes(24).toString("hex")}`,
  };
}
