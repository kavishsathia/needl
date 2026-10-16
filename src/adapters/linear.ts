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
} from "../core/helpers.js";
import type { AdapterConfig, AdapterResult, RelationshipEvidence, WebhookAdapter, WebhookRequest } from "../core/types.js";
import { configuredKind, normalizedEvent } from "./shared.js";

export interface LinearAdapterConfig extends AdapterConfig {
  readonly toleranceMilliseconds?: number;
}

const linearPayload = z.object({
  action: z.string(),
  type: z.string(),
  createdAt: z.string().optional(),
  webhookTimestamp: z.number(),
  webhookId: z.string().optional(),
  organizationId: z.string().optional(),
  url: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  issueData: z.record(z.string(), z.unknown()).optional(),
  updatedFrom: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const knownTypes: Record<string, { kind: string; subject: string }> = {
  Issue: { kind: "work.issue", subject: "issue" },
  Comment: { kind: "work.comment", subject: "comment" },
  IssueSLA: { kind: "work.issue_sla", subject: "issue" },
};

function relation(type: string, id: unknown, evidencePath: string): RelationshipEvidence[] {
  const value = stringValue(id);
  return value === undefined ? [] : [{ type, id: value, evidencePath }];
}

export class LinearAdapter implements WebhookAdapter<LinearAdapterConfig> {
  readonly provider = "linear" as const;

  async ingest(request: WebhookRequest, config: LinearAdapterConfig): Promise<AdapterResult> {
    const signature = header(request.headers, "linear-signature");
    if (signature === undefined) return rejected(this.provider, "unauthenticated", "Missing Linear-Signature header");
    if (!anySecretMatches(config.secrets, signature, (secret) => hmac("sha256", secret, request.rawBody))) {
      return rejected(this.provider, "unauthenticated", "Invalid Linear webhook signature");
    }
    let parsed: unknown;
    try {
      parsed = parseJson(request.rawBody);
    } catch {
      return rejected(this.provider, "malformed", "Body is not valid UTF-8 JSON");
    }
    const result = linearPayload.safeParse(parsed);
    if (!result.success) return rejected(this.provider, "malformed", "Payload is not a Linear webhook object");
    const payload = result.data;
    const now = (config.clock?.() ?? request.receivedAt).getTime();
    if (Math.abs(now - payload.webhookTimestamp) > (config.toleranceMilliseconds ?? 60_000)) {
      return rejected(this.provider, "stale", "Linear webhook timestamp is outside the configured tolerance");
    }
    const descriptor = knownTypes[payload.type];
    const deliveryId = header(request.headers, "linear-delivery") ?? payload.webhookId;
    if (descriptor === undefined) return ignored(this.provider, request, "unknown_event", `${payload.type}.${payload.action}`, deliveryId);
    const eventType = `${payload.type}.${payload.action}`;
    if (!isEnabled(config, eventType)) return ignored(this.provider, request, "not_subscribed", eventType, deliveryId);
    const data = payload.type === "IssueSLA" ? payload.issueData : payload.data;
    if (data === undefined) return rejected(this.provider, "malformed", "Supported Linear event is missing its data object");
    const subjectId = stringValue(data.id) ?? stringValue(data.issueId);
    if (subjectId === undefined) return rejected(this.provider, "malformed", "Supported Linear event is missing its subject identifier");
    const issueId = payload.type === "Comment" ? data.issueId : data.id;
    const identifier = stringValue(data.identifier);
    const relationships = [
      ...relation("issue", issueId, payload.type === "Comment" ? "/data/issueId" : "/data/id"),
      ...relation("issue-key", identifier, "/data/identifier"),
      ...relation("team", data.teamId, "/data/teamId"),
      ...relation("project", data.projectId, "/data/projectId"),
    ];
    // Issue payloads carry the workflow state as an object; its type is Linear's fixed category (completed, started, …).
    const state = objectValue(data.state);
    const stateName = stringValue(state?.name);
    const stateType = stringValue(state?.type);
    const stateChanged = payload.type === "Issue" && payload.action === "update" && payload.updatedFrom !== undefined
      ? Object.prototype.hasOwnProperty.call(payload.updatedFrom, "stateId")
      : undefined;
    const occurredAt = isoDate(payload.createdAt);
    const url = stringValue(data.url) ?? payload.url;
    const subjectName = stringValue(data.title);
    return {
      status: "accepted",
      event: normalizedEvent(this.provider, request, {
        ...(deliveryId === undefined ? {} : { deliveryId }),
        providerEventType: eventType,
        source: {
          ...(request.sourceId === undefined ? {} : { id: request.sourceId }),
          ...(payload.organizationId === undefined ? {} : { scope: payload.organizationId }),
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
            type: payload.type,
            ...(identifier === undefined ? {} : { identifier }),
            ...(data.stateId === undefined ? {} : { stateId: data.stateId }),
            ...(stateName === undefined ? {} : { stateName }),
            ...(stateType === undefined ? {} : { stateType }),
            ...(stateChanged === undefined ? {} : { stateChanged }),
            ...(data.priority === undefined ? {} : { priority: data.priority }),
            ...(payload.updatedFrom === undefined ? {} : { updatedFrom: payload.updatedFrom }),
          },
          links: absoluteLinks([{ rel: "subject", url }]),
          authenticity: "hmac-sha256-raw-body",
        },
      }, config),
    };
  }
}
