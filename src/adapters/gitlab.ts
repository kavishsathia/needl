import { Buffer } from "node:buffer";
import { z } from "zod";
import { anySecretMatches, hmac, secureEqual } from "../core/crypto.js";
import {
  absoluteLinks,
  header,
  ignored,
  isEnabled,
  isoDate,
  objectValue,
  parseJson,
  rawText,
  rejected,
  stringValue,
} from "../core/helpers.js";
import type { AdapterConfig, AdapterResult, RelationshipEvidence, WebhookAdapter, WebhookRequest } from "../core/types.js";
import { configuredKind, normalizedEvent } from "./shared.js";

export interface GitLabAdapterConfig extends AdapterConfig {
  /** Explicit mode prevents an absent signature from silently downgrading to a token. */
  readonly authMode: "signing-token" | "secret-token";
  readonly toleranceSeconds?: number;
}

const gitlabPayload = z
  .object({
    object_kind: z.string(),
    event_type: z.string().optional(),
    created_at: z.union([z.string(), z.number()]).optional(),
    ref: z.string().optional(),
    checkout_sha: z.string().nullable().optional(),
    after: z.string().optional(),
    project: z.record(z.string(), z.unknown()).optional(),
    repository: z.record(z.string(), z.unknown()).optional(),
    object_attributes: z.record(z.string(), z.unknown()).optional(),
    commit: z.record(z.string(), z.unknown()).optional(),
    deployment_id: z.union([z.string(), z.number()]).optional(),
    status: z.string().optional(),
    environment: z.string().optional(),
  })
  .passthrough();

const eventTypes: Record<string, { type: string; kind: string; subject: string }> = {
  "Push Hook": { type: "push", kind: "code.push", subject: "repository" },
  "Pipeline Hook": { type: "pipeline", kind: "ci.pipeline", subject: "pipeline" },
  "Deployment Hook": { type: "deployment", kind: "deployment", subject: "deployment" },
  "Merge Request Hook": { type: "merge_request", kind: "change.merge_request", subject: "merge_request" },
  "Issue Hook": { type: "issue", kind: "work.issue", subject: "issue" },
};

function verifySigningToken(request: WebhookRequest, config: GitLabAdapterConfig): AdapterResult | undefined {
  const messageId = header(request.headers, "webhook-id");
  const timestamp = header(request.headers, "webhook-timestamp");
  const signatures = header(request.headers, "webhook-signature");
  if (messageId === undefined || timestamp === undefined || signatures === undefined) {
    return rejected("gitlab", "unauthenticated", "Missing GitLab Standard Webhooks signature headers");
  }
  const timestampNumber = Number(timestamp);
  const tolerance = config.toleranceSeconds ?? 300;
  const now = (config.clock?.() ?? request.receivedAt).getTime() / 1_000;
  if (!Number.isFinite(timestampNumber) || Math.abs(now - timestampNumber) > tolerance) {
    return rejected("gitlab", "stale", "GitLab webhook timestamp is outside the configured tolerance");
  }
  const signed = `${messageId}.${timestamp}.${rawText(request.rawBody)}`;
  let matched = false;
  for (const secret of config.secrets) {
    if (!secret.startsWith("whsec_")) continue;
    let key: Buffer;
    try {
      key = Buffer.from(secret.slice(6), "base64");
    } catch {
      continue;
    }
    const expected = `v1,${hmac("sha256", key, signed, "base64")}`;
    for (const signature of signatures.split(" ")) matched = secureEqual(expected, signature) || matched;
  }
  return matched ? undefined : rejected("gitlab", "unauthenticated", "Invalid GitLab webhook signature");
}

function verifySecretToken(request: WebhookRequest, config: GitLabAdapterConfig): AdapterResult | undefined {
  const token = header(request.headers, "x-gitlab-token");
  if (token === undefined) return rejected("gitlab", "unauthenticated", "Missing X-Gitlab-Token header");
  return anySecretMatches(config.secrets, token, (secret) => secret)
    ? undefined
    : rejected("gitlab", "unauthenticated", "Invalid GitLab secret token");
}

function relation(type: string, id: unknown, evidencePath: string, name?: unknown, url?: unknown): RelationshipEvidence[] {
  const externalId = typeof id === "number" ? String(id) : stringValue(id);
  if (externalId === undefined) return [];
  const relationshipName = stringValue(name);
  const relationshipUrl = stringValue(url);
  return [{
    type,
    id: externalId,
    evidencePath,
    ...(relationshipName === undefined ? {} : { name: relationshipName }),
    ...(relationshipUrl === undefined ? {} : { url: relationshipUrl }),
  }];
}

export class GitLabAdapter implements WebhookAdapter<GitLabAdapterConfig> {
  readonly provider = "gitlab" as const;

