import {
  GitLabAdapter,
  IntercomAdapter,
  LaunchDarklyAdapter,
  LinearAdapter,
  PostHogAdapter,
  SentryAdapter,
  StripeAdapter,
} from "../../../src/adapters/index.js";
import { providers, type AdapterConfig, type Provider, type WebhookAdapter, type WebhookHeaders } from "../../../src/core/types.js";
import { StaticRouteResolver, WebhookReceiver, type ReceiverOutcome } from "../../../src/receiver/index.js";
import type { NeedlRepository, StoredIntegration } from "./repository.js";

const adapterByProvider: Readonly<Record<Provider, WebhookAdapter<AdapterConfig>>> = {
  gitlab: new GitLabAdapter() as WebhookAdapter<AdapterConfig>,
  linear: new LinearAdapter() as WebhookAdapter<AdapterConfig>,
  launchdarkly: new LaunchDarklyAdapter() as WebhookAdapter<AdapterConfig>,
  sentry: new SentryAdapter() as WebhookAdapter<AdapterConfig>,
  posthog: new PostHogAdapter() as WebhookAdapter<AdapterConfig>,
  intercom: new IntercomAdapter() as WebhookAdapter<AdapterConfig>,
  stripe: new StripeAdapter() as WebhookAdapter<AdapterConfig>,
};

function provider(value: string): Provider {
  if (!providers.includes(value as Provider)) throw Object.assign(new Error("Integration provider is unsupported"), { statusCode: 400 });
  return value as Provider;
}

function secret(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw Object.assign(new Error(`Integration credential ${name} is not configured on the server`), { statusCode: 503 });
  }
  return value;
}

function configFor(integration: StoredIntegration, environment: NodeJS.ProcessEnv): AdapterConfig {
  const secondary = Array.isArray(integration.config.secondarySecretEnvNames)
    ? integration.config.secondarySecretEnvNames.filter((value): value is string => typeof value === "string" && /^[A-Z][A-Z0-9_]{2,100}$/.test(value))
    : [];
  const secrets = [secret(environment, integration.secretEnvName), ...secondary.map((name) => secret(environment, name))] as [string, ...string[]];
  const allowed = new Set(["authMode", "toleranceSeconds", "toleranceMilliseconds", "enabledEvents", "kindMappings", "payloadRetention", "authentication", "headerName", "prefix"]);
  const configured: Record<string, unknown> = { secrets };
  for (const [key, value] of Object.entries(integration.config)) if (allowed.has(key)) configured[key] = value;
  return configured as unknown as AdapterConfig;
}

export class SignedIngestionService {
  constructor(private readonly repository: NeedlRepository, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async receive(integrationId: string, rawBody: Uint8Array, headers: WebhookHeaders, receivedAt = new Date()): Promise<ReceiverOutcome> {
    const integration = await this.repository.getIntegration(integrationId);
    if (!integration.enabled || (integration.config.purpose ?? "ingestion") !== "ingestion") {
      return { statusCode: 404, outcome: "route_not_found" };
    }
    const selectedProvider = provider(integration.provider);
    const routes = new StaticRouteResolver().register(
      integration.tenantId,
      selectedProvider,
      adapterByProvider[selectedProvider],
      configFor(integration, this.environment),
    );
    return new WebhookReceiver({ routes, sink: this.repository }).receive({
      tenantId: integration.tenantId,
      provider: selectedProvider,
      rawBody,
      headers,
      receivedAt,
      sourceId: integration.id,
    });
  }
}
