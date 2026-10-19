import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { betterAuth } from "better-auth";
import type { WebhookHeaders } from "../../../src/core/types.js";
import { getDemoBootstrap, runDemoScenario } from "../demo.js";
import type { DemoReplayRequest } from "../src/domain.js";
import { validateProductAssertionCollection } from "../src/collection.js";
import type { ChoiceSuggestions } from "../src/domain.js";
import type { Provider } from "../../../src/core/types.js";
import { checkRule } from "../../../src/rules/check.js";
import { suggestChoices } from "../../../src/rules/suggest.js";
import { createAuthOptions, migrateAuthDatabase, signupEnabled } from "./auth.js";
import { createDatabaseRuntime, migrateApplicationDatabase } from "./database.js";
import { SignedIngestionService } from "./ingestion.js";
import { GitLabCallbackService, GitLabInvestigationService } from "./investigations.js";
import { NeedlRepository, QuotaExceededError, StaleAssertionError } from "./repository.js";
import { OpenAITranslationModel, translateToRule } from "./translator.js";
import { SecretBox } from "./secrets.js";
import { connectionSettings } from "./connections.js";
import { providers as allProviders } from "../../../src/core/types.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = join(appRoot, "dist");
export interface NeedlApp {
  /** Handles one HTTP request. */
  readonly handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  /** Advances time-bounded rules; concurrent calls share one run. */
  readonly tick: () => Promise<void>;
  readonly databaseType: string;
  readonly close: () => Promise<void>;
}

