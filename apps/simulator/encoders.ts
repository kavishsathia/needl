import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Provider } from "../../src/core/types.js";
import { catalogueEvents, type CatalogueEvent, type CatalogueField } from "../../src/rules/catalogue.js";

/**
 * Builds each provider's real webhook payload for any catalogue event, signed exactly as that provider signs it.
 * The simulator offers every event and field rules can use; a round-trip test sends every one through the real
 * adapters and checks the rule-visible fields come back as sent.
 */

export type SimulatedValue = string | number | boolean;
export type SimulatedValues = Readonly<Record<string, SimulatedValue>>;

export interface SignedDelivery {
  readonly provider: Provider;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Fields a person sets directly; derived fields (like the issue key found in a branch) follow from them. */
export function settableFields(event: CatalogueEvent): readonly CatalogueField[] {
  return event.fields.filter((field) => !(field.read.from === "source" && field.read.source.pattern !== undefined));
}

/** Whether the event accepts free-form tags (`tags.<key>` fields), like Sentry events. */
export function acceptsTags(event: CatalogueEvent): boolean {
  return (event.families ?? []).some((family) => family.prefix === "tags");
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** A plausible value for a field, used to prefill forms and in tests. */
export function sampleValue(event: CatalogueEvent, field: CatalogueField): SimulatedValue {
  if (field.values.kind === "fixed") {
    const preferred: Readonly<Record<string, SimulatedValue>> = { status: "success", action: event.provider === "sentry" && event.name === "issue" ? "resolved" : event.provider === "linear" ? "update" : "", state_type: "completed", livemode: false };
    const wanted = preferred[field.name];
    return field.values.options.find((option) => option.value === wanted)?.value ?? field.values.options[0]!.value;
  }
  if (field.type === "number") return field.name === "priority" ? 2 : 4900;
  if (field.type === "boolean") return true;
  const byName: Readonly<Record<string, () => string>> = {
    environment: () => "production",
    ref: () => event.name === "push" ? "refs/heads/eng-42-fix-retry-loop" : "eng-42-fix-retry-loop",
    commit: () => hex(20),
    project: () => event.provider === "gitlab" ? "acme/shop" : event.provider === "sentry" ? "shop" : linearUuid("project:web"),
    project_id: () => "7",
    release: () => "shop@1.4.2",
    title: () => event.provider === "linear" ? "Fix checkout retry loop" : event.provider === "sentry" ? "CheckoutError: retry loop" : "Fix checkout retry loop",
    identifier: () => "ENG-42",
    customer: () => `cus_${hex(6)}`,
    subscription: () => `sub_${hex(6)}`,
    invoice: () => `in_${hex(6)}`,
    charge: () => `ch_${hex(6)}`,
    payment_intent: () => `pi_${hex(6)}`,
    currency: () => "usd",
    state: () => event.provider === "linear" ? "Done" : "submitted",
    event: () => "checkout_completed",
    distinct_id: () => `person_${hex(4)}`,
    session: () => `session_${hex(4)}`,
    contact: () => hex(12),
    actions: () => "updateOn",
    flag: () => "new-checkout",
    resource: () => "proj/default:env/production:flag/new-checkout",
    short_id: () => "SHOP-1A",
    alert_rule: () => String(randomInt(100, 999)),
  };
  if (byName[field.name] !== undefined) return byName[field.name]!();
  if (field.literal !== undefined) return field.literal.description.startsWith("Linear") ? randomUUID() : `${field.literal.description.match(/with (\w+)_/)?.[1] ?? "id"}_${hex(6)}`;
  if (field.name === "id" || field.name === "issue" || field.name === "team") return event.provider === "linear" ? randomUUID() : String(randomInt(1_000, 999_999));
  return `sample-${field.name}`;
}

/** Linear ids are UUIDs; derive stable ones so repeated sends refer to the same issue, team or state. */
export function linearUuid(seed: string): string {
  const digest = createHmac("sha256", "needl-simulator").update(seed).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function text(values: SimulatedValues, name: string, fallback: string): string {
  const value = values[name];
  return value === undefined || value === "" ? fallback : String(value);
}

function tagsOf(values: SimulatedValues): [string, string][] {
  return Object.entries(values).filter(([key]) => key.startsWith("tags.")).map(([key, value]) => [key.slice(5), String(value)]);
}

function standardWebhookHeaders(secret: string, body: string, at: Date): Record<string, string> {
  if (!secret.startsWith("whsec_")) throw new Error("Standard Webhooks secrets must start with whsec_");
  const id = `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(at.getTime() / 1_000));
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` };
}

const hmacHex = (algorithm: "sha256" | "sha1", secret: string, body: string) => createHmac(algorithm, secret).update(body).digest("hex");

function gitlab(event: CatalogueEvent, values: SimulatedValues, at: Date, secret: string): SignedDelivery {
  const path = text(values, "project", "acme/shop");
  const projectId = Number(text(values, "project_id", "7"));
  const web = `https://gitlab.example.com/${path}`;
  const project = { id: Number.isFinite(projectId) ? projectId : 7, name: path.split("/").at(-1), path_with_namespace: path, web_url: web, default_branch: "main" };
  const commit = text(values, "commit", hex(20));
  const id = Number(text(values, "id", String(randomInt(1_000, 999_999))));
  const time = `${at.toISOString().slice(0, 19).replace("T", " ")} +0000`;
  const user = { id: 1, name: "Needl Simulator", username: "needl-simulator" };
  let hook: string;
  let body: Record<string, unknown>;
  switch (event.name) {
    case "deployment": {
      hook = "Deployment Hook";
      const environment = text(values, "environment", "production");
      body = {
        object_kind: "deployment", status: text(values, "status", "success"), status_changed_at: time, deployment_id: id,
        deployable_id: id + 1, deployable_url: `${web}/-/jobs/${id + 1}`, environment, environment_slug: environment,
        environment_tier: environment === "production" ? "production" : "other", project, short_sha: commit.slice(0, 8), user,
        commit_url: `${web}/-/commit/${commit}`, commit_title: "Simulated deploy", ref: text(values, "ref", "main"),
      };
      break;
    }
    case "pipeline":
      hook = "Pipeline Hook";
      body = {
        object_kind: "pipeline",
        object_attributes: { id, iid: id % 1_000, ref: text(values, "ref", "main"), tag: false, sha: commit, status: text(values, "status", "success"), created_at: time, finished_at: time },
        commit: { id: commit, message: "Simulated commit", timestamp: at.toISOString(), url: `${web}/-/commit/${commit}` },
        project, user,
      };
      break;
    case "push":
      hook = "Push Hook";
      body = {
        object_kind: "push", event_name: "push", before: hex(20), after: commit, ref: text(values, "ref", "refs/heads/main"), checkout_sha: commit,
        user_username: "needl-simulator", project, repository: { name: project.name, homepage: web },
        commits: [{ id: commit, message: "Simulated commit", timestamp: at.toISOString(), url: `${web}/-/commit/${commit}` }], total_commits_count: 1,
      };
      break;
    case "merge_request":
    case "issue": {
      const isIssue = event.name === "issue";
      hook = isIssue ? "Issue Hook" : "Merge Request Hook";
      const iid = id % 1_000;
      body = {
        object_kind: event.name, event_type: event.name, user, project,
        object_attributes: {
          id, iid, title: text(values, "title", isIssue ? "Checkout fails on retry" : "Fix checkout retry loop"),
          state: text(values, "state", "opened"), action: text(values, "action", isIssue ? "open" : "open"),
          created_at: time, updated_at: time, url: `${web}/-/${isIssue ? "issues" : "merge_requests"}/${iid}`,
          ...(isIssue ? {} : { source_branch: "eng-42-fix-retry-loop", target_branch: "main" }),
        },
      };
      break;
    }
    default: throw new Error(`No GitLab payload for ${event.name}`);
  }
  const raw = JSON.stringify(body);
  return { provider: "gitlab", body: raw, headers: { "x-gitlab-event": hook, ...standardWebhookHeaders(secret, raw, at) } };
}

function sentry(event: CatalogueEvent, values: SimulatedValues, at: Date, secret: string): SignedDelivery {
  const id = text(values, event.name === "issue" ? "issue" : "id", event.name === "issue" ? String(randomInt(1_000_000, 9_999_999)) : hex(16));
  const project = text(values, "project", "shop");
  const tags: [string, string][] = [...tagsOf(values), ...(values.environment === undefined || values.environment === "" ? [] : [["environment", String(values.environment)] as [string, string]])];
  let action: string;
  let data: Record<string, unknown>;
  switch (event.name) {
    case "issue":
      action = text(values, "action", "created");
      data = {
        issue: {
          id, shortId: text(values, "short_id", `SHOP-${id.slice(-3)}`), title: text(values, "title", "CheckoutError: card token expired"),
          status: text(values, "status", action === "resolved" ? "resolved" : "unresolved"), level: text(values, "level", "error"),
          permalink: `https://acme.sentry.io/issues/${id}/`, project: { id: "12", name: project, slug: project }, lastSeen: at.toISOString(),
        },
      };
      break;
    case "event_alert":
      action = "triggered";
      data = {
        event: {
          event_id: id, issue_id: String(randomInt(1_000_000, 9_999_999)), project: project, timestamp: at.getTime() / 1_000,
          title: text(values, "title", "CheckoutError: retry loop"), level: text(values, "level", "error"),
          ...(values.release === undefined || values.release === "" ? {} : { release: String(values.release) }),
          web_url: `https://acme.sentry.io/issues/events/${id}/`, tags,
        },
        triggered_rule: "Simulated alert rule",
      };
      break;
    case "error":
      action = "created";
      data = {
        error: {
          event_id: id, project, timestamp: at.getTime() / 1_000, title: text(values, "title", "CheckoutError: retry loop"),
          level: text(values, "level", "error"), web_url: `https://acme.sentry.io/issues/events/${id}/`, tags,
          ...(values.environment === undefined || values.environment === "" ? {} : { environment: String(values.environment) }),
          ...(values.release === undefined || values.release === "" ? {} : { release: String(values.release) }),
        },
      };
      break;
    case "metric_alert":
      action = text(values, "action", "critical");
      data = {
        metric_alert: {
          id: String(randomInt(1_000, 9_999)), title: text(values, "title", "Checkout error rate above 5%"),
          alert_rule: { id: text(values, "alert_rule", "42"), name: "Checkout error rate" }, projects: [project], date_started: at.toISOString(),
        },
        description_title: "Checkout error rate",
      };
      break;
    default: throw new Error(`No Sentry payload for ${event.name}`);
  }
  const body = JSON.stringify({ action, actor: { id: "sentry", name: "Sentry", type: "application" }, data, installation: { uuid: "simulated-sentry-installation" } });
  return {
    provider: "sentry",
    body,
    headers: {
      "content-type": "application/json", "request-id": randomUUID(), "sentry-hook-resource": event.name,
      "sentry-hook-timestamp": String(Math.floor(at.getTime() / 1_000)), "sentry-hook-signature": hmacHex("sha256", secret, body),
    },
  };
}

const stripeObjects: Readonly<Record<string, { readonly object: string; readonly prefix: string }>> = {
  payment_intent: { object: "payment_intent", prefix: "pi" },
  charge: { object: "charge", prefix: "ch" },
  "charge.dispute": { object: "dispute", prefix: "dp" },
  invoice: { object: "invoice", prefix: "in" },
  "customer.subscription": { object: "subscription", prefix: "sub" },
  invoice_payment: { object: "invoice_payment", prefix: "inpay" },
};

function stripe(event: CatalogueEvent, values: SimulatedValues, at: Date, secret: string): SignedDelivery {
  const type = event.name;
  const kind = Object.keys(stripeObjects).sort((left, right) => right.length - left.length).find((prefix) => type.startsWith(`${prefix}.`))!;
  const { object, prefix } = stripeObjects[kind]!;
  const id = text(values, "id", `${prefix}_${hex(8)}`);
  const optional = (name: string, key = name) => values[name] === undefined || values[name] === "" ? {} : { [key]: values[name] };
  const status = type.endsWith("succeeded") ? "succeeded" : type.endsWith("failed") ? "failed" : type === "invoice.paid" || type === "invoice_payment.paid" ? "paid" : type === "customer.subscription.deleted" ? "canceled" : undefined;
  const body = JSON.stringify({
    id: `evt_${hex(12)}`, object: "event", api_version: "2025-09-30.clover", created: Math.floor(at.getTime() / 1_000),
    livemode: values.livemode === true, pending_webhooks: 1, request: { id: null, idempotency_key: null }, type,
    data: {
      object: {
        id, object, ...optional("customer"), ...optional("amount"), ...optional("currency"), ...optional("invoice"),
        ...optional("subscription"), ...optional("charge"),
        // Invoice payments name their PaymentIntent under payment, as Stripe sends them.
        ...(object === "invoice_payment" ? (values.payment_intent === undefined || values.payment_intent === "" ? {} : { payment: { type: "payment_intent", payment_intent: values.payment_intent } }) : optional("payment_intent")),
        status: values.status === undefined || values.status === "" ? status : values.status,
        description: "Simulated object",
        ...(object === "invoice" ? { hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, amount_paid: 4900, currency: "usd" } : {}),
      },
    },
  });
  const timestamp = Math.floor(at.getTime() / 1_000);
  return { provider: "stripe", body, headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${hmacHex("sha256", secret, `${timestamp}.${body}`)}` } };
}

/** Linear's fixed state categories for common state names; teams name their states freely. */
export function linearStateType(name: string): string {
  const key = name.trim().toLowerCase();
  if (["done", "completed", "shipped", "released"].includes(key)) return "completed";
  if (["canceled", "cancelled", "duplicate", "won't do"].includes(key)) return "canceled";
  if (["todo", "to do", "unstarted"].includes(key)) return "unstarted";
  if (key === "backlog") return "backlog";
  if (key === "triage") return "triage";
  return "started";
}

function linear(event: CatalogueEvent, values: SimulatedValues, at: Date, secret: string): SignedDelivery {
  const action = text(values, "action", event.name === "issue_sla" ? "breached" : "update");
  const identifier = text(values, "identifier", "ENG-42").toUpperCase();
  const issueId = text(values, "issue", linearUuid(`issue:${identifier}`));
  const team = text(values, "team", linearUuid(`team:${identifier.split("-")[0]}`));
  const issue = {
    id: issueId, identifier, title: text(values, "title", "Fix checkout retry loop"), teamId: team,
    ...(values.project === undefined || values.project === "" ? {} : { projectId: String(values.project) }),
    url: `https://linear.app/acme/issue/${identifier}`,
  };
  let type: string;
  let extra: Record<string, unknown>;
  switch (event.name) {
    case "issue": {
      type = "Issue";
      const stateName = text(values, "state", "In Progress");
      const stateType = text(values, "state_type", linearStateType(stateName));
      const stateId = text(values, "state_id", linearUuid(`state:${stateName.toLowerCase()}`));
      const priority = values.priority === undefined || values.priority === "" ? 2 : Number(values.priority);
      extra = {
        data: { ...issue, stateId, state: { id: stateId, name: stateName, type: stateType, color: "#5e6ad2" }, priority },
        ...(action !== "update" ? {} : { updatedFrom: values.state_changed === false ? { title: "Previous title" } : { stateId: linearUuid(`state:previous-of-${stateName.toLowerCase()}`) } }),
      };
      break;
    }
    case "comment":
      type = "Comment";
      extra = { data: { id: randomUUID(), issueId, body: "Simulated comment", userId: linearUuid("user:simulator"), createdAt: at.toISOString() } };
      break;
    case "issue_sla":
      type = "IssueSLA";
      extra = { issueData: issue };
      break;
    default: throw new Error(`No Linear payload for ${event.name}`);
  }
  const body = JSON.stringify({
    action, type, createdAt: at.toISOString(), webhookTimestamp: at.getTime(), webhookId: randomUUID(),
    organizationId: linearUuid("org"), url: issue.url, ...extra,
  });
  return {
    provider: "linear",
    body,
    headers: { "content-type": "application/json", "linear-delivery": randomUUID(), "linear-event": type, "linear-signature": hmacHex("sha256", secret, body) },
  };
}

function launchdarkly(event: CatalogueEvent, values: SimulatedValues, at: Date, secret: string): SignedDelivery {
  const flag = text(values, "flag", "new-checkout");
  const environment = text(values, "environment", "production");
  const resource = text(values, "resource", event.name === "flag" ? `proj/default:env/${environment}:flag/${flag}`
    : event.name === "environment" ? `proj/default:env/${environment}` : "proj/default");
  const actions = text(values, "actions", event.name === "flag" ? "updateOn" : "updateName").split("+").map((item) => item.trim()).filter(Boolean);
  const body = JSON.stringify({
    _id: hex(12), _accountId: hex(12), date: at.getTime(), kind: event.name,
    name: text(values, "title", event.name === "flag" ? "New checkout" : "Production"),
    titleVerb: event.name === "flag" ? "turned on the flag" : "updated", accesses: actions.map((action) => ({ action, resource })),
    _links: { site: { href: `/default/${environment}/features/${flag}`, type: "text/html" } },
  });
  return { provider: "launchdarkly", body, headers: { "content-type": "application/json", "x-ld-signature": hmacHex("sha256", secret, body) } };
}

function posthog(_event: CatalogueEvent, values: SimulatedValues, at: Date, secret: string): SignedDelivery {
  const body = JSON.stringify({
    event: {
      uuid: randomUUID(), event: text(values, "event", "checkout_completed"), timestamp: at.toISOString(),
      distinct_id: text(values, "distinct_id", `person_${hex(4)}`),
      properties: { $session_id: text(values, "session", `session_${hex(4)}`), $current_url: "https://shop.example.com/checkout" },
    },
    project_id: "1",
    relationships: [],
  });
  return { provider: "posthog", body, headers: standardWebhookHeaders(secret, body, at) };
}

function intercom(event: CatalogueEvent, values: SimulatedValues, at: Date, secret: string): SignedDelivery {
  const topic = event.name;
  const id = text(values, "id", String(randomInt(100_000, 999_999)));
  const contact = text(values, "contact", hex(12));
  const contacts = { type: "contact.list", contacts: [{ type: "contact", id: contact }] };
  const item = topic.startsWith("conversation.")
    ? { type: "conversation", id, state: topic.endsWith("closed") ? "closed" : "open", contacts, created_at: Math.floor(at.getTime() / 1_000) }
    : topic.startsWith("ticket.")
      ? { type: "ticket", id, ticket_id: String(randomInt(1, 999)), ticket_state: { type: "ticket_state", category: text(values, "state", "submitted"), internal_label: "Submitted" }, contacts }
      : { type: "contact", id, role: "user", email: "customer@example.com" };
  const body = JSON.stringify({
    type: "notification_event", id: `notif_${randomUUID()}`, topic, app_id: "simapp", created_at: Math.floor(at.getTime() / 1_000),
    delivery_attempts: 1, data: { type: "notification_event_data", item },
  });
  return { provider: "intercom", body, headers: { "content-type": "application/json", "x-hub-signature": `sha1=${hmacHex("sha1", secret, body)}` } };
}

const encoders: Readonly<Record<Provider, (event: CatalogueEvent, values: SimulatedValues, at: Date, secret: string) => SignedDelivery>> = {
  gitlab, sentry, stripe, linear, launchdarkly, posthog, intercom,
};

/** Builds and signs the webhook for `provider.event`; empty values fall back to plausible ones. */
export function encodeEvent(key: string, values: SimulatedValues, at: Date, secret: string): SignedDelivery {
  const event = catalogueEvents.get(key);
  if (event === undefined) throw new Error(`Unknown event ${key}`);
  return encoders[event.provider](event, values, at, secret);
}
