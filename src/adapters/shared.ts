import { stableId } from "../core/crypto.js";
import { rawText, receivedAt } from "../core/helpers.js";
import type {
  AdapterConfig,
  EntityReference,
  EventEvidence,
  EventSource,
  NormalizedEvent,
  Provider,
  RelationshipEvidence,
  WebhookRequest,
} from "../core/types.js";

export interface EventParts {
  readonly deliveryId?: string;
  readonly providerEventType: string;
  readonly source?: EventSource;
  readonly occurredAt?: string;
  readonly kind: string;
  readonly subject: EntityReference;
  readonly relationships?: readonly RelationshipEvidence[];
  readonly evidence: EventEvidence;
}

export function normalizedEvent(
  provider: Provider,
  request: WebhookRequest,
  parts: EventParts,
): NormalizedEvent {
  const source = parts.source ?? {
    ...(request.sourceId === undefined ? {} : { id: request.sourceId }),
  };
  const identity = parts.deliveryId ?? rawText(request.rawBody);
  return {
    id: stableId([provider, request.tenantId, source.id, identity]),
    ...(parts.deliveryId === undefined ? {} : { deliveryId: parts.deliveryId }),
    provider,
    providerEventType: parts.providerEventType,
    tenantId: request.tenantId,
    source,
    ...(parts.occurredAt === undefined ? {} : { occurredAt: parts.occurredAt }),
    receivedAt: receivedAt(request),
    kind: parts.kind,
    subject: parts.subject,
    relationships: parts.relationships ?? [],
    evidence: parts.evidence,
  };
}

export function configuredKind(
  config: AdapterConfig,
  eventType: string,
  fallback: string,
): string {
  return config.kindMappings?.[eventType] ?? fallback;
}

