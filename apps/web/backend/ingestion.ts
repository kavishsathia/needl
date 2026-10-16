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
import { SecretBox } from "./secrets.js";

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

function configFor(integration: StoredIntegration, environment: NodeJS.ProcessEnv, box: () => SecretBox): AdapterConfig {
  const secondary = Array.isArray(integration.config.secondarySecretEnvNames)
    ? integration.config.secondarySecretEnvNames.filter((value): value is string => typeof value === "string" && /^[A-Z][A-Z0-9_]{2,100}$/.test(value))
    : [];
  // Secrets saved through the app are sealed in the database; older routes reference a server environment variable.
  const primary = integration.secretCiphertext !== undefined ? box().open(integration.secretCiphertext) : secret(environment, integration.secretEnvName);
  const secrets = [primary, ...secondary.map((name) => secret(environment, name))] as [string, ...string[]];
  const allowed = new Set(["authMode", "toleranceSeconds", "toleranceMilliseconds", "enabledEvents", "kindMappings", "payloadRetention", "authentication", "headerName", "prefix"]);
  const configured: Record<string, unknown> = { secrets };
  for (const [key, value] of Object.entries(integration.config)) if (allowed.has(key)) configured[key] = value;
  return configured as unknown as AdapterConfig;
}

/** Short, user-facing summary of a delivery for the setup screen; never includes payload content. */
function deliveryDetail(outcome: ReceiverOutcome): string | undefined {
  if (outcome.outcome === "rejected" || outcome.outcome === "retry") return outcome.code;
  if (outcome.outcome === "ignored") return `${outcome.result.reason}${outcome.result.eventType === undefined ? "" : `: ${outcome.result.eventType}`}`;
  if (outcome.outcome === "stored") return outcome.event.providerEventType;
  return undefined;
}

export class SignedIngestionService {
  #box: SecretBox | undefined;

  constructor(private readonly repository: NeedlRepository, private readonly environment: NodeJS.ProcessEnv = process.env, box?: SecretBox) {
    this.#box = box;
  }

  async receive(integrationId: string, rawBody: Uint8Array, headers: WebhookHeaders, receivedAt = new Date()): Promise<ReceiverOutcome> {
    const integration = await this.repository.getIntegration(integrationId);
    if ((integration.config.purpose ?? "ingestion") !== "ingestion") return { statusCode: 404, outcome: "route_not_found" };
    if (!integration.enabled) {
      // A route created in the app but not finished yet: tell the person setting it up that webhooks are arriving.
      if (integration.secretCiphertext === undefined && integration.secretEnvName === "") await this.repository.recordDeliveryAttempt(integration.id, "no_secret", undefined, receivedAt);
      return { statusCode: 404, outcome: "route_not_found" };
    }
    const outcome = await this.#receive(integration, rawBody, headers, receivedAt);
    await this.repository.recordDeliveryAttempt(integration.id, outcome.outcome, deliveryDetail(outcome), receivedAt).catch(() => undefined);
    return outcome;
  }

  async #receive(integration: StoredIntegration, rawBody: Uint8Array, headers: WebhookHeaders, receivedAt: Date): Promise<ReceiverOutcome> {
    const selectedProvider = provider(integration.provider);
    const routes = new StaticRouteResolver().register(
      integration.tenantId,
      selectedProvider,
      adapterByProvider[selectedProvider],
      configFor(integration, this.environment, () => this.#box ??= SecretBox.fromEnvironment(this.environment)),
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
