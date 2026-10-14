import { Buffer } from "node:buffer";
import { z } from "zod";
import { hmac, secureEqual } from "../core/crypto.js";
import {
  absoluteLinks,
  header,
  ignored,
  isEnabled,
  isoDate,
  parseJson,
  rawText,
  rejected,
  stringValue,
} from "../core/helpers.js";
import type { AdapterConfig, AdapterResult, RelationshipEvidence, WebhookAdapter, WebhookRequest } from "../core/types.js";
import { configuredKind, normalizedEvent } from "./shared.js";

export interface PostHogAdapterConfig extends AdapterConfig {
  readonly authentication:
    | { readonly mode: "standard-webhooks"; readonly toleranceSeconds?: number }
    | { readonly mode: "shared-header"; readonly headerName: string; readonly prefix?: string };
}

const relationshipSchema = z.object({
  type: z.string(),
  id: z.string(),
  url: z.string().optional(),
});

const eventSchema = z.object({
  uuid: z.string(),
  event: z.string(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  distinct_id: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const postHogPayload = z.union([
  z.object({
    event: eventSchema,
    project_id: z.union([z.string(), z.number()]).optional(),
    relationships: z.array(relationshipSchema).optional(),
  }).passthrough().transform((value) => ({ ...value.event, project_id: value.project_id, relationships: value.relationships })),
  eventSchema.extend({
    project_id: z.union([z.string(), z.number()]).optional(),
    relationships: z.array(relationshipSchema).optional(),
  }),
]);

function verifyStandard(request: WebhookRequest, config: PostHogAdapterConfig): AdapterResult | undefined {
  const id = header(request.headers, "webhook-id");
  const timestamp = header(request.headers, "webhook-timestamp");
  const signatures = header(request.headers, "webhook-signature");
  if (id === undefined || timestamp === undefined || signatures === undefined) {
    return rejected("posthog", "unauthenticated", "Missing Standard Webhooks signature headers");
  }
  const parsedTimestamp = Number(timestamp);
  const auth = config.authentication;
  const tolerance = auth.mode === "standard-webhooks" ? auth.toleranceSeconds ?? 300 : 300;
  const now = (config.clock?.() ?? request.receivedAt).getTime() / 1_000;
  if (!Number.isFinite(parsedTimestamp) || Math.abs(now - parsedTimestamp) > tolerance) {
    return rejected("posthog", "stale", "PostHog webhook timestamp is outside the configured tolerance");
  }
  const signed = `${id}.${timestamp}.${rawText(request.rawBody)}`;
  let matched = false;
  for (const secret of config.secrets) {
    if (!secret.startsWith("whsec_")) continue;
    const key = Buffer.from(secret.slice(6), "base64");
    const expected = `v1,${hmac("sha256", key, signed, "base64")}`;
    for (const signature of signatures.split(" ")) matched = secureEqual(expected, signature) || matched;
  }
  return matched ? undefined : rejected("posthog", "unauthenticated", "Invalid PostHog Standard Webhooks signature");
}

function verifySharedHeader(request: WebhookRequest, config: PostHogAdapterConfig): AdapterResult | undefined {
  const auth = config.authentication;
  if (auth.mode !== "shared-header") return undefined;
  const received = header(request.headers, auth.headerName);
  if (received === undefined) return rejected("posthog", "unauthenticated", `Missing ${auth.headerName} header`);
  let matched = false;
  for (const secret of config.secrets) matched = secureEqual(`${auth.prefix ?? ""}${secret}`, received) || matched;
  return matched ? undefined : rejected("posthog", "unauthenticated", "Invalid PostHog shared authentication header");
}

export class PostHogAdapter implements WebhookAdapter<PostHogAdapterConfig> {
  readonly provider = "posthog" as const;

  async ingest(request: WebhookRequest, config: PostHogAdapterConfig): Promise<AdapterResult> {
    const authError = config.authentication.mode === "standard-webhooks"
      ? verifyStandard(request, config)
      : verifySharedHeader(request, config);
    if (authError !== undefined) return authError;
    let parsed: unknown;
    try {
      parsed = parseJson(request.rawBody);
    } catch {
      return rejected(this.provider, "malformed", "Body is not valid UTF-8 JSON");
    }
    const result = postHogPayload.safeParse(parsed);
    if (!result.success) {
      return rejected(this.provider, "malformed", "Payload does not match Needl's documented PostHog destination template");
    }
    const payload = result.data;
    if (!isEnabled(config, payload.event)) return ignored(this.provider, request, "not_subscribed", payload.event, payload.uuid);
    const relationships: RelationshipEvidence[] = (payload.relationships ?? []).map((relationship, index) => ({
      type: relationship.type,
      id: relationship.id,
      evidencePath: `/relationships/${index}`,
      ...(relationship.url === undefined ? {} : { url: relationship.url }),
    }));
    const currentUrl = stringValue(payload.properties?.$current_url);
    const projectScope = payload.project_id === undefined ? undefined : String(payload.project_id);
    return {
      status: "accepted",
      event: normalizedEvent(this.provider, request, {
        deliveryId: header(request.headers, "webhook-id") ?? payload.uuid,
        providerEventType: payload.event,
        source: {
          ...(request.sourceId === undefined ? {} : { id: request.sourceId }),
          ...(projectScope === undefined ? {} : { scope: projectScope }),
        },
        ...(isoDate(payload.timestamp) === undefined ? {} : { occurredAt: isoDate(payload.timestamp) as string }),
        kind: configuredKind(config, payload.event, "product.event"),
        subject: {
          type: "product_event",
          id: payload.uuid,
          name: payload.event,
          ...(currentUrl === undefined ? {} : { url: currentUrl }),
        },
        relationships,
        evidence: {
          providerPayload: {
            event: payload.event,
            ...(payload.distinct_id === undefined ? {} : { distinctId: payload.distinct_id }),
            ...(payload.properties?.$session_id === undefined ? {} : { sessionId: payload.properties.$session_id }),
          },
          links: absoluteLinks([{ rel: "page", url: currentUrl }]),
          authenticity: config.authentication.mode === "standard-webhooks"
            ? "standard-webhooks-hmac-sha256"
            : "configured-shared-header",
        },
      }),
    };
  }
}

