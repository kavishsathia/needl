import type { WebhookRequest } from "../core/types.js";
import type {
  DeduplicatingEventSink,
  ReceiveInput,
  ReceiverOutcome,
  RouteResolver,
  SafeReceiverLogger,
} from "./types.js";

export interface WebhookReceiverOptions {
  readonly routes: RouteResolver;
  readonly sink: DeduplicatingEventSink;
  readonly maxPayloadBytes?: number;
  readonly logger?: SafeReceiverLogger;
  readonly clock?: () => Date;
}

export class WebhookReceiver {
  readonly #routes: RouteResolver;
  readonly #sink: DeduplicatingEventSink;
  readonly #maxPayloadBytes: number;
  readonly #logger: SafeReceiverLogger | undefined;
  readonly #clock: () => Date;

  constructor(options: WebhookReceiverOptions) {
    this.#routes = options.routes;
    this.#sink = options.sink;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? 1_048_576;
    this.#logger = options.logger;
    this.#clock = options.clock ?? (() => new Date());
  }

  async receive(input: ReceiveInput): Promise<ReceiverOutcome> {
    if (input.rawBody.byteLength > this.#maxPayloadBytes) {
      return { statusCode: 413, outcome: "rejected", code: "payload_too_large" };
    }
    const route = await this.#routes.resolve(input.tenantId, input.provider);
    if (route === undefined) return { statusCode: 404, outcome: "route_not_found" };
    const request: WebhookRequest = {
      tenantId: input.tenantId,
      rawBody: input.rawBody,
      headers: input.headers,
      receivedAt: input.receivedAt ?? this.#clock(),
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    };
    const result = await route.adapter.ingest(request, route.config);
    if (result.status === "rejected") {
      const statusCode = result.reason === "malformed" ? 400 : 401;
      this.#logger?.info("webhook_rejected", {
        tenantId: input.tenantId,
        provider: input.provider,
        reason: result.reason,
      });
      return { statusCode, outcome: "rejected", code: result.reason };
    }
    if (result.status === "ignored") {
      this.#logger?.info("webhook_ignored", {
        tenantId: input.tenantId,
        provider: input.provider,
        reason: result.reason,
      });
      return { statusCode: 200, outcome: "ignored", result };
    }
    const scope = {
      tenantId: result.event.tenantId,
      provider: result.event.provider,
      deliveryId: result.event.deliveryId ?? result.event.id,
    };
    try {
      const stored = await this.#sink.store(result.event, scope);
      if (stored === "duplicate") {
        return { statusCode: 200, outcome: "duplicate", eventId: result.event.id };
      }
      this.#logger?.info("webhook_stored", {
        tenantId: input.tenantId,
        provider: input.provider,
        eventId: result.event.id,
      });
      return { statusCode: 200, outcome: "stored", event: result.event };
    } catch {
      this.#logger?.error("webhook_persistence_failed", {
        tenantId: input.tenantId,
        provider: input.provider,
        eventId: result.event.id,
      });
      return { statusCode: 503, outcome: "retry", code: "persistence_unavailable" };
    }
  }
}
