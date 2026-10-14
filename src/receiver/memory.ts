import type { NormalizedEvent } from "../core/types.js";
import type { DeduplicatingEventSink, DeduplicationScope } from "./types.js";

export class InMemoryEventSink implements DeduplicatingEventSink {
  readonly #events = new Map<string, NormalizedEvent>();

  async store(event: NormalizedEvent, scope: DeduplicationScope): Promise<"stored" | "duplicate"> {
    const key = `${scope.tenantId}\u0000${scope.provider}\u0000${scope.deliveryId}`;
    if (this.#events.has(key)) return "duplicate";
    this.#events.set(key, event);
    return "stored";
  }

  values(): readonly NormalizedEvent[] {
    return [...this.#events.values()];
  }
}

