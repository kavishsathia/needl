import type { Provider } from "../core/types.js";
import type { ValueSource } from "../ltl/assertion.js";

/**
 * Native vocabulary of each integration: the events its adapter accepts and the fields it reliably extracts.
 * Nothing here is a canonical cross-provider shape; a rule names `gitlab.deployment` or `stripe.invoice.paid` directly.
 * Every field reads only what the adapter writes into the normalized event (projection mode), so a rule can never
 * depend on data Needl does not keep.
 */

export type FieldType = "string" | "number" | "boolean";

export interface FieldOption {
  readonly value: string | number | boolean;
  /** How the value reads inside a sentence, e.g. "successful" for a deployment status of "success". */
  readonly label: string;
}

/** Where a field's possible values come from, used for suggestions and for checking literals. */
export type FieldValues =
  /** Closed set documented by the provider; literals outside it are rejected. */
  | { readonly kind: "fixed"; readonly options: readonly FieldOption[] }
  /** Open set; suggestions come from events this workspace has received. */
  | { readonly kind: "observed" }
  /** Identifiers that are only meaningful bound from another event (ids, keys); no suggestions. */
  | { readonly kind: "identifier" };

/** How a field is read from a normalized event. */
export type FieldRead =
  /** Typed value at a path in the normalized event; numbers and booleans keep their type. */
  | { readonly from: "path"; readonly segments: readonly string[] }
  /** Text value from a value source (subject, relationship, …). */
  | { readonly from: "source"; readonly source: ValueSource };

export interface CatalogueField {
  /** Name used in rules, e.g. `environment` or `ref.issue_key`. */
  readonly name: string;
  /** Noun phrase used when a rule is read back, e.g. "environment". */
  readonly label: string;
  readonly type: FieldType;
  readonly description: string;
  readonly read: FieldRead;
  readonly values: FieldValues;
  /** Shape every literal must have, e.g. Linear ids are UUIDs; catches invented values such as "done". */
  readonly literal?: { readonly pattern: RegExp; readonly description: string };
}

/** A field family keyed by a provider-defined name, such as Sentry tags (`tags.<key>`). */
export interface CatalogueFieldFamily {
  /** Prefix before the key, e.g. `tags`. */
  readonly prefix: string;
  readonly label: (key: string) => string;
  readonly description: string;
  readonly keyPattern: RegExp;
  readonly read: (key: string) => FieldRead;
  /** Optional derived suffixes, e.g. `tags.linear_issue.issue_key`. */
  readonly derived?: readonly { readonly suffix: string; readonly label: (key: string) => string; readonly read: (key: string) => FieldRead; readonly description: string }[];
}

export interface CatalogueEvent {
  readonly provider: Provider;
  /** Name after the provider in rules, e.g. `deployment` → `gitlab.deployment`. */
  readonly name: string;
  /** Noun phrase with article, e.g. "a GitLab deployment". */
  readonly phrase: string;
  readonly description: string;
  /** Which normalized `providerEventType` values this event covers. */
  readonly types: { readonly exact?: readonly string[]; readonly prefixes?: readonly string[] };
  readonly fields: readonly CatalogueField[];
  readonly families?: readonly CatalogueFieldFamily[];
}

export interface ProviderCatalogue {
  readonly provider: Provider;
  readonly label: string;
  readonly description: string;
  readonly events: readonly CatalogueEvent[];
}

const payload = (key: string): FieldRead => ({ from: "path", segments: ["evidence", "providerPayload", key] });
const relationship = (type: string, field: "id" | "name" = "id", pattern?: "issue-key"): FieldRead =>
  ({ from: "source", source: { from: "relationship", type, ...(field === "name" ? { field } : {}), ...(pattern === undefined ? {} : { pattern }) } });
const subjectId: FieldRead = { from: "source", source: { from: "subject" } };
const subjectName: FieldRead = { from: "source", source: { from: "subject", field: "name" } };
const fixed = (...options: (readonly [string, string])[]): FieldValues =>
  ({ kind: "fixed", options: options.map(([value, label]) => ({ value, label })) });
const observed: FieldValues = { kind: "observed" };
const identifier: FieldValues = { kind: "identifier" };

function field(name: string, label: string, type: FieldType, read: FieldRead, values: FieldValues, description: string, literal?: CatalogueField["literal"]): CatalogueField {
  return { name, label, type, read, values, description, ...(literal === undefined ? {} : { literal }) };
}

