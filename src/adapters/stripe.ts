import { z } from "zod";
import { hmac, secureEqual } from "../core/crypto.js";
import {
  absoluteLinks,
  header,
  ignored,
  isEnabled,
  objectValue,
  parseJson,
  rawText,
  rejected,
  stringValue,
  unixSeconds,
} from "../core/helpers.js";
import type { AdapterConfig, AdapterResult, RelationshipEvidence, WebhookAdapter, WebhookRequest } from "../core/types.js";
import { configuredKind, normalizedEvent } from "./shared.js";

export interface StripeAdapterConfig extends AdapterConfig {
  readonly toleranceSeconds?: number;
}

const stripePayload = z.object({
  id: z.string(),
  object: z.literal("event"),
  type: z.string(),
  created: z.number(),
  account: z.string().optional(),
  context: z.string().optional(),
  livemode: z.boolean().optional(),
  data: z.object({
    object: z.record(z.string(), z.unknown()),
    previous_attributes: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
}).passthrough();

const stripeEvents: Record<string, { kind: string; subject: string }> = {
  "payment_intent.succeeded": { kind: "payment.succeeded", subject: "payment_intent" },
  "payment_intent.payment_failed": { kind: "payment.failed", subject: "payment_intent" },
  "charge.succeeded": { kind: "charge.succeeded", subject: "charge" },
  "charge.failed": { kind: "charge.failed", subject: "charge" },
  "charge.dispute.created": { kind: "charge.disputed", subject: "dispute" },
  "invoice.paid": { kind: "invoice.paid", subject: "invoice" },
  "invoice.payment_failed": { kind: "invoice.payment_failed", subject: "invoice" },
  // Since API version 2025-03-31 this is the only event that ties a payment to the invoice it paid.
  "invoice_payment.paid": { kind: "invoice.payment_recorded", subject: "invoice_payment" },
  "customer.subscription.updated": { kind: "subscription.updated", subject: "subscription" },
  "customer.subscription.deleted": { kind: "subscription.deleted", subject: "subscription" },
};

function parseSignature(value: string): { timestamp?: string; signatures: string[] } {
  const fields = value.split(",").map((field) => field.trim());
  const timestamp = fields.find((field) => field.startsWith("t="))?.slice(2);
  const signatures = fields.filter((field) => field.startsWith("v1=")).map((field) => field.slice(3));
  return { ...(timestamp === undefined ? {} : { timestamp }), signatures };
}

/** Why a payment or charge failed, from Stripe's own error fields: the evidence most worth having when one does. */
function failureReason(entity: Record<string, unknown>): { code?: string; declineCode?: string; message?: string } | undefined {
  const error = objectValue(entity.last_payment_error);
  const reason = {
    code: stringValue(error?.code) ?? stringValue(entity.failure_code),
    declineCode: stringValue(error?.decline_code) ?? stringValue(objectValue(entity.outcome)?.reason),
    message: stringValue(error?.message) ?? stringValue(entity.failure_message),
  };
  const present = Object.fromEntries(Object.entries(reason).filter(([, value]) => value !== undefined));
  return Object.keys(present).length === 0 ? undefined : present;
}

function relation(type: string, id: unknown, path: string): RelationshipEvidence[] {
  const value = stringValue(id);
  return value === undefined ? [] : [{ type, id: value, evidencePath: path }];
}

export class StripeAdapter implements WebhookAdapter<StripeAdapterConfig> {
  readonly provider = "stripe" as const;

  async ingest(request: WebhookRequest, config: StripeAdapterConfig): Promise<AdapterResult> {
    const signatureHeader = header(request.headers, "stripe-signature");
    if (signatureHeader === undefined) return rejected(this.provider, "unauthenticated", "Missing Stripe-Signature header");
    const { timestamp, signatures } = parseSignature(signatureHeader);
    if (timestamp === undefined || signatures.length === 0) {
      return rejected(this.provider, "unauthenticated", "Stripe-Signature is missing t or v1 fields");
    }
    const parsedTimestamp = Number(timestamp);
    const now = (config.clock?.() ?? request.receivedAt).getTime() / 1_000;
    if (!Number.isFinite(parsedTimestamp) || Math.abs(now - parsedTimestamp) > (config.toleranceSeconds ?? 300)) {
      return rejected(this.provider, "stale", "Stripe webhook timestamp is outside the configured tolerance");
    }
    const signed = `${timestamp}.${rawText(request.rawBody)}`;
    let matched = false;
    for (const secret of config.secrets) {
      const expected = hmac("sha256", secret, signed);
      for (const signature of signatures) matched = secureEqual(expected, signature) || matched;
    }
    if (!matched) return rejected(this.provider, "unauthenticated", "Invalid Stripe webhook signature");

    let parsed: unknown;
    try {
      parsed = parseJson(request.rawBody);
    } catch {
      return rejected(this.provider, "malformed", "Body is not valid UTF-8 JSON");
    }
    const result = stripePayload.safeParse(parsed);
    if (!result.success) return rejected(this.provider, "malformed", "Payload is not a Stripe snapshot Event object");
    const payload = result.data;
    const descriptor = stripeEvents[payload.type];
    if (descriptor === undefined) return ignored(this.provider, request, "unknown_event", payload.type, payload.id);
    if (!isEnabled(config, payload.type)) return ignored(this.provider, request, "not_subscribed", payload.type, payload.id);
    const entity = payload.data.object;
    const subjectId = stringValue(entity.id);
    if (subjectId === undefined) return rejected(this.provider, "malformed", "Supported Stripe event is missing data.object.id");
    const charge = objectValue(entity.charge);
    // Newer API versions moved these: an invoice's subscription now sits under parent, and an
    // invoice payment names its PaymentIntent under payment.
    const subscriptionDetails = objectValue(objectValue(entity.parent)?.subscription_details);
    const payment = objectValue(entity.payment);
    const relationships = [
      ...relation("customer", entity.customer, "/data/object/customer"),
      ...(entity.payment_intent !== undefined
        ? relation("payment_intent", entity.payment_intent, "/data/object/payment_intent")
        : relation("payment_intent", payment?.payment_intent, "/data/object/payment/payment_intent")),
      ...relation("invoice", entity.invoice, "/data/object/invoice"),
      ...(entity.subscription !== undefined
        ? relation("subscription", entity.subscription, "/data/object/subscription")
        : relation("subscription", subscriptionDetails?.subscription, "/data/object/parent/subscription_details/subscription")),
      ...relation("charge", typeof entity.charge === "string" ? entity.charge : charge?.id, "/data/object/charge"),
    ];
    const url = stringValue(entity.hosted_invoice_url) ?? stringValue(entity.receipt_url);
    const sourceScope = payload.context ?? payload.account;
    const occurredAt = unixSeconds(payload.created);
    const subjectName = stringValue(entity.description);
    const failure = failureReason(entity);
    return {
      status: "accepted",
      event: normalizedEvent(this.provider, request, {
        deliveryId: payload.id,
        providerEventType: payload.type,
        source: {
          ...(request.sourceId === undefined ? {} : { id: request.sourceId }),
          ...(sourceScope === undefined ? {} : { scope: sourceScope }),
        },
        ...(occurredAt === undefined ? {} : { occurredAt }),
        kind: configuredKind(config, payload.type, descriptor.kind),
        subject: {
          type: descriptor.subject,
          id: subjectId,
          ...(subjectName === undefined ? {} : { name: subjectName }),
          ...(url === undefined ? {} : { url }),
        },
        relationships,
        evidence: {
          providerPayload: {
            type: payload.type,
            objectType: entity.object,
            ...(payload.livemode === undefined ? {} : { livemode: payload.livemode }),
            ...(entity.status === undefined ? {} : { status: entity.status }),
            ...(entity.amount === undefined ? (entity.amount_paid === undefined ? {} : { amount: entity.amount_paid }) : { amount: entity.amount }),
            ...(entity.currency === undefined ? {} : { currency: entity.currency }),
            ...(failure === undefined ? {} : { failure }),
            ...(payload.data.previous_attributes === undefined ? {} : { previousAttributes: payload.data.previous_attributes }),
          },
          links: absoluteLinks([{ rel: "subject", url }]),
          authenticity: "stripe-v1-hmac-sha256",
        },
      }, config),
    };
  }
}
