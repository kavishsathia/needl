import { randomBytes, randomInt } from "node:crypto";
import { catalogue, catalogueEvents, type CatalogueField } from "../../src/rules/catalogue.js";
import { acceptsTags, sampleValue, settableFields, type SimulatedValue, type SimulatedValues } from "./encoders.js";
import type { SimulatedProvider } from "./config.js";

export type { SignedDelivery, SimulatedValues } from "./encoders.js";

export interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly type: CatalogueField["type"];
  readonly description: string;
  readonly options?: readonly { readonly value: SimulatedValue; readonly label: string }[];
  readonly sample: SimulatedValue;
}

/** One sendable event, generated from the rule catalogue: every event and field a rule can use. */
export interface EventSpec {
  readonly id: string;
  readonly provider: SimulatedProvider;
  readonly label: string;
  readonly description: string;
  readonly fields: readonly FieldSpec[];
  /** Free-form `key=value` tags (Sentry), readable in rules as `tags.<key>`. */
  readonly tags: boolean;
}

export function eventSpecs(): EventSpec[] {
  return catalogue.flatMap((entry) => entry.events.map((event): EventSpec => ({
    id: `${event.provider}.${event.name}`,
    provider: event.provider,
    label: event.phrase.replace(/^an? /, "").replace(/^./, (first) => first.toUpperCase()),
    description: event.description,
    fields: settableFields(event).map((field) => ({
      name: field.name,
      label: field.label,
      type: field.type,
      description: field.description,
      ...(field.values.kind === "fixed" ? { options: field.values.options } : {}),
      sample: sampleValue(event, field),
    })),
    tags: acceptsTags(event),
  })));
}

/**
 * Turns form input (all text) into typed values for the event: numbers and booleans by field type, empty fields
 * dropped (the encoder fills them), and `tags` ("key=value, …") into `tags.<key>` entries.
 */
export function typedValues(eventId: string, input: Readonly<Record<string, string>>): SimulatedValues {
  const event = catalogueEvents.get(eventId);
  if (event === undefined) throw new Error(`Unknown event ${eventId}`);
  const values: Record<string, SimulatedValue> = {};
  for (const field of settableFields(event)) {
    const raw = input[field.name]?.trim();
    if (raw === undefined || raw === "") continue;
    if (field.type === "number") {
      const number = Number(raw);
      if (!Number.isFinite(number)) throw new Error(`${field.label} must be a number`);
      values[field.name] = number;
    } else if (field.type === "boolean") {
      if (raw !== "true" && raw !== "false") throw new Error(`${field.label} must be true or false`);
      values[field.name] = raw === "true";
    } else values[field.name] = raw;
  }
  for (const pair of (input.tags ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const [key, ...rest] = pair.split("=");
    if (key === undefined || rest.length === 0 || !/^[A-Za-z0-9_.-]{1,64}$/.test(key.trim())) throw new Error(`Tags are key=value pairs, e.g. linear_issue=ENG-42; got "${pair}"`);
    values[`tags.${key.trim()}`] = rest.join("=").trim();
  }
  return values;
}

export interface StoryStep {
  readonly event: string;
  readonly values: SimulatedValues;
}

export interface Story {
  readonly id: string;
  /** The example rule this story exercises. */
  readonly template: string;
  readonly variant: "violation" | "healthy";
  readonly label: string;
  /** Fresh identifiers every play, so each run is its own monitor instance. */
  steps(): readonly StoryStep[];
}

const issueKey = () => `ENG-${randomInt(100, 1_000)}`;
const issueNumber = () => String(randomInt(1_000_000, 9_999_999));
const customerId = () => `cus_${randomBytes(7).toString("hex")}`;
const deploy = (key: string): StoryStep => ({ event: "gitlab.deployment", values: { status: "success", environment: "production", ref: `${key.toLowerCase()}-fix-retry-loop` } });
const alert = (key: string, title: string): StoryStep => ({ event: "sentry.event_alert", values: { environment: "production", title, "tags.linear_issue": key } });

export const stories: readonly Story[] = [
  {
    id: "ghost.violation", template: "No ghosts", variant: "violation", label: "Ship ENG-n, then its error comes back",
    steps: () => { const key = issueKey(); return [deploy(key), alert(key, "CheckoutError: retry loop")]; },
  },
  {
    id: "ghost.healthy", template: "No ghosts", variant: "healthy", label: "Ship ENG-n, then a different issue errors",
    steps: () => { const key = issueKey(); return [deploy(key), alert(`${key}0`, "AvatarError: upload timeout")]; },
  },
  {
    id: "boomerang.violation", template: "Boomerang", variant: "violation", label: "Resolve an issue, then it comes back",
    steps: () => {
      const issue = issueNumber();
      return [{ event: "sentry.issue", values: { action: "resolved", issue } }, { event: "sentry.issue", values: { action: "unresolved", issue } }];
    },
  },
  {
    id: "boomerang.healthy", template: "Boomerang", variant: "healthy", label: "Resolve an issue, then a different one comes back",
    steps: () => [{ event: "sentry.issue", values: { action: "resolved", issue: issueNumber() } }, { event: "sentry.issue", values: { action: "unresolved", issue: issueNumber() } }],
  },
  {
    id: "clean-break.violation", template: "Clean break", variant: "violation", label: "Cancel a customer, then charge them",
    steps: () => {
      const customer = customerId();
      return [{ event: "stripe.customer.subscription.deleted", values: { customer } }, { event: "stripe.invoice.paid", values: { customer } }];
    },
  },
  {
    id: "clean-break.healthy", template: "Clean break", variant: "healthy", label: "Cancel a customer, then charge someone else",
    steps: () => [{ event: "stripe.customer.subscription.deleted", values: { customer: customerId() } }, { event: "stripe.invoice.paid", values: { customer: customerId() } }],
  },
];

export function findStory(id: string): Story {
  const story = stories.find((candidate) => candidate.id === id);
  if (story === undefined) throw new Error(`Unknown story ${id}`);
  return story;
}