export async function createNeedlApp(options: { readonly serveStatic: boolean; readonly port?: number }): Promise<NeedlApp> {
  const runtime = createDatabaseRuntime();
  const authOptions = createAuthOptions(runtime);
  await migrateApplicationDatabase(runtime);
  if (process.env.NODE_ENV !== "production" || process.env.NEEDL_AUTO_MIGRATE === "true") await migrateAuthDatabase(authOptions);
  const auth = betterAuth(authOptions);
  const repository = new NeedlRepository(runtime, Number(process.env.NEEDL_TRANSLATION_DAILY_LIMIT ?? 5));
  const secretBox = SecretBox.fromEnvironment();
  const ingestion = new SignedIngestionService(repository, process.env, secretBox);
  const investigations = new GitLabInvestigationService(repository);
  const callbacks = new GitLabCallbackService(repository);
  const openAIModel = process.env.OPENAI_API_KEY === undefined ? undefined : new OpenAITranslationModel({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_TRANSLATION_MODEL });
  const upgraded = await repository.upgradeLegacyAssertions();
  if (upgraded > 0) process.stdout.write(`Upgraded ${upgraded} saved assertion(s) to the current rule format\n`);

    // Time-bounded rules need ticks: a missing event is only noticed when time passes, not when something arrives.
    const tickGraceMs = Number(process.env.NEEDL_TICK_GRACE_MS ?? 5_000);
    let ticking: Promise<void> | undefined;
    function tick(): Promise<void> {
      ticking ??= repository.advanceDueMonitors(new Date(), tickGraceMs)
        .then(() => investigations.launchPending())
        .then(() => undefined)
        .catch((error: unknown) => { process.stderr.write(`Clock tick failed: ${error instanceof Error ? error.message : String(error)}\n`); })
        .finally(() => { ticking = undefined; });
      return ticking;
    }

  const trustedOrigins = new Set((process.env.NEEDL_TRUSTED_ORIGINS ?? `${process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:4173"},http://127.0.0.1:5173`).split(",").map((value) => value.trim()).filter(Boolean));

  const mime: Readonly<Record<string, string>> = {
    ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  };

  function securityHeaders() {
    return {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      "referrer-policy": "same-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      ...(process.env.NODE_ENV === "production" ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
    };
  }

  function webhookHeaders(request: IncomingMessage): WebhookHeaders {
    const headers: Record<string, string | readonly string[] | undefined> = {};
    for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;
    return headers;
  }

  function json(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...securityHeaders(), ...extraHeaders });
    response.end(JSON.stringify(body));
  }

  async function readBody(request: IncomingMessage, maximum = 1_000_000): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maximum) throw Object.assign(new Error("Request body exceeds 1 MB"), { statusCode: 413 });
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  async function readJson(request: IncomingMessage): Promise<unknown> {
    if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw Object.assign(new Error("Content-Type must be application/json"), { statusCode: 415 });
    const body = await readBody(request);
    try { return JSON.parse(body.toString("utf8")); }
    catch { throw new Error("Request body must be valid JSON"); }
  }

  function requestHeaders(request: IncomingMessage): Headers {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    headers.set("x-needl-remote-ip", request.socket.remoteAddress ?? "127.0.0.1");
    return headers;
  }

  async function standardRequest(request: IncomingMessage): Promise<Request> {
    const origin = process.env.BETTER_AUTH_URL ?? `http://127.0.0.1:${options.port ?? 4173}`;
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
    return new Request(new URL(request.url ?? "/", origin), { method: request.method, headers: requestHeaders(request), body, duplex: body === undefined ? undefined : "half" } as RequestInit);
  }

  async function writeStandardResponse(source: Response, target: ServerResponse): Promise<void> {
    const headers: Record<string, string | string[]> = {};
    source.headers.forEach((value, key) => { headers[key] = value; });
    const cookies = source.headers.getSetCookie();
    if (cookies.length > 0) headers["set-cookie"] = cookies;
    target.writeHead(source.status, { ...securityHeaders(), ...headers });
    target.end(Buffer.from(await source.arrayBuffer()));
  }

  function assertMutationOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin;
    if (typeof origin === "string" && trustedOrigins.has(origin)) return;
    if (origin === undefined && request.headers["x-needl-csrf"] === "1") return;
    throw Object.assign(new Error("Untrusted mutation origin"), { statusCode: 403 });
  }

  async function requireWorkspace(request: IncomingMessage) {
    const session = await auth.api.getSession({ headers: requestHeaders(request) });
    if (session === null) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
    const tenantId = await repository.tenantForUser(session.user.id, `${session.user.name || session.user.email}'s workspace`);
    return { session, tenantId };
  }

  function serveStatic(request: IncomingMessage, response: ServerResponse): void {
    if (!existsSync(distRoot)) { response.writeHead(503, { "content-type": "text/plain; charset=utf-8" }); response.end("Needl frontend is not built. Run npm run web:build first.\n"); return; }
    const rawPath = new URL(request.url ?? "/", "http://localhost").pathname;
    const candidate = resolve(distRoot, rawPath.replace(/^\/+/, ""));
    const insideDist = candidate === distRoot || candidate.startsWith(`${distRoot}${sep}`);
    const safe = insideDist && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(distRoot, "index.html");
    response.writeHead(200, { "content-type": mime[extname(safe)] ?? "application/octet-stream", ...securityHeaders(), "cache-control": safe.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable" });
    createReadStream(safe).pipe(response);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const callbackRoute = url.pathname.match(/^\/api\/hooks\/gitlab-flow\/([^/]+)$/);
      if (request.method === "POST" && callbackRoute !== null) {
        const outcome = await callbacks.receive(decodeURIComponent(callbackRoute[1]!), await readBody(request), webhookHeaders(request));
        json(response, 200, { outcome }); return;
      }
      const ingestionRoute = url.pathname.match(/^\/api\/hooks\/([^/]+)$/);
      if (request.method === "POST" && ingestionRoute !== null) {
        const outcome = await ingestion.receive(decodeURIComponent(ingestionRoute[1]!), await readBody(request), webhookHeaders(request));
        // A stored event can break a rule; launch any opted-in GitLab flow before answering, since a serverless
        // function may stop once the response is sent.
        if (outcome.outcome === "stored") await investigations.launchPending().catch(() => 0);
        json(response, outcome.statusCode, outcome.outcome === "stored" ? { outcome: "stored", eventId: outcome.event.id } : outcome); return;
      }
      if (url.pathname.startsWith("/api/auth/")) { await writeStandardResponse(await auth.handler(await standardRequest(request)), response); return; }
      if (request.method === "GET" && url.pathname === "/api/health") { json(response, 200, { status: "ok", mode: "durable-full-stack", database: runtime.type, openai: openAIModel === undefined ? "not-configured" : "configured" }); return; }
      if (request.method === "GET" && url.pathname === "/api/config") { json(response, 200, { signupEnabled: signupEnabled() }); return; }
      if (request.method === "GET" && url.pathname === "/api/demo/bootstrap") { json(response, 200, getDemoBootstrap()); return; }
      // Retained as a public, side-effect-free compatibility contract for engine regressions.
      if (request.method === "POST" && url.pathname === "/api/demo/replay") {
        if (process.env.NODE_ENV === "production") { json(response, 404, { error: "Unknown Needl endpoint" }); return; }
        const body = await readJson(request) as DemoReplayRequest;
        validateProductAssertionCollection(body.assertions, { allowNeedsReview: false });
        json(response, 200, await runDemoScenario(body)); return;
      }
      if (request.method === "GET" && url.pathname === "/api/workspace") {
        const { session, tenantId } = await requireWorkspace(request);
        json(response, 200, {
          user: session.user, tenantId, assertions: await repository.listAssertions(tenantId),
          translator: openAIModel === undefined ? "unavailable" : "available",
          integrations: await repository.listIntegrationSummaries(tenantId),
        }); return;
      }
      if (url.pathname === "/api/connections" || url.pathname.startsWith("/api/connections/")) {
        const { tenantId } = await requireWorkspace(request);
        // Where providers should send webhooks, when pinned; otherwise the page uses the address it was opened on.
        const publicUrl = process.env.NEEDL_PUBLIC_URL?.replace(/\/$/, "") ?? null;
        const connectionId = url.pathname.match(/^\/api\/connections\/([^/]+)(\/secret)?$/);
        if (request.method === "GET" && url.pathname === "/api/connections") {
          json(response, 200, { publicUrl, connections: await repository.listConnections(tenantId) }); return;
        }
        assertMutationOrigin(request);
        if (request.method === "POST" && url.pathname === "/api/connections") {
          const body = await readJson(request) as { provider?: unknown };
          if (typeof body.provider !== "string" || !allProviders.includes(body.provider as never)) throw new Error("Choose a supported integration");
          const created = await repository.createConnection(tenantId, body.provider, {});
          json(response, 201, (await repository.listConnections(tenantId)).find((item) => item.id === created.id)); return;
        }
        if (request.method === "PUT" && connectionId?.[2] === "/secret") {
          const id = decodeURIComponent(connectionId[1]!);
          const existing = (await repository.listConnections(tenantId)).find((item) => item.id === id);
          if (existing === undefined) throw Object.assign(new Error("Integration was not found in this workspace"), { statusCode: 404 });
          const body = await readJson(request) as { secret?: unknown; mode?: unknown };
          const settings = connectionSettings(existing.provider, typeof body.secret === "string" ? body.secret : "", typeof body.mode === "string" ? body.mode : undefined);
          await repository.saveConnectionSecret(tenantId, id, secretBox.seal(settings.secret), settings.config);
          json(response, 200, (await repository.listConnections(tenantId)).find((item) => item.id === id)); return;
        }
        if (request.method === "DELETE" && connectionId !== null && connectionId[2] === undefined) {
          json(response, 200, { deleted: await repository.deleteConnection(tenantId, decodeURIComponent(connectionId[1]!)) }); return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/monitor") {
        const { tenantId } = await requireWorkspace(request);
        json(response, 200, await repository.loadMonitorSnapshot(tenantId)); return;
      }
      if (request.method === "PUT" && url.pathname.startsWith("/api/assertions/")) {
        assertMutationOrigin(request);
        const { tenantId } = await requireWorkspace(request);
        const assertionId = decodeURIComponent(url.pathname.slice("/api/assertions/".length));
        const body = await readJson(request) as { draft?: unknown; expectedVersion?: unknown };
        if (typeof body.draft !== "object" || body.draft === null || (body.draft as { localId?: unknown }).localId !== assertionId) throw new Error("Route assertion id must match the draft");
        const expectedVersion = body.expectedVersion === null || body.expectedVersion === undefined ? undefined : Number(body.expectedVersion);
        if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) throw new Error("expectedVersion must be a positive integer");
        json(response, 200, await repository.saveAssertion(tenantId, body.draft, expectedVersion)); return;
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/api/assertions/")) {
        assertMutationOrigin(request);
        const { tenantId } = await requireWorkspace(request);
        json(response, 200, { deleted: await repository.deleteAssertion(tenantId, decodeURIComponent(url.pathname.slice("/api/assertions/".length))) }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/replay") {
        assertMutationOrigin(request);
        const { tenantId } = await requireWorkspace(request);
        const body = await readJson(request) as DemoReplayRequest;
        validateProductAssertionCollection(body.assertions, { allowNeedsReview: false });
        const replay = await runDemoScenario(body);
        await repository.persistReplay(tenantId, replay);
        json(response, 200, replay); return;
      }
      if (request.method === "POST" && url.pathname === "/api/translations") {
        assertMutationOrigin(request);
        const { tenantId } = await requireWorkspace(request);
        const body = await readJson(request) as { text?: unknown };
        if (typeof body.text !== "string") throw new Error("Translation text is required");
        if (openAIModel === undefined) { json(response, 503, { error: "OpenAI translation is not configured on this server" }); return; }
        const remaining = await repository.consumeTranslationQuota(tenantId);
        const connected = new Set((await repository.listIntegrationSummaries(tenantId)).filter((item) => item.purpose === "ingestion" && item.enabled).map((item) => item.provider as Provider));
        const proposal = await translateToRule(body.text, openAIModel, connected);
        const proposalId = await repository.createTranslationProposal(tenantId, body.text.trim(), proposal, openAIModel.model);
        // A proposal without a rule is a valid answer; the dialog shows its reason and lets the user start elsewhere.
        json(response, 200, { proposalId, proposal, remaining }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/rules/suggestions") {
        assertMutationOrigin(request);
        const { tenantId } = await requireWorkspace(request);
        const body = await readJson(request) as { source?: unknown };
        if (typeof body.source !== "string") throw new Error("Rule source is required");
        const checked = checkRule(body.source);
        if (!checked.ok) throw new Error(checked.errors[0]!.message);
        const suggestions: ChoiceSuggestions[] = suggestChoices(checked.rule, await repository.recentLiveEvents(tenantId)).map((entry) => ({
          param: entry.param.name,
          label: entry.param.label,
          type: entry.param.type,
          list: entry.param.list,
          freeText: entry.freeText,
          usages: entry.param.usages.map((usage) => `${usage.event.provider}.${usage.event.name}.${usage.field.name}`),
          values: entry.values,
        }));
        json(response, 200, { suggestions }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/investigations") {
        assertMutationOrigin(request);
        const { tenantId } = await requireWorkspace(request);
        const body = await readJson(request) as { violationId?: unknown };
        if (typeof body.violationId !== "string" || body.violationId.length === 0) throw new Error("violationId is required");
        json(response, 200, await investigations.launch(tenantId, body.violationId)); return;
      }
      const investigationRefresh = url.pathname.match(/^\/api\/investigations\/([^/]+)\/refresh$/);
      if (request.method === "POST" && investigationRefresh !== null) {
        assertMutationOrigin(request);
        const { tenantId } = await requireWorkspace(request);
        json(response, 200, await investigations.refresh(tenantId, decodeURIComponent(investigationRefresh[1]!))); return;
      }
      const confirmation = url.pathname.match(/^\/api\/translations\/([^/]+)\/confirm$/);
      if (request.method === "POST" && confirmation !== null) {
        assertMutationOrigin(request);
        const { tenantId } = await requireWorkspace(request);
        const proposalId = decodeURIComponent(confirmation[1]!);
        const stored = await repository.getTranslationProposal(tenantId, proposalId);
        if (stored.status !== "pending") throw new Error("Translation proposal was already resolved");
        await repository.confirmTranslationProposal(tenantId, proposalId);
        json(response, 200, { confirmed: true, inputText: stored.inputText, proposal: stored.proposal }); return;
      }
      if (url.pathname.startsWith("/api/")) { json(response, 404, { error: "Unknown Needl endpoint" }); return; }
      if (!options.serveStatic) { json(response, 404, { error: "The development API bridge only serves /api routes" }); return; }
      serveStatic(request, response);
    } catch (error) {
      const status = error instanceof StaleAssertionError ? 409 : error instanceof QuotaExceededError ? 429 : typeof (error as { statusCode?: unknown })?.statusCode === "number" ? (error as { statusCode: number }).statusCode : 400;
      json(response, status, { error: error instanceof Error ? error.message : "Invalid request" });
    }
  }

  return { handle, tick, databaseType: runtime.type, close: () => runtime.close() };
}
