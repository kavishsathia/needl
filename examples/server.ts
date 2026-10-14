import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  GitLabAdapter,
  IntercomAdapter,
  LaunchDarklyAdapter,
  LinearAdapter,
  PostHogAdapter,
  SentryAdapter,
  StripeAdapter,
} from "../src/adapters/index.js";
import { providers, type Provider, type WebhookHeaders } from "../src/core/index.js";
import {
  SqliteEventStore,
  StaticRouteResolver,
  WebhookReceiver,
  type DeduplicatingEventSink,
  type RouteResolver,
} from "../src/receiver/index.js";

export interface ExampleServerOptions {
  readonly routes: RouteResolver;
  readonly sink: DeduplicatingEventSink;
  readonly maxPayloadBytes?: number;
  readonly clock?: () => Date;
}

class PayloadTooLargeError extends Error {}

async function bodyBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > limit) throw new PayloadTooLargeError();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function webhookHeaders(headers: IncomingHttpHeaders): WebhookHeaders {
  const result: Record<string, string | readonly string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) result[name] = value;
  return result;
}

function isProvider(value: string): value is Provider {
  return (providers as readonly string[]).includes(value);
}

function reply(response: ServerResponse, statusCode: number, body: Readonly<Record<string, unknown>>): void {
  const json = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
  });
  response.end(json);
}

export function createExampleServer(options: ExampleServerOptions): Server {
  const maxPayloadBytes = options.maxPayloadBytes ?? 1_048_576;
  const receiver = new WebhookReceiver({
    routes: options.routes,
    sink: options.sink,
    maxPayloadBytes,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        reply(response, 200, { status: "ok" });
        return;
      }
      const match = /^\/webhooks\/([^/]+)\/([^/?]+)$/.exec(request.url ?? "");
      if (request.method !== "POST" || match === null) {
        reply(response, 404, { outcome: "not_found" });
        return;
      }
      const tenantId = decodeURIComponent(match[1] as string);
      const providerValue = decodeURIComponent(match[2] as string);
      if (!isProvider(providerValue)) {
        reply(response, 404, { outcome: "not_found" });
        return;
      }
      const rawBody = await bodyBytes(request, maxPayloadBytes);
      const outcome = await receiver.receive({
        tenantId,
        provider: providerValue,
        rawBody,
        headers: webhookHeaders(request.headers),
      });
      reply(response, outcome.statusCode, {
        outcome: outcome.outcome,
        ...(outcome.outcome === "stored" ? { eventId: outcome.event.id } : {}),
        ...(outcome.outcome === "duplicate" ? { eventId: outcome.eventId } : {}),
        ...(outcome.outcome === "rejected" || outcome.outcome === "retry" ? { code: outcome.code } : {}),
      });
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        reply(response, 413, { outcome: "rejected", code: "payload_too_large" });
        return;
      }
      reply(response, 500, { outcome: "internal_error" });
    }
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function routesFromEnvironment(): { tenantId: string; routes: StaticRouteResolver } {
  const tenantId = required("NEEDL_TENANT_ID");
  const gitlabMode = process.env.GITLAB_AUTH_MODE === "secret-token" ? "secret-token" : "signing-token";
  const postHogMode = process.env.POSTHOG_AUTH_MODE === "shared-header" ? "shared-header" : "standard-webhooks";
  const routes = new StaticRouteResolver()
    .register(tenantId, "gitlab", new GitLabAdapter(), {
      authMode: gitlabMode,
      secrets: [required("GITLAB_WEBHOOK_SECRET")],
    })
    .register(tenantId, "linear", new LinearAdapter(), { secrets: [required("LINEAR_WEBHOOK_SECRET")] })
    .register(tenantId, "launchdarkly", new LaunchDarklyAdapter(), { secrets: [required("LAUNCHDARKLY_WEBHOOK_SECRET")] })
    .register(tenantId, "sentry", new SentryAdapter(), { secrets: [required("SENTRY_WEBHOOK_SECRET")] })
    .register(tenantId, "posthog", new PostHogAdapter(), {
      secrets: [required("POSTHOG_WEBHOOK_SECRET")],
      authentication: postHogMode === "standard-webhooks"
        ? { mode: "standard-webhooks" }
        : {
            mode: "shared-header",
            headerName: process.env.POSTHOG_SHARED_HEADER ?? "Authorization",
            prefix: process.env.POSTHOG_SHARED_PREFIX ?? "Bearer ",
          },
    })
    .register(tenantId, "intercom", new IntercomAdapter(), { secrets: [required("INTERCOM_WEBHOOK_SECRET")] })
    .register(tenantId, "stripe", new StripeAdapter(), { secrets: [required("STRIPE_WEBHOOK_SECRET")] });
  return { tenantId, routes };
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const { routes } = routesFromEnvironment();
  const store = new SqliteEventStore(process.env.NEEDL_DB_PATH ?? "./needl-events.sqlite");
  const server = createExampleServer({ routes, sink: store });
  const port = Number(process.env.PORT ?? "8787");
  server.listen(port, "127.0.0.1", () => {
    // Deliberately log only listener metadata, never headers, secrets, or payloads.
    process.stdout.write(`Needl webhook example listening on http://127.0.0.1:${port}\n`);
  });
  const shutdown = (): void => {
    server.close(() => {
      store.close();
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
