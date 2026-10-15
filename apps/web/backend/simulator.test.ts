import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSecrets, stories } from "../../simulator/events.js";
import { integrationId, providers, secretEnvName, type SimulatorConfig } from "../../simulator/config.js";
import { playStory } from "../../simulator/server.js";
import { getDemoBootstrap } from "../demo.js";
import type { AssertionDraft } from "../src/domain.js";
import { defaultMeaningValues } from "../src/meaning.js";
import { createDatabaseRuntime, migrateApplicationDatabase, type DatabaseRuntime } from "./database.js";
import { SignedIngestionService } from "./ingestion.js";
import { NeedlRepository } from "./repository.js";

const runtimes: DatabaseRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); });

async function workspace() {
  const path = join(await mkdtemp(join(tmpdir(), "needl-simulator-")), "needl.sqlite");
  const runtime = createDatabaseRuntime({ NODE_ENV: "test", NEEDL_SQLITE_PATH: path });
  runtimes.push(runtime);
  await migrateApplicationDatabase(runtime);
  const repository = new NeedlRepository(runtime, 2);
  const tenantId = await repository.tenantForUser("simulator-user");
  for (const template of getDemoBootstrap().templates) {
    const draft: AssertionDraft = {
      localId: template.definition.id,
      expectation: template.prompt,
      definition: template.definition,
      status: "monitoring",
      templateId: template.id,
      meaning: { templateId: template.id, values: defaultMeaningValues(template.id) },
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:00:00.000Z",
    };
    await repository.saveAssertion(tenantId, draft);
  }
  const secrets = generateSecrets();
  const environment: NodeJS.ProcessEnv = {};
  for (const provider of providers) {
    environment[secretEnvName(provider)] = secrets[provider];
    await repository.upsertIntegration({
      id: integrationId(provider),
      tenantId,
      provider,
      enabled: true,
      secretEnvName: secretEnvName(provider),
      config: provider === "gitlab" ? { purpose: "ingestion", authMode: "signing-token" } : { purpose: "ingestion" },
    });
  }
  const config: SimulatorConfig = {
    needlUrl: "http://needl.test",
    tenantId,
    integrations: Object.fromEntries(providers.map((provider) => [provider, { id: integrationId(provider), secretEnvName: secretEnvName(provider) }])) as SimulatorConfig["integrations"],
  };
  const service = new SignedIngestionService(repository, environment);
  // Route the simulator's HTTP call straight into Needl's signed ingestion handler, bytes and headers unchanged.
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const id = decodeURIComponent(String(input).split("/api/hooks/")[1]!);
    const outcome = await service.receive(id, Buffer.from(String(init!.body)), init!.headers as Record<string, string>);
    return new Response(JSON.stringify(outcome.outcome === "stored" ? { outcome: "stored" } : outcome), { status: outcome.statusCode });
  }) as typeof fetch;
  return { repository, tenantId, config, secrets, fetcher };
}

describe("simulator stories through signed ingestion", () => {
  it("stores every signed delivery and only violation stories create counterexamples", async () => {
    const { repository, tenantId, config, secrets, fetcher } = await workspace();
    for (const story of stories) {
      const before = (await repository.loadMonitorSnapshot(tenantId)).counterexamples.length;
      const results = await playStory(config, secrets, story.id, fetcher);
      for (const result of results) expect(result.response).toMatchObject({ status: 200, body: { outcome: "stored" } });
      const after = (await repository.loadMonitorSnapshot(tenantId)).counterexamples.length;
      expect({ story: story.id, added: after - before }).toEqual({ story: story.id, added: story.variant === "violation" ? 1 : 0 });
    }
    const counterexamples = (await repository.loadMonitorSnapshot(tenantId)).counterexamples as { assertionId: string }[];
    expect(counterexamples.map((record) => record.assertionId).sort()).toEqual(["boomerang", "clean-break", "no-ghosts"]);
  });

  it("produces a fresh violation every time a violation story is replayed", async () => {
    const { repository, tenantId, config, secrets, fetcher } = await workspace();
    await playStory(config, secrets, "clean-break.violation", fetcher);
    await playStory(config, secrets, "clean-break.violation", fetcher);
    expect((await repository.loadMonitorSnapshot(tenantId)).counterexamples).toHaveLength(2);
  });
});