const uuid = { pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, description: "Linear UUIDs such as 3f2b…-…; names like \"Done\" are not available" };
const stripeId = (prefix: string) => ({ pattern: new RegExp(`^${prefix}_[A-Za-z0-9]+$`), description: `Stripe ids starting with ${prefix}_` });

const gitlabProject = [
  field("project", "project", "string", relationship("repository"), observed, "Project path, e.g. acme/shop."),
  field("project_id", "project id", "string", relationship("project"), identifier, "Numeric GitLab project id."),
];

const gitlab: ProviderCatalogue = {
  provider: "gitlab",
  label: "GitLab",
  description: "Pushes, pipelines, deployments, merge requests and issues from GitLab project webhooks.",
  events: [
    {
      provider: "gitlab", name: "deployment", phrase: "a GitLab deployment",
      description: "A deployment changed status (Deployment Hook).",
      types: { exact: ["deployment"], prefixes: ["deployment."] },
      fields: [
        field("status", "status", "string", payload("status"), fixed(["created", "created"], ["running", "running"], ["success", "successful"], ["failed", "failed"], ["canceled", "canceled"]), "Deployment status."),
        field("environment", "environment", "string", relationship("environment"), observed, "Environment name, e.g. production."),
        field("ref", "branch or tag", "string", relationship("ref"), observed, "Deployed branch or tag name."),
        field("ref.issue_key", "issue key in its branch", "string", relationship("ref", "id", "issue-key"), identifier, "Tracker key found in the branch name, e.g. ENG-42 in eng-42-fix-retry."),
        field("commit", "commit", "string", relationship("commit"), identifier, "Deployed commit SHA."),
        field("id", "deployment id", "string", subjectId, identifier, "GitLab deployment id."),
        ...gitlabProject,
      ],
    },
    {
      provider: "gitlab", name: "pipeline", phrase: "a GitLab pipeline",
      description: "A CI pipeline changed status (Pipeline Hook).",
      types: { exact: ["pipeline"], prefixes: ["pipeline."] },
      fields: [
        field("status", "status", "string", payload("objectStatus"), fixed(["created", "created"], ["waiting_for_resource", "waiting"], ["preparing", "preparing"], ["pending", "pending"], ["running", "running"], ["success", "successful"], ["failed", "failed"], ["canceled", "canceled"], ["skipped", "skipped"], ["manual", "manual"], ["scheduled", "scheduled"]), "Pipeline status."),
        field("ref", "branch or tag", "string", relationship("ref"), observed, "Branch or tag the pipeline ran for."),
        field("ref.issue_key", "issue key in its branch", "string", relationship("ref", "id", "issue-key"), identifier, "Tracker key found in the branch name."),
        field("commit", "commit", "string", relationship("commit"), identifier, "Commit SHA."),
        field("id", "pipeline id", "string", subjectId, identifier, "GitLab pipeline id."),
        ...gitlabProject,
      ],
    },
    {
      provider: "gitlab", name: "push", phrase: "a GitLab push",
      description: "Commits were pushed (Push Hook).",
      types: { exact: ["push"], prefixes: ["push."] },
      fields: [
        field("ref", "branch or tag", "string", relationship("ref"), observed, "Full ref, e.g. refs/heads/main."),
        field("ref.issue_key", "issue key in its branch", "string", relationship("ref", "id", "issue-key"), identifier, "Tracker key found in the branch name."),
        field("commit", "commit", "string", relationship("commit"), identifier, "Head commit SHA after the push."),
        ...gitlabProject,
      ],
    },
    {
      provider: "gitlab", name: "merge_request", phrase: "a GitLab merge request event",
      description: "A merge request was opened, updated, merged or closed (Merge Request Hook).",
      types: { exact: ["merge_request"], prefixes: ["merge_request."] },
      fields: [
        field("action", "action", "string", payload("action"), fixed(["open", "opened"], ["reopen", "reopened"], ["update", "updated"], ["merge", "merged"], ["close", "closed"], ["approved", "approved"], ["unapproved", "unapproved"], ["approval", "approval added"], ["unapproval", "approval removed"]), "What happened to the merge request."),
        field("state", "state", "string", payload("state"), fixed(["opened", "open"], ["closed", "closed"], ["merged", "merged"], ["locked", "locked"]), "Merge request state after the event."),
        field("title", "title", "string", subjectName, observed, "Merge request title."),
        field("id", "merge request id", "string", subjectId, identifier, "GitLab merge request id."),
        ...gitlabProject,
      ],
    },
    {
      provider: "gitlab", name: "issue", phrase: "a GitLab issue event",
      description: "A GitLab issue was opened, updated, closed or reopened (Issue Hook).",
      types: { exact: ["issue"], prefixes: ["issue."] },
      fields: [
        field("action", "action", "string", payload("action"), fixed(["open", "opened"], ["update", "updated"], ["close", "closed"], ["reopen", "reopened"]), "What happened to the issue."),
        field("state", "state", "string", payload("state"), fixed(["opened", "open"], ["closed", "closed"]), "Issue state after the event."),
        field("title", "title", "string", subjectName, observed, "Issue title."),
        field("id", "issue id", "string", subjectId, identifier, "GitLab issue id."),
        ...gitlabProject,
      ],
    },
  ],
};

