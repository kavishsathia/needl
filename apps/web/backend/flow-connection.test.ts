import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseRuntime, migrateApplicationDatabase, type DatabaseRuntime } from "./database.js";
import { defaultFlowGoal, FlowConnectionService } from "./flow-connection.js";
import { NeedlRepository } from "./repository.js";
import { createTestDatabase, dropTestDatabases } from "./test-database.js";

const runtimes: DatabaseRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); });
afterAll(async () => { await dropTestDatabases(); });

const token = "glpat-test-token-0123456789abcdef";
const environment = { NEEDL_SECRET_KEY: randomBytes(32).toString("base64") };

function fakeGitLab(options: { bot?: boolean; scopes?: readonly string[] } = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if ((init?.headers as Record<string, string>)["private-token"] !== token) return reply({ message: "401 Unauthorized" }, 401);
    if (url.endsWith("/api/v4/user")) return reply({ username: "kavish", bot: options.bot ?? false });
    if (url.endsWith("/api/v4/personal_access_tokens/self")) return reply({ scopes: options.scopes ?? ["api"] });
    if (url.includes("/api/v4/projects/")) return reply({ id: 4242, path_with_namespace: "acme/shop" });
    if (url.endsWith("/api/graphql")) return reply({ data: { aiCatalogConfiguredItems: { nodes: [
      { id: "gid://gitlab/Ai::Catalog::ItemConsumer/77", enabled: true, item: { name: "Developer", foundational: true } },
      { id: "gid://gitlab/Ai::Catalog::ItemConsumer/78", enabled: false, item: { name: "Disabled flow", foundational: false } },
    ] } } });
    return reply({ message: "404 Not Found" }, 404);
  });
}

async function setup(fetcher = fakeGitLab()) {
  const runtime = createDatabaseRuntime({ NODE_ENV: "test", DATABASE_URL: await createTestDatabase() });
  runtimes.push(runtime);
  await migrateApplicationDatabase(runtime);
  const repository = new NeedlRepository(runtime);
  const tenant = await repository.tenantForUser("flow-user");
  return { repository, tenant, service: new FlowConnectionService(repository, environment, fetcher as typeof fetch) };
}

describe("GitLab flow connection", () => {
  it("lists the project's enabled flows and saves a sealed token that is never returned", async () => {
    const { repository, tenant, service } = await setup();
    await expect(service.summary(tenant)).resolves.toMatchObject({ connected: false, goal: defaultFlowGoal, autoLaunch: false });
    const found = await service.discover(token, "https://gitlab.com/acme/shop/");
    expect(found).toEqual({ gitlabUser: "kavish", project: { id: "4242", path: "acme/shop" }, flows: [{ consumerId: 77, name: "Developer", foundational: true }] });

    const saved = await service.save(tenant, { token, project: "acme/shop", consumerId: 77, goal: "Fix it in a draft MR.", autoLaunch: true });
    expect(saved).toMatchObject({ connected: true, gitlabUser: "kavish", projectPath: "acme/shop", flowName: "Developer", consumerId: 77, goal: "Fix it in a draft MR.", autoLaunch: true });
    expect(JSON.stringify(saved)).not.toContain(token);
    const stored = await repository.findInvestigationIntegration(tenant);
    expect(stored?.secretCiphertext).toBeDefined();
    expect(stored?.secretCiphertext).not.toContain(token);
    expect(stored?.config).toMatchObject({ purpose: "investigation", projectId: "4242", consumerId: 77, autoLaunch: true });
    expect(typeof stored?.config.autoLaunchSince).toBe("string");
  });

  it("edits with the saved token and keeps when automatic launch started", async () => {
    const { repository, tenant, service } = await setup();
    await service.save(tenant, { token, project: "acme/shop", consumerId: 77, autoLaunch: true });
    const since = (await repository.findInvestigationIntegration(tenant))?.config.autoLaunchSince;
    await expect(service.discoverFor(tenant, undefined, "acme/shop")).resolves.toMatchObject({ flows: [{ consumerId: 77 }] });
    await service.save(tenant, { project: "acme/shop", consumerId: 77, goal: "", autoLaunch: true });
    const after = await repository.findInvestigationIntegration(tenant);
    expect(after?.config.autoLaunchSince).toBe(since);
    expect(after?.config.goal).toBe(defaultFlowGoal);
  });

  it("refuses bot tokens, tokens without api scope, and flows not enabled in the project", async () => {
    await expect((await setup(fakeGitLab({ bot: true }))).service.discover(token, "acme/shop")).rejects.toThrow(/bot or service account/);
    await expect((await setup(fakeGitLab({ scopes: ["read_api"] }))).service.discover(token, "acme/shop")).rejects.toThrow(/api scope/);
    const { tenant, service } = await setup();
    await expect(service.save(tenant, { token, project: "acme/shop", consumerId: 78, autoLaunch: false })).rejects.toThrow(/not enabled/);
    await expect(service.discover("glpat-wrong-token-0000000000000", "acme/shop")).rejects.toThrow(/rejected this token/);
  });

  it("disconnects by switching off and forgetting the token", async () => {
    const { repository, tenant, service } = await setup();
    await service.save(tenant, { token, project: "acme/shop", consumerId: 77, autoLaunch: true });
    await expect(service.remove(tenant)).resolves.toBe(true);
    await expect(service.summary(tenant)).resolves.toMatchObject({ connected: false, autoLaunch: false });
    expect(await repository.findInvestigationIntegration(tenant)).toBeUndefined();
    expect((await repository.findFlowConnection(tenant))?.secretCiphertext).toBeUndefined();
  });
});
