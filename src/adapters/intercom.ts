import { z } from "zod";
import { anySecretMatches, hmac } from "../core/crypto.js";
import {
  absoluteLinks,
  header,
  ignored,
  isEnabled,
  objectValue,
  parseJson,
  rejected,
  stringValue,
  unixSeconds,
} from "../core/helpers.js";
import type { AdapterConfig, AdapterResult, RelationshipEvidence, WebhookAdapter, WebhookRequest } from "../core/types.js";
import { configuredKind, normalizedEvent } from "./shared.js";

export type IntercomAdapterConfig = AdapterConfig;

const intercomPayload = z.object({
  type: z.literal("notification_event"),
  id: z.string(),
  topic: z.string(),
  app_id: z.string(),
  created_at: z.number().optional(),
  delivery_attempts: z.number().optional(),
  data: z.object({
    type: z.string(),
    item: z.record(z.string(), z.unknown()),
  }).passthrough(),
}).passthrough();

const topics: Record<string, { kind: string; subject: string }> = {
  "conversation.user.created": { kind: "support.customer_replied", subject: "conversation" },
  "conversation.admin.replied": { kind: "support.admin_replied", subject: "conversation" },
  "conversation.admin.closed": { kind: "support.conversation_closed", subject: "conversation" },
  "ticket.created": { kind: "support.ticket_created", subject: "ticket" },
  "ticket.updated": { kind: "support.ticket_updated", subject: "ticket" },
  "contact.created": { kind: "customer.created", subject: "contact" },
  "contact.updated": { kind: "customer.updated", subject: "contact" },
};

function relation(type: string, id: unknown, path: string): RelationshipEvidence[] {
  const value = stringValue(id);
  return value === undefined ? [] : [{ type, id: value, evidencePath: path }];
}

export class IntercomAdapter implements WebhookAdapter<IntercomAdapterConfig> {
  readonly provider = "intercom" as const;

  async ingest(request: WebhookRequest, config: IntercomAdapterConfig): Promise<AdapterResult> {
    const signature = header(request.headers, "x-hub-signature");
    if (signature === undefined) return rejected(this.provider, "unauthenticated", "Missing X-Hub-Signature header");
    if (!anySecretMatches(config.secrets, signature, (secret) => `sha1=${hmac("sha1", secret, request.rawBody)}`)) {
      return rejected(this.provider, "unauthenticated", "Invalid Intercom webhook signature");
    }
    let parsed: unknown;
    try {
      parsed = parseJson(request.rawBody);
    } catch {
      return rejected(this.provider, "malformed", "Body is not valid UTF-8 JSON");
    }
    const result = intercomPayload.safeParse(parsed);
    if (!result.success) return rejected(this.provider, "malformed", "Payload is not an Intercom notification event");
    const payload = result.data;
    const descriptor = topics[payload.topic];
    if (descriptor === undefined) return ignored(this.provider, request, "unknown_event", payload.topic, payload.id);
    if (!isEnabled(config, payload.topic)) return ignored(this.provider, request, "not_subscribed", payload.topic, payload.id);
    const item = payload.data.item;
    const subjectId = stringValue(item.id) ?? stringValue(item.ticket_id);
    if (subjectId === undefined) return rejected(this.provider, "malformed", "Supported Intercom event is missing its subject identifier");
    // Conversations and tickets list contacts under contacts.contacts; other topics carry contact or contact_id.
    const listed = objectValue(item.contacts)?.contacts;
    const contact = objectValue(item.contact) ?? (Array.isArray(listed) ? objectValue(listed[0]) : undefined);
    const url = stringValue(item.url) ?? stringValue(item.link);
    const occurredAt = unixSeconds(payload.created_at);
    const subjectName = stringValue(item.title);
    const relationships = [
      ...relation("conversation", item.conversation_id, "/data/item/conversation_id"),
      ...relation("ticket", item.ticket_id, "/data/item/ticket_id"),
      ...relation("contact", item.contact_id ?? contact?.id, item.contact_id !== undefined ? "/data/item/contact_id" : objectValue(item.contact) !== undefined ? "/data/item/contact/id" : "/data/item/contacts/contacts/0/id"),
    ];
    return {
      status: "accepted",
      event: normalizedEvent(this.provider, request, {
        deliveryId: payload.id,
        providerEventType: payload.topic,
        source: { ...(request.sourceId === undefined ? {} : { id: request.sourceId }), scope: payload.app_id },
        ...(occurredAt === undefined ? {} : { occurredAt }),
        kind: configuredKind(config, payload.topic, descriptor.kind),
        subject: {
          type: descriptor.subject,
          id: subjectId,
          ...(subjectName === undefined ? {} : { name: subjectName }),
          ...(url === undefined ? {} : { url }),
        },
        relationships,
        evidence: {
          providerPayload: {
            topic: payload.topic,
            itemType: item.type,
            ...(item.state === undefined ? {} : { state: item.state }),
            // ticket_state is an object ({ category, internal_label }) in current payloads and a string in older ones.
            ...(item.ticket_state === undefined ? {} : { ticketState: stringValue(item.ticket_state) ?? stringValue(objectValue(item.ticket_state)?.category) ?? item.ticket_state }),
            ...(payload.delivery_attempts === undefined ? {} : { deliveryAttempts: payload.delivery_attempts }),
          },
          links: absoluteLinks([{ rel: "subject", url }]),
          authenticity: "hmac-sha1-raw-body",
        },
      }, config),
    };
  }
}
