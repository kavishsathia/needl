import type { AdapterConfig, AdapterResult, NormalizedEvent, Provider, WebhookAdapter, WebhookHeaders } from "../core/types.js";

export interface ReceiverRoute {
  readonly adapter: WebhookAdapter<AdapterConfig>;
  readonly config: AdapterConfig;
}

export interface RouteResolver {
  resolve(tenantId: string, provider: Provider): Promise<ReceiverRoute | undefined>;
}

export interface DeduplicationScope {
  readonly tenantId: string;
  readonly provider: Provider;
  readonly deliveryId: string;
}

export interface DeduplicatingEventSink {
  /** Must atomically durably store the event or report an existing scoped delivery. */
  store(event: NormalizedEvent, scope: DeduplicationScope): Promise<"stored" | "duplicate">;
}

export interface ReceiveInput {
  readonly tenantId: string;
  readonly provider: Provider;
  readonly rawBody: Uint8Array;
  readonly headers: WebhookHeaders;
  readonly receivedAt?: Date;
  readonly sourceId?: string;
}

export type ReceiverOutcome =
  | { readonly statusCode: 200; readonly outcome: "stored"; readonly event: NormalizedEvent }
  | { readonly statusCode: 200; readonly outcome: "duplicate"; readonly eventId: string }
  | { readonly statusCode: 200; readonly outcome: "ignored"; readonly result: Extract<AdapterResult, { status: "ignored" }> }
  | { readonly statusCode: 400 | 401 | 413; readonly outcome: "rejected"; readonly code: string }
  | { readonly statusCode: 404; readonly outcome: "route_not_found" }
  | { readonly statusCode: 503; readonly outcome: "retry"; readonly code: "persistence_unavailable" };

export interface SafeReceiverLogger {
  info(message: string, context: Readonly<Record<string, string>>): void;
  error(message: string, context: Readonly<Record<string, string>>): void;
}