  async ingest(request: WebhookRequest, config: GitLabAdapterConfig): Promise<AdapterResult> {
    const authError = config.authMode === "signing-token"
      ? verifySigningToken(request, config)
      : verifySecretToken(request, config);
    if (authError !== undefined) return authError;

    let parsed: unknown;
    try {
      parsed = parseJson(request.rawBody);
    } catch {
      return rejected(this.provider, "malformed", "Body is not valid UTF-8 JSON");
    }
    const payloadResult = gitlabPayload.safeParse(parsed);
    if (!payloadResult.success) return rejected(this.provider, "malformed", "Payload is not a GitLab webhook object");

    const hook = header(request.headers, "x-gitlab-event");
    const descriptor = hook === undefined ? undefined : eventTypes[hook];
    const deliveryId = header(request.headers, "webhook-id")
      ?? header(request.headers, "idempotency-key")
      ?? header(request.headers, "x-gitlab-event-uuid");
    if (descriptor === undefined) return ignored(this.provider, request, "unknown_event", hook, deliveryId);

    const payload = payloadResult.data;
    const attributes = payload.object_attributes ?? {};
    const project = payload.project ?? {};
    const repository = payload.repository ?? {};
    const projectId = project.id;
    const projectPath = stringValue(project.path_with_namespace) ?? stringValue(repository.name);
    const projectUrl = stringValue(project.web_url) ?? stringValue(repository.homepage);
    const attributeId = attributes.id ?? attributes.iid;
    const rawSubjectId = descriptor.type === "push"
      ? stringValue(payload.checkout_sha) ?? stringValue(payload.after) ?? stringValue(payload.ref)
      : descriptor.type === "deployment"
        ? payload.deployment_id ?? attributes.id
        : attributeId;
    const id = typeof rawSubjectId === "number" ? String(rawSubjectId) : stringValue(rawSubjectId);
    if (id === undefined) return rejected(this.provider, "malformed", "Supported GitLab event is missing its subject identifier");
    const subjectUrl = stringValue(attributes.url)
      ?? stringValue(attributes.web_url)
      ?? stringValue(payload.deployable_url)
      ?? projectUrl;
    const action = stringValue(attributes.action) ?? stringValue(attributes.status) ?? payload.status;
    const providerEventType = action === undefined ? descriptor.type : `${descriptor.type}.${action}`;
    if (!isEnabled(config, providerEventType)) {
      return ignored(this.provider, request, "not_subscribed", providerEventType, deliveryId);
    }
    const occurredAt = isoDate(attributes.updated_at)
      ?? isoDate(attributes.created_at)
      ?? isoDate(payload.status_changed_at)
      ?? isoDate(payload.created_at)
      ?? isoDate(objectValue(payload.commit)?.timestamp);
    const relationships = [
      ...relation("project", projectId, "/project/id", projectPath, projectUrl),
      ...relation("repository", projectPath, "/project/path_with_namespace", projectPath, projectUrl),
      ...relation("commit", payload.checkout_sha ?? payload.after ?? objectValue(payload.commit)?.id, "/checkout_sha"),
      ...relation("ref", payload.ref, "/ref"),
      ...relation("environment", payload.environment ?? attributes.environment, "/environment"),
    ];
    const evidencePayload = {
      objectKind: payload.object_kind,
      ...(action === undefined ? {} : { action }),
      ...(payload.status === undefined ? {} : { status: payload.status }),
      ...(payload.ref === undefined ? {} : { ref: payload.ref }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(projectPath === undefined ? {} : { projectPath }),
      ...(attributes.state === undefined ? {} : { state: attributes.state }),
      ...(attributes.status === undefined ? {} : { objectStatus: attributes.status }),
    };
    const sourceId = request.sourceId ?? header(request.headers, "x-gitlab-webhook-uuid");
    const subjectName = stringValue(attributes.title);
    return {
      status: "accepted",
      event: normalizedEvent(this.provider, request, {
        ...(deliveryId === undefined ? {} : { deliveryId }),
        providerEventType,
        source: {
          ...(sourceId === undefined ? {} : { id: sourceId }),
          ...(projectPath === undefined ? {} : { scope: projectPath }),
        },
        ...(occurredAt === undefined ? {} : { occurredAt }),
        kind: configuredKind(config, providerEventType, descriptor.kind),
        subject: {
          type: descriptor.subject,
          id,
          ...(subjectName === undefined ? {} : { name: subjectName }),
          ...(subjectUrl === undefined ? {} : { url: subjectUrl }),
        },
        relationships,
        evidence: {
          providerPayload: evidencePayload,
          links: absoluteLinks([
            { rel: "subject", url: subjectUrl },
            { rel: "project", url: projectUrl },
          ]),
          authenticity: config.authMode === "signing-token" ? "standard-webhooks-hmac-sha256" : "shared-secret-header",
        },
      }, config),
    };
  }
}
