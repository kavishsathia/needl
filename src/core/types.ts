export const providers = [
  "gitlab",
  "linear",
  "launchdarkly",
  "sentry",
  "posthog",
  "intercom",
  "stripe",
] as const;

export type Provider = (typeof providers)[number];

export type HeaderValue = string | readonly string[] | undefined;
export type WebhookHeaders = Readonly<Record<string, HeaderValue>>;

export interface WebhookRequest {
  readonly tenantId: string;
  readonly rawBody: Uint8Array;
  readonly headers: WebhookHeaders;
  readonly receivedAt: Date;
  readonly sourceId?: string;
}

export interface AdapterConfig {
  /** Current secret first; previous secrets may follow during rotation. */
  readonly secrets: readonly [string, ...string[]];
  readonly enabledEvents?: readonly string[];
  readonly kindMappings?: Readonly<Record<string, string>>;
  readonly clock?: () => Date;
}

export interface EventSource {
  readonly id?: string;
  readonly scope?: string;
}

export interface EntityReference {
  readonly type: string;
  readonly id: string;
  readonly name?: string;
  readonly url?: string;
}

export interface RelationshipEvidence extends EntityReference {
  /** JSON-pointer-like path showing exactly where the relationship came from. */
  readonly evidencePath: string;
}

export interface EvidenceLink {
  readonly rel: string;
  readonly url: string;
}

export interface EventEvidence {
  /** A deliberately bounded provider projection, not an unrestricted customer payload. */
  readonly providerPayload: Readonly<Record<string, unknown>>;
  readonly links: readonly EvidenceLink[];
  readonly authenticity: string;
}

export interface NormalizedEvent {
  readonly id: string;
  readonly deliveryId?: string;
  readonly provider: Provider;
  readonly providerEventType: string;
  readonly tenantId: string;
  readonly source: EventSource;
  readonly occurredAt?: string;
  readonly receivedAt: string;
  readonly kind: string;
  readonly subject: EntityReference;
  readonly relationships: readonly RelationshipEvidence[];
  readonly evidence: EventEvidence;
}

export type IgnoredReason = "unknown_event" | "not_subscribed" | "no_observation";
export type RejectionReason = "unauthenticated" | "malformed" | "stale";

export type AdapterResult =
  | { readonly status: "accepted"; readonly event: NormalizedEvent }
  | {
      readonly status: "ignored";
      readonly provider: Provider;
      readonly tenantId: string;
      readonly receivedAt: string;
      readonly reason: IgnoredReason;
      readonly eventType?: string;
      readonly deliveryId?: string;
    }
  | {
      readonly status: "rejected";
      readonly provider: Provider;
      readonly reason: RejectionReason;
      readonly message: string;
    };

export interface WebhookAdapter<Config extends AdapterConfig = AdapterConfig> {
  readonly provider: Provider;
  ingest(request: WebhookRequest, config: Config): Promise<AdapterResult>;
}