const sentryCommon = [
  field("project", "project", "string", relationship("project"), observed, "Sentry project slug."),
];
const sentryTags: CatalogueFieldFamily = {
  prefix: "tags",
  label: (key) => `${key.replaceAll("_", " ")} tag`,
  description: "Value of an event tag, e.g. tags.linear_issue.",
  keyPattern: /^[A-Za-z0-9_.-]{1,64}$/,
  read: (key) => relationship(`tag.${key}`),
  derived: [{
    suffix: "issue_key",
    label: (key) => `issue key in its ${key.replaceAll("_", " ")} tag`,
    description: "Tracker key found in the tag value, e.g. ENG-42.",
    read: (key) => relationship(`tag.${key}`, "id", "issue-key"),
  }],
};
const sentryEventFields = [
  field("environment", "environment", "string", relationship("environment"), observed, "Environment the error happened in."),
  field("release", "release", "string", relationship("release"), observed, "Release the error happened in."),
  field("level", "level", "string", payload("level"), fixed(["fatal", "fatal"], ["error", "error"], ["warning", "warning"], ["info", "info"], ["debug", "debug"]), "Event level."),
  field("title", "title", "string", subjectName, observed, "Error title."),
  field("id", "event id", "string", subjectId, identifier, "Sentry event id."),
  ...sentryCommon,
];

const sentry: ProviderCatalogue = {
  provider: "sentry",
  label: "Sentry",
  description: "Issue lifecycle, alert-rule event alerts, errors and metric alerts from a Sentry integration.",
  events: [
    {
      provider: "sentry", name: "issue", phrase: "a Sentry issue event",
      description: "A Sentry issue was created, resolved, unresolved, assigned or archived.",
      types: { prefixes: ["issue."] },
      fields: [
        field("action", "action", "string", payload("action"), fixed(["created", "created"], ["resolved", "resolved"], ["unresolved", "unresolved"], ["assigned", "assigned"], ["archived", "archived"]), "What happened to the issue."),
        field("issue", "issue", "string", subjectId, identifier, "Sentry issue id."),
        field("short_id", "short id", "string", payload("shortId"), identifier, "Readable issue id, e.g. SHOP-1A."),
        field("status", "status", "string", payload("status"), fixed(["resolved", "resolved"], ["unresolved", "unresolved"], ["ignored", "ignored"]), "Issue status after the event."),
        field("level", "level", "string", payload("level"), fixed(["fatal", "fatal"], ["error", "error"], ["warning", "warning"], ["info", "info"], ["debug", "debug"]), "Issue level."),
        field("title", "title", "string", subjectName, observed, "Issue title."),
        ...sentryCommon,
      ],
    },
    {
      provider: "sentry", name: "event_alert", phrase: "a Sentry error alert",
      description: "An alert rule fired for an error event; carries the event's tags and environment.",
      types: { prefixes: ["event_alert."] },
      fields: sentryEventFields,
      families: [sentryTags],
    },
    {
      provider: "sentry", name: "error", phrase: "a Sentry error",
      description: "An error event was created (error webhooks).",
      types: { prefixes: ["error."] },
      fields: sentryEventFields,
      families: [sentryTags],
    },
    {
      provider: "sentry", name: "metric_alert", phrase: "a Sentry metric alert",
      description: "A metric alert changed state.",
      types: { prefixes: ["metric_alert."] },
      fields: [
        field("action", "state", "string", payload("action"), fixed(["critical", "critical"], ["warning", "warning"], ["resolved", "resolved"]), "Alert state."),
        field("alert_rule", "alert rule", "string", relationship("alert-rule"), identifier, "Alert rule id."),
        field("title", "title", "string", subjectName, observed, "Alert title."),
      ],
    },
  ],
};

