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

export type LaunchDarklyAdapterConfig = AdapterConfig;

const accessSchema = z.object({ action: z.string(), resource: z.string() }).passthrough();
const launchDarklyPayload = z.object({
  _id: z.string(),
  _accountId: z.string().optional(),
  date: z.number(),
  kind: z.string(),
  name: z.string().optional(),
  title: z.string().optional(),
  titleVerb: z.string().optional(),
  accesses: z.array(accessSchema).min(1),
  relatedFlag: z.object({ key: z.string() }).passthrough().optional(),
  _links: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const knownKinds: Record<string, { kind: string; subject: string }> = {
  flag: { kind: "feature_flag.changed", subject: "feature_flag" },
  environment: { kind: "environment.changed", subject: "environment" },
  project: { kind: "project.changed", subject: "project" },
};

function linkHref(links: Record<string, unknown> | undefined, key: string): string | undefined {
  return stringValue(objectValue(links?.[key])?.href);
}

export class LaunchDarklyAdapter implements WebhookAdapter<LaunchDarklyAdapterConfig> {
  readonly provider = "launchdarkly" as const;

  async ingest(request: WebhookRequest, config: LaunchDarklyAdapterConfig): Promise<AdapterResult> {
    const signature = header(request.headers, "x-ld-signature");
    if (signature === undefined) return rejected(this.provider, "unauthenticated", "Missing X-LD-Signature header");
    if (!anySecretMatches(config.secrets, signature, (secret) => hmac("sha256", secret, request.rawBody))) {
      return rejected(this.provider, "unauthenticated", "Invalid LaunchDarkly webhook signature");
    }
    let parsed: unknown;
    try {
      parsed = parseJson(request.rawBody);
    } catch {
      return rejected(this.provider, "malformed", "Body is not valid UTF-8 JSON");
    }
    const result = launchDarklyPayload.safeParse(parsed);
    if (!result.success) return rejected(this.provider, "malformed", "Payload is not a LaunchDarkly audit-log entry");
    const payload = result.data;
    const descriptor = knownKinds[payload.kind];
    const actions = payload.accesses.map((access) => access.action);
    const eventType = `${payload.kind}.${actions.join("+")}`;
    if (descriptor === undefined) return ignored(this.provider, request, "unknown_event", eventType, payload._id);
    if (!isEnabled(config, eventType)) return ignored(this.provider, request, "not_subscribed", eventType, payload._id);
    const relationships: RelationshipEvidence[] = payload.accesses.map((access, index) => ({
      type: "launchdarkly-resource",
      id: access.resource,
      evidencePath: `/accesses/${index}/resource`,
    }));
    if (payload.relatedFlag !== undefined) {
      relationships.push({ type: "feature_flag", id: payload.relatedFlag.key, evidencePath: "/relatedFlag/key" });
    }
    const sitePath = linkHref(payload._links, "site");
    const canonicalPath = linkHref(payload._links, "canonical");
    const links = absoluteLinks([
      { rel: "site", url: sitePath?.startsWith("/") ? `https://app.launchdarkly.com${sitePath}` : sitePath },
      { rel: "canonical", url: canonicalPath?.startsWith("/") ? `https://app.launchdarkly.com${canonicalPath}` : canonicalPath },
    ]);
    const occurredAt = isoDate(payload.date);
    return {
      status: "accepted",
      event: normalizedEvent(this.provider, request, {
        deliveryId: payload._id,
        providerEventType: eventType,
        source: {
          ...(request.sourceId === undefined ? {} : { id: request.sourceId }),
          ...(payload._accountId === undefined ? {} : { scope: payload._accountId }),
        },
        ...(occurredAt === undefined ? {} : { occurredAt }),
        kind: configuredKind(config, eventType, descriptor.kind),
        subject: {
          type: descriptor.subject,
          id: payload._id,
          ...(payload.name === undefined ? {} : { name: payload.name }),
          ...(links[0] === undefined ? {} : { url: links[0].url }),
        },
        relationships,
        evidence: {
          providerPayload: {
            kind: payload.kind,
            actions,
            resources: payload.accesses.map((access) => access.resource),
            ...(payload.titleVerb === undefined ? {} : { titleVerb: payload.titleVerb }),
            ...(payload.relatedFlag === undefined ? {} : { relatedFlag: payload.relatedFlag }),
          },
          links,
          authenticity: "hmac-sha256-raw-body",
        },
      }),
    };
  }
}
