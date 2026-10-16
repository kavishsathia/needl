import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { catalogueEvents } from "../../src/rules/catalogue.js";
import { encodeEvent, type SimulatedValues } from "./encoders.js";
import { eventSpecs, findStory, stories, typedValues } from "./events.js";
import { loadConfig, loadSecrets, providers, type SimulatorConfig } from "./config.js";

export interface DeliveryResult {
  readonly event: string;
  readonly provider: string;
  readonly label: string;
  readonly sentAt: string;
  readonly url: string;
  readonly request: { readonly headers: Readonly<Record<string, string>>; readonly body: unknown };
  readonly response: { readonly status: number; readonly body: unknown } | { readonly status: 0; readonly error: string };
}

export async function deliver(
  config: SimulatorConfig,
  secrets: Readonly<Record<string, string>>,
  eventId: string,
  values: SimulatedValues,
  at: Date,
  fetcher: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const event = catalogueEvents.get(eventId);
  if (event === undefined) throw new Error(`Unknown event ${eventId}`);
  const delivery = encodeEvent(eventId, values, at, secrets[event.provider]!);
  const url = `${config.needlUrl}/api/hooks/${encodeURIComponent(config.integrations[event.provider].id)}`;
  const label = event.phrase.replace(/^an? /, "");
  const base = { event: eventId, provider: event.provider, label, sentAt: at.toISOString(), url, request: { headers: delivery.headers, body: JSON.parse(delivery.body) as unknown } };
  try {
    const response = await fetcher(url, { method: "POST", headers: delivery.headers, body: delivery.body });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { ...base, response: { status: response.status, body } };
  } catch (error) {
    return { ...base, response: { status: 0, error: error instanceof Error ? error.message : String(error) } };
  }
}

export async function playStory(
  config: SimulatorConfig,
  secrets: Readonly<Record<string, string>>,
  storyId: string,
  fetcher: typeof fetch = fetch,
): Promise<readonly DeliveryResult[]> {
  const steps = findStory(storyId).steps();
  const start = Date.now();
  const results: DeliveryResult[] = [];
  // One second apart so every step has a strictly later observation time than the one before.
  for (const [index, step] of steps.entries()) results.push(await deliver(config, secrets, step.event, step.values, new Date(start + index * 1_000), fetcher));
  return results;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 64_000) throw new Error("Request body is too large");
    chunks.push(chunk as Buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function stringFields(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const config = loadConfig();
  const secrets = loadSecrets(config);
  const page = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");
  const port = Number(process.env.SIMULATOR_PORT ?? 4180);
  const origin = `http://127.0.0.1:${port}`;

  createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(page);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/catalog") {
        json(response, 200, {
          needlUrl: config.needlUrl,
          tenantId: config.tenantId,
          integrations: providers.map((provider) => ({ provider, id: config.integrations[provider].id })),
          events: eventSpecs(),
          stories: stories.map(({ id, template, variant, label }) => ({ id, template, variant, label })),
        });
        return;
      }
      if (request.method === "POST") {
        // Local tool, but still refuse cross-site form posts: JSON only, from this page.
        if (!request.headers["content-type"]?.startsWith("application/json") || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
          json(response, 403, { error: "Requests must be JSON from the simulator page" });
          return;
        }
        const body = await readJson(request);
        if (url.pathname === "/api/send" && typeof body.event === "string") {
          json(response, 200, { results: [await deliver(config, secrets, body.event, typedValues(body.event, stringFields(body.fields)), new Date())] });
          return;
        }
        if (url.pathname === "/api/story" && typeof body.story === "string") {
          json(response, 200, { results: await playStory(config, secrets, body.story) });
          return;
        }
      }
      json(response, 404, { error: "Unknown simulator endpoint" });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "Request failed" });
    }
  }).listen(port, "127.0.0.1", () => {
    process.stdout.write(`Needl simulator on ${origin} → ${config.needlUrl} (tenant ${config.tenantId})\n`);
  });
}