const stripeCustomer = field("customer", "customer", "string", relationship("customer"), identifier, "Stripe customer id, e.g. cus_123.", stripeId("cus"));
const stripeMoney = [
  field("amount", "amount", "number", payload("amount"), observed, "Amount in the smallest currency unit."),
  field("currency", "currency", "string", payload("currency"), observed, "Three-letter currency code."),
];
const stripeLive = field("livemode", "live mode", "boolean", payload("livemode"), { kind: "fixed", options: [{ value: true, label: "live" }, { value: false, label: "test" }] }, "Whether the event came from live mode.");
const stripeEvent = (type: string, phrase: string, description: string, fields: readonly CatalogueField[]): CatalogueEvent => ({
  provider: "stripe", name: type, phrase, description, types: { exact: [type] },
  fields: [field("id", "object id", "string", subjectId, identifier, "Id of the Stripe object in the event."), stripeLive, ...fields],
});

const stripe: ProviderCatalogue = {
  provider: "stripe",
  label: "Stripe",
  description: "Snapshot payment, charge, dispute, invoice and subscription events.",
  events: [
    stripeEvent("payment_intent.succeeded", "a successful Stripe payment", "A PaymentIntent succeeded.", [stripeCustomer, ...stripeMoney, field("invoice", "invoice", "string", relationship("invoice"), identifier, "Invoice id.")]),
    stripeEvent("payment_intent.payment_failed", "a failed Stripe payment", "A PaymentIntent failed.", [stripeCustomer, ...stripeMoney]),
    stripeEvent("charge.succeeded", "a successful Stripe charge", "A charge succeeded.", [stripeCustomer, ...stripeMoney, field("payment_intent", "payment", "string", relationship("payment_intent"), identifier, "PaymentIntent id."), field("invoice", "invoice", "string", relationship("invoice"), identifier, "Invoice id.")]),
    stripeEvent("charge.failed", "a failed Stripe charge", "A charge failed.", [stripeCustomer, ...stripeMoney, field("payment_intent", "payment", "string", relationship("payment_intent"), identifier, "PaymentIntent id.")]),
    stripeEvent("charge.dispute.created", "a Stripe dispute", "A customer disputed a charge.", [field("charge", "charge", "string", relationship("charge"), identifier, "Disputed charge id."), field("payment_intent", "payment", "string", relationship("payment_intent"), identifier, "PaymentIntent id."), ...stripeMoney]),
    stripeEvent("invoice.paid", "a paid Stripe invoice", "An invoice was paid.", [stripeCustomer, field("subscription", "subscription", "string", relationship("subscription"), identifier, "Subscription id."), field("status", "status", "string", payload("status"), observed, "Invoice status.")]),
    stripeEvent("invoice_payment.paid", "a payment recorded against a Stripe invoice", "A payment was applied to an invoice (API 2025-03-31 and later).", [field("invoice", "invoice", "string", relationship("invoice"), identifier, "Invoice id.", stripeId("in")), field("payment_intent", "payment", "string", relationship("payment_intent"), identifier, "PaymentIntent id."), ...stripeMoney]),
    stripeEvent("invoice.payment_failed", "a failed Stripe invoice payment", "An invoice payment attempt failed.", [stripeCustomer, field("subscription", "subscription", "string", relationship("subscription"), identifier, "Subscription id.")]),
    stripeEvent("customer.subscription.updated", "a Stripe subscription update", "A subscription changed.", [stripeCustomer, field("status", "status", "string", payload("status"), fixed(["incomplete", "incomplete"], ["incomplete_expired", "incomplete and expired"], ["trialing", "trialing"], ["active", "active"], ["past_due", "past due"], ["canceled", "canceled"], ["unpaid", "unpaid"], ["paused", "paused"]), "Subscription status after the change.")]),
    stripeEvent("customer.subscription.deleted", "a Stripe subscription cancellation", "A subscription ended (canceled).", [stripeCustomer]),
  ],
};

const linearIssueFields = [
  field("identifier", "issue key", "string", relationship("issue-key"), identifier, "Readable issue key, e.g. ENG-42."),
  field("issue", "issue id", "string", relationship("issue"), identifier, "Linear issue UUID.", uuid),
  field("team", "team", "string", relationship("team"), identifier, "Linear team UUID.", uuid),
  field("project", "project", "string", relationship("project"), identifier, "Linear project UUID.", uuid),
];

