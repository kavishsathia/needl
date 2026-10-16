import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stories } from "../../simulator/events.js";
import { encodeEvent, sampleValue, settableFields, type SimulatedValue } from "../../simulator/encoders.js";
import { generateSecrets, integrationConfig, integrationId, providers, secretEnvName, type SimulatorConfig } from "../../simulator/config.js";
import { catalogue, resolveField } from "../../../src/rules/catalogue.js";
import { readField } from "../../../src/rules/suggest.js";
import type { NormalizedEvent } from "../../../src/core/types.js";
import { playStory } from "../../simulator/server.js";
import { exampleRules } from "../src/examples.js";
import { exampleDraft } from "../src/ruleDrafts.js";
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
  for (const example of exampleRules) await repository.saveAssertion(tenantId, exampleDraft(example));
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
      config: integrationConfig(provider),
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

  it("sends every catalogue event as a real signed webhook that the adapters read back field for field", async () => {
    const { repository, tenantId, config, secrets, fetcher } = await workspace();
    let sent = 0;
    for (const entry of catalogue) {
      for (const event of entry.events) {
        const key = `${event.provider}.${event.name}`;
        const values: Record<string, SimulatedValue> = Object.fromEntries(settableFields(event).map((field) => [field.name, sampleValue(event, field)]));
        if ((event.families ?? []).length > 0) values["tags.linear_issue"] = "ENG-42";
        const delivery = encodeEvent(key, values, new Date(), secrets[event.provider]);
        const response = await fetcher(`${config.needlUrl}/api/hooks/${config.integrations[event.provider].id}`, { method: "POST", body: delivery.body, headers: delivery.headers });
        const body = await response.json() as { outcome?: string };
        expect({ key, status: response.status, outcome: body.outcome }).toEqual({ key, status: 200, outcome: "stored" });
        sent += 1;
        const stored = (await repository.loadMonitorSnapshot(tenantId)).events as NormalizedEvent[];
        const received = stored.at(-1)!;
        for (const [name, value] of Object.entries(values)) {
          const field = resolveField(event, name)!;
          expect({ key, field: name, value: readField(field, received) }).toEqual({ key, field: name, value: field.read.from === "source" ? String(value) : value });
        }
      }
    }
    expect(sent).toBeGreaterThan(30);
  });

  it("derives fields such as the issue key in a deployed branch", async () => {
    const { repository, tenantId, config, secrets, fetcher } = await workspace();
    const delivery = encodeEvent("gitlab.deployment", { ref: "eng-77-fix", commit: "4f1c2b9e7d3a5c8b0e6f1a2d4c7b9e3f5a8d0c1b" }, new Date(), secrets.gitlab);
    await fetcher(`${config.needlUrl}/api/hooks/${config.integrations.gitlab.id}`, { method: "POST", body: delivery.body, headers: delivery.headers });
    const received = ((await repository.loadMonitorSnapshot(tenantId)).events as NormalizedEvent[]).at(-1)!;
    const event = catalogue.find((entry) => entry.provider === "gitlab")!.events.find((item) => item.name === "deployment")!;
    expect(readField(resolveField(event, "ref.issue_key")!, received)).toBe("ENG-77");
    expect(readField(resolveField(event, "commit")!, received)).toBe("4f1c2b9e7d3a5c8b0e6f1a2d4c7b9e3f5a8d0c1b");
  });

  it("produces a fresh violation every time a violation story is replayed", async () => {
    const { repository, tenantId, config, secrets, fetcher } = await workspace();
    await playStory(config, secrets, "clean-break.violation", fetcher);
    await playStory(config, secrets, "clean-break.violation", fetcher);
    expect((await repository.loadMonitorSnapshot(tenantId)).counterexamples).toHaveLength(2);
  });
});
