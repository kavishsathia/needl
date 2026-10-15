import { z } from "zod";
import { anySecretMatches, hmac } from "../core/crypto.js";
import {
  absoluteLinks,
  header,
  ignored,
  isEnabled,
  isoDate,
  objectValue,
  parseJson,
  rejected,
  stringValue,
  unixSeconds,
} from "../core/helpers.js";
import type { AdapterConfig, AdapterResult, RelationshipEvidence, WebhookAdapter, WebhookRequest } from "../core/types.js";
import { configuredKind, normalizedEvent } from "./shared.js";

export type SentryAdapterConfig = AdapterConfig;

const sentryPayload = z.object({
  action: z.string(),
  data: z.record(z.string(), z.unknown()),
  installation: z.object({ uuid: z.string() }).passthrough().optional(),
}).passthrough();

const resources: Record<string, { kind: string; dataKey: string; subject: string }> = {
  issue: { kind: "error.issue", dataKey: "issue", subject: "issue" },
  event_alert: { kind: "error.event_alert", dataKey: "event", subject: "error_event" },
  error: { kind: "error.occurred", dataKey: "error", subject: "error_event" },
  metric_alert: { kind: "alert.metric", dataKey: "metric_alert", subject: "metric_alert" },
};

function relationship(type: string, id: unknown, path: string): RelationshipEvidence[] {
  const value = typeof id === "number" ? String(id) : stringValue(id);
  return value === undefined ? [] : [{ type, id: value, evidencePath: path }];
}

/** Event tags arrive as `[key, value]` pairs (or `{ key, value }` objects); each becomes a `tag.<key>` relationship. */
function tagRelationships(tags: unknown, basePath: string): RelationshipEvidence[] {
  if (!Array.isArray(tags)) return [];
  return tags.slice(0, 100).flatMap((tag, index) => {
    const pair = Array.isArray(tag) ? { key: tag[0], value: tag[1] } : objectValue(tag);
    const key = stringValue(pair?.key);
    if (key === undefined || !/^[A-Za-z0-9_.-]{1,64}$/.test(key)) return [];
    return relationship(`tag.${key}`, pair?.value, `${basePath}/tags/${index}`);
  });
}

export class SentryAdapter implements WebhookAdapter<SentryAdapterConfig> {
  readonly provider = "sentry" as const;

  async ingest(request: WebhookRequest, config: SentryAdapterConfig): Promise<AdapterResult> {
    const signature = header(request.headers, "sentry-hook-signature");
    if (signature === undefined) return rejected(this.provider, "unauthenticated", "Missing Sentry-Hook-Signature header");
    if (!anySecretMatches(config.secrets, signature, (secret) => hmac("sha256", secret, request.rawBody))) {
      return rejected(this.provider, "unauthenticated", "Invalid Sentry webhook signature");
    }
    let parsed: unknown;
    try {
      parsed = parseJson(request.rawBody);
    } catch {
      return rejected(this.provider, "malformed", "Body is not valid UTF-8 JSON");
    }
    const result = sentryPayload.safeParse(parsed);
    if (!result.success) return rejected(this.provider, "malformed", "Payload is not a Sentry integration webhook object");
    const payload = result.data;
    const resource = header(request.headers, "sentry-hook-resource");
    const descriptor = resource === undefined ? undefined : resources[resource];
    const eventType = `${resource ?? "unknown"}.${payload.action}`;
    const deliveryId = header(request.headers, "request-id");
    if (descriptor === undefined) return ignored(this.provider, request, "unknown_event", eventType, deliveryId);
    if (!isEnabled(config, eventType)) return ignored(this.provider, request, "not_subscribed", eventType, deliveryId);
    const entity = objectValue(payload.data[descriptor.dataKey]);
    if (entity === undefined) return rejected(this.provider, "malformed", `Sentry ${resource} webhook is missing data.${descriptor.dataKey}`);
    const subjectId = stringValue(entity.id) ?? stringValue(entity.event_id) ?? stringValue(entity.eventID) ?? stringValue(entity.shortId);
    if (subjectId === undefined) return rejected(this.provider, "malformed", "Supported Sentry event is missing its subject identifier");
    const project = objectValue(entity.project);
    const alertRule = objectValue(entity.alert_rule);
    const projectId = stringValue(project?.slug)
      ?? (typeof entity.project === "number" ? String(entity.project) : stringValue(entity.project));
    const url = stringValue(entity.permalink) ?? stringValue(entity.web_url) ?? stringValue(entity.url);
    // Event payloads carry `timestamp` as fractional Unix seconds; issue payloads use ISO strings.
    const occurredAt = (typeof entity.timestamp === "number" ? unixSeconds(entity.timestamp) : isoDate(entity.timestamp))
      ?? isoDate(entity.lastSeen)
      ?? isoDate(entity.date_started)
      ?? isoDate(header(request.headers, "sentry-hook-timestamp"));
    const tags = tagRelationships(entity.tags, `/data/${descriptor.dataKey}`);
    const relationships = [
      ...relationship("project", projectId, project === undefined ? `/data/${descriptor.dataKey}/project` : `/data/${descriptor.dataKey}/project/slug`),
      ...relationship("release", entity.release, `/data/${descriptor.dataKey}/release`),
      ...relationship("environment", entity.environment, `/data/${descriptor.dataKey}/environment`),
      ...relationship("alert-rule", alertRule?.id, `/data/${descriptor.dataKey}/alert_rule/id`),
      ...tags,
    ];
    // Event alerts report the environment only as a tag.
    if (entity.environment === undefined) {
      const tagged = tags.find((tag) => tag.type === "tag.environment");
      if (tagged !== undefined) relationships.push({ type: "environment", id: tagged.id, evidencePath: tagged.evidencePath });
    }
    const sourceId = request.sourceId ?? payload.installation?.uuid;
    const subjectName = stringValue(entity.title);
    return {
      status: "accepted",
      event: normalizedEvent(this.provider, request, {
        ...(deliveryId === undefined ? {} : { deliveryId }),
        providerEventType: eventType,
        source: {
          ...(sourceId === undefined ? {} : { id: sourceId }),
          ...(projectId === undefined ? {} : { scope: projectId }),
        },
        ...(occurredAt === undefined ? {} : { occurredAt }),
        kind: configuredKind(config, eventType, descriptor.kind),
        subject: {
          type: descriptor.subject,
          id: subjectId,
          ...(subjectName === undefined ? {} : { name: subjectName }),
          ...(url === undefined ? {} : { url }),
        },
        relationships,
        evidence: {
          providerPayload: {
            action: payload.action,
            resource,
            ...(entity.status === undefined ? {} : { status: entity.status }),
            ...(entity.level === undefined ? {} : { level: entity.level }),
            ...(entity.shortId === undefined ? {} : { shortId: entity.shortId }),
          },
          links: absoluteLinks([{ rel: "subject", url }]),
          authenticity: "hmac-sha256-raw-body",
        },
      }, config),
    };
  }
}