const linear: ProviderCatalogue = {
  provider: "linear",
  label: "Linear",
  description: "Issue, comment and issue SLA changes from a Linear webhook.",
  events: [
    {
      provider: "linear", name: "issue", phrase: "a Linear issue event",
      description: "A Linear issue was created, updated or removed.",
      types: { prefixes: ["Issue."] },
      fields: [
        field("action", "action", "string", payload("action"), fixed(["create", "created"], ["update", "updated"], ["remove", "removed"]), "What happened to the issue."),
        ...linearIssueFields,
        field("state", "state", "string", payload("stateName"), observed, "Workflow state name after the event, e.g. Done or In Review (team-specific)."),
        field("state_type", "state type", "string", payload("stateType"), fixed(["triage", "in triage"], ["backlog", "in the backlog"], ["unstarted", "not started"], ["started", "in progress"], ["completed", "completed"], ["canceled", "canceled"]), "Linear's fixed category of the workflow state; completed covers every team's Done states."),
        field("state_changed", "state change", "boolean", payload("stateChanged"), { kind: "fixed", options: [{ value: true, label: "a state change" }, { value: false, label: "no state change" }] }, "True when this update moved the issue to a different workflow state."),
        field("state_id", "workflow state id", "string", payload("stateId"), observed, "UUID of the issue's workflow state.", uuid),
        field("priority", "priority", "number", payload("priority"), { kind: "fixed", options: [{ value: 0, label: "no priority" }, { value: 1, label: "urgent" }, { value: 2, label: "high" }, { value: 3, label: "medium" }, { value: 4, label: "low" }] }, "Priority, 0 (none) to 4 (low)."),
        field("title", "title", "string", subjectName, observed, "Issue title."),
      ],
    },
    {
      provider: "linear", name: "comment", phrase: "a Linear comment event",
      description: "A comment on a Linear issue was created, updated or removed.",
      types: { prefixes: ["Comment."] },
      fields: [
        field("action", "action", "string", payload("action"), fixed(["create", "created"], ["update", "updated"], ["remove", "removed"]), "What happened to the comment."),
        field("issue", "issue id", "string", relationship("issue"), identifier, "Linear issue UUID the comment belongs to.", uuid),
      ],
    },
    {
      provider: "linear", name: "issue_sla", phrase: "a Linear issue SLA event",
      description: "An issue SLA was set, became high risk, or was breached.",
      types: { prefixes: ["IssueSLA."] },
      fields: [
        field("action", "action", "string", payload("action"), fixed(["set", "set"], ["highRisk", "at high risk"], ["breached", "breached"]), "What happened to the SLA."),
        ...linearIssueFields,
      ],
    },
  ],
};

const launchdarkly: ProviderCatalogue = {
  provider: "launchdarkly",
  label: "LaunchDarkly",
  description: "Audit-log entries for flags, environments and projects.",
  events: (["flag", "environment", "project"] as const).map((kind): CatalogueEvent => ({
    provider: "launchdarkly", name: kind, phrase: `a LaunchDarkly ${kind} change`,
    description: `An audit-log entry for a ${kind}.`,
    types: { prefixes: [`${kind}.`] },
    fields: [
      field("actions", "actions", "string", payload("actionList"), observed, `Audit actions joined with "+", e.g. updateOn or updateRules+updateOn; match one with contains.`),
      field("resource", "resource", "string", relationship("launchdarkly-resource"), observed, "First LaunchDarkly resource specifier, e.g. proj/default:env/production:flag/new-checkout."),
      ...(kind === "flag" ? [field("flag", "flag", "string", relationship("feature_flag"), observed, "Flag key, from the resource specifier.")] : []),
      ...(kind === "project" ? [] : [field("environment", "environment", "string", relationship("environment"), observed, "Environment key, from the resource specifier.")]),
      field("title", "title", "string", subjectName, observed, "Audit entry name."),
    ],
  })),
};

