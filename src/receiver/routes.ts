import type { AdapterConfig, Provider, WebhookAdapter } from "../core/types.js";
import type { ReceiverRoute, RouteResolver } from "./types.js";

export class StaticRouteResolver implements RouteResolver {
  readonly #routes = new Map<string, ReceiverRoute>();

  register<Config extends AdapterConfig>(
    tenantId: string,
    provider: Provider,
    adapter: WebhookAdapter<Config>,
    config: Config,
  ): this {
    this.#routes.set(this.#key(tenantId, provider), {
      adapter: adapter as WebhookAdapter<AdapterConfig>,
      config,
    });
    return this;
  }

  async resolve(tenantId: string, provider: Provider): Promise<ReceiverRoute | undefined> {
    return this.#routes.get(this.#key(tenantId, provider));
  }

  #key(tenantId: string, provider: Provider): string {
    return `${tenantId}\u0000${provider}`;
  }
}