const posthog: ProviderCatalogue = {
  provider: "posthog",
  label: "PostHog",
  description: "Product analytics events from a PostHog webhook destination.",
  events: [{
    provider: "posthog", name: "event", phrase: "a PostHog event",
    description: "Any captured analytics event. Teams name their own events, so a business moment the user describes (an account deleted, a checkout completed) is usually a custom event: use the name the user gives, or a snake_case one such as account_deleted.",
    types: { prefixes: [""] },
    fields: [
      field("event", "event name", "string", subjectName, observed, "Captured event name, e.g. $pageview, or a team's own event such as checkout_completed or account_deleted."),
      field("distinct_id", "person", "string", payload("distinctId"), identifier, "PostHog distinct id of the person."),
      field("session", "session", "string", payload("sessionId"), identifier, "Session id."),
    ],
  }],
};

const intercomTopic = (topic: string, phrase: string, description: string, fields: readonly CatalogueField[]): CatalogueEvent =>
  ({ provider: "intercom", name: topic, phrase, description, types: { exact: [topic] }, fields });
const intercomRelations = [
  field("contact", "contact", "string", relationship("contact"), identifier, "Contact id."),
];

const intercom: ProviderCatalogue = {
  provider: "intercom",
  label: "Intercom",
  description: "Conversation, ticket and contact notifications.",
  events: [
    intercomTopic("conversation.user.created", "a new Intercom conversation from a customer", "A customer started a conversation.", [field("id", "conversation", "string", subjectId, identifier, "Conversation id."), ...intercomRelations]),
    intercomTopic("conversation.admin.replied", "an Intercom admin reply", "A teammate replied in a conversation.", [field("id", "conversation", "string", subjectId, identifier, "Conversation id."), ...intercomRelations]),
    intercomTopic("conversation.admin.closed", "an Intercom conversation being closed", "A teammate closed a conversation.", [field("id", "conversation", "string", subjectId, identifier, "Conversation id."), ...intercomRelations]),
    intercomTopic("ticket.created", "a new Intercom ticket", "A ticket was created.", [field("id", "ticket", "string", subjectId, identifier, "Ticket id."), field("state", "ticket state", "string", payload("ticketState"), observed, "Ticket state."), ...intercomRelations]),
    intercomTopic("ticket.updated", "an Intercom ticket update", "A ticket changed.", [field("id", "ticket", "string", subjectId, identifier, "Ticket id."), field("state", "ticket state", "string", payload("ticketState"), observed, "Ticket state."), ...intercomRelations]),
    intercomTopic("contact.created", "a new Intercom contact", "A contact was created.", [field("id", "contact", "string", subjectId, identifier, "Contact id.")]),
    intercomTopic("contact.updated", "an Intercom contact update", "A contact changed.", [field("id", "contact", "string", subjectId, identifier, "Contact id.")]),
  ],
};

export const catalogue: readonly ProviderCatalogue[] = [gitlab, sentry, stripe, linear, launchdarkly, posthog, intercom];

/** `provider.event` → event definition. */
export const catalogueEvents: ReadonlyMap<string, CatalogueEvent> = new Map(
  catalogue.flatMap((entry) => entry.events.map((event) => [`${event.provider}.${event.name}`, event] as const)),
);

export function providerLabel(provider: Provider): string {
  return catalogue.find((entry) => entry.provider === provider)?.label ?? provider;
}

/** Resolves a field name on an event, including keyed families such as `tags.linear_issue`. */
export function resolveField(event: CatalogueEvent, name: string): CatalogueField | undefined {
  const direct = event.fields.find((candidate) => candidate.name === name);
  if (direct !== undefined) return direct;
  for (const family of event.families ?? []) {
    if (!name.startsWith(`${family.prefix}.`)) continue;
    const rest = name.slice(family.prefix.length + 1);
    for (const derived of family.derived ?? []) {
      if (!rest.endsWith(`.${derived.suffix}`)) continue;
      const key = rest.slice(0, -(derived.suffix.length + 1));
      if (family.keyPattern.test(key)) return field(name, derived.label(key), "string", derived.read(key), identifier, derived.description);
    }
    if (family.keyPattern.test(rest)) return field(name, family.label(rest), "string", family.read(rest), observed, family.description);
  }
  return undefined;
}

/** All field names an event offers, with family placeholders such as `tags.<key>`, for messages and the agent. */
export function fieldNames(event: CatalogueEvent): string[] {
  return [
    ...event.fields.map((candidate) => candidate.name),
    ...(event.families ?? []).flatMap((family) => [`${family.prefix}.<key>`, ...(family.derived ?? []).map((derived) => `${family.prefix}.<key>.${derived.suffix}`)]),
  ];
}
