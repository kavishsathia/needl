import { afterAll, afterEach, describe, expect, it } from "vitest";
import { runDemoScenario } from "../demo.js";
import type { AssertionDraft } from "../src/domain.js";
import { exampleRules } from "../src/examples.js";
import { exampleDraft } from "../src/ruleDrafts.js";
import { createDatabaseRuntime, migrateApplicationDatabase, type DatabaseRuntime } from "./database.js";
import { NeedlRepository, QuotaExceededError, StaleAssertionError } from "./repository.js";
import { createTestDatabase, dropTestDatabases } from "./test-database.js";

const runtimes: DatabaseRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); });
afterAll(async () => { await dropTestDatabases(); });

async function setup(filename?: string) {
  const path = filename ?? await createTestDatabase();
  const runtime = createDatabaseRuntime({ NODE_ENV: "test", DATABASE_URL: path });
  runtimes.push(runtime);
  await migrateApplicationDatabase(runtime);
  const repository = new NeedlRepository(runtime, 2);
  return { path, runtime, repository };
}

function draft(index = 0): AssertionDraft {
  return exampleDraft(exampleRules[index]!);
}

describe("NeedlRepository", () => {
  it("isolates tenants and rejects stale versions", async () => {
    const { repository } = await setup();
    const tenantA = await repository.tenantForUser("user-a");
    const tenantB = await repository.tenantForUser("user-b");
    await repository.saveAssertion(tenantA, draft());
    expect(await repository.listAssertions(tenantA)).toHaveLength(1);
    expect(await repository.listAssertions(tenantB)).toEqual([]);

    const next = { ...draft(), definition: { ...draft().definition, version: 2 }, updatedAt: "2026-02-18T10:40:00.000Z" };
    await expect(repository.saveAssertion(tenantA, next, 1)).resolves.toMatchObject({ definition: { version: 2 } });
    await expect(repository.saveAssertion(tenantA, { ...next, definition: { ...next.definition, version: 3 } }, 1)).rejects.toBeInstanceOf(StaleAssertionError);
  });

  it("persists deduplicated replay state across a restart", async () => {
    const first = await setup();
    const tenant = await first.repository.tenantForUser("user-a");
    const assertion = draft();
    await first.repository.saveAssertion(tenant, assertion);
    const replay = await runDemoScenario({ assertions: [assertion], scenario: "violating" });
    await first.repository.persistReplay(tenant, replay);
    await first.repository.persistReplay(tenant, replay);
    const before = await first.repository.loadMonitorSnapshot(tenant);
    expect(before.events).toHaveLength(replay.events.length);
    expect(before.counterexamples).toHaveLength(1);
    expect(before.outbox).toHaveLength(1);
    await first.runtime.close();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);

    const restarted = await setup(first.path);
    const after = await restarted.repository.loadMonitorSnapshot(tenant);
    expect(after).toEqual(before);
  });

  it("durably processes live events with duplicate and tenant isolation", async () => {
    const first = await setup();
    const tenantA = await first.repository.tenantForUser("live-user-a");
    const tenantB = await first.repository.tenantForUser("live-user-b");
    const assertion = draft();
    await first.repository.saveAssertion(tenantA, assertion);
    await first.repository.saveAssertion(tenantB, assertion);
    const replay = await runDemoScenario({ assertions: [assertion], scenario: "violating" });
    const ghostEvents = replay.events.slice(0, 3);
    for (const event of ghostEvents) {
      const scoped = { ...event, tenantId: tenantA };
      await expect(first.repository.store(scoped, { tenantId: tenantA, provider: scoped.provider, deliveryId: scoped.id })).resolves.toBe("stored");
    }
    const duplicate = { ...ghostEvents[2]!, tenantId: tenantA };
    await expect(first.repository.store(duplicate, { tenantId: tenantA, provider: duplicate.provider, deliveryId: duplicate.id })).resolves.toBe("duplicate");
    for (const event of ghostEvents.slice(0, 1)) {
      const scoped = { ...event, tenantId: tenantB };
      await first.repository.store(scoped, { tenantId: tenantB, provider: scoped.provider, deliveryId: scoped.id });
    }
    expect((await first.repository.loadMonitorSnapshot(tenantA)).counterexamples).toHaveLength(1);
    expect((await first.repository.loadMonitorSnapshot(tenantB)).counterexamples).toHaveLength(0);
    await first.runtime.close();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);

    const restarted = await setup(first.path);
    const afterA = await restarted.repository.loadMonitorSnapshot(tenantA);
    const afterB = await restarted.repository.loadMonitorSnapshot(tenantB);
    expect(afterA.events).toHaveLength(3);
    expect(afterA.counterexamples).toHaveLength(1);
    expect(afterA.checkpoints).toHaveLength(1);
    expect(afterB.events).toHaveLength(1);
    expect(afterB.counterexamples).toHaveLength(0);
  });

  it("applies a durable daily quota per tenant", async () => {
    const { repository } = await setup();
    const tenant = await repository.tenantForUser("user-a");
    const now = new Date("2026-10-14T12:00:00.000Z");
    await expect(repository.consumeTranslationQuota(tenant, now)).resolves.toBe(1);
    await expect(repository.consumeTranslationQuota(tenant, now)).resolves.toBe(0);
    await expect(repository.consumeTranslationQuota(tenant, now)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("keeps translation proposals tenant-scoped through confirmation", async () => {
    const { repository } = await setup();
    const tenantA = await repository.tenantForUser("translation-user-a");
    const tenantB = await repository.tenantForUser("translation-user-b");
    const proposalId = await repository.createTranslationProposal(tenantA, "A fixed issue must not recur", { supported: true, templateId: "ghost" }, "fixture-model");
    await expect(repository.getTranslationProposal(tenantB, proposalId)).rejects.toThrow(/not found in this workspace/i);
    await expect(repository.confirmTranslationProposal(tenantB, proposalId)).rejects.toThrow(/belongs to another workspace/i);
    await expect(repository.getTranslationProposal(tenantA, proposalId)).resolves.toMatchObject({ status: "pending" });
    await expect(repository.confirmTranslationProposal(tenantA, proposalId)).resolves.toBeUndefined();
  });

  it("atomically caps concurrent translation requests and stale writes", async () => {
    const { repository } = await setup();
    const tenant = await repository.tenantForUser("concurrent-user");
    const now = new Date("2026-10-14T12:00:00.000Z");
    const quota = await Promise.allSettled(Array.from({ length: 4 }, () => repository.consumeTranslationQuota(tenant, now)));
    expect(quota.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(quota.filter((result) => result.status === "rejected" && result.reason instanceof QuotaExceededError)).toHaveLength(2);

    await repository.saveAssertion(tenant, draft());
    const first = { ...draft(), expectation: "Concurrent edit one", definition: { ...draft().definition, name: "Concurrent edit one", version: 2 }, updatedAt: "2026-02-18T10:40:00.000Z" };
    const second = { ...draft(), expectation: "Concurrent edit two", definition: { ...draft().definition, name: "Concurrent edit two", version: 2 }, updatedAt: "2026-02-18T10:40:01.000Z" };
    const writes = await Promise.allSettled([repository.saveAssertion(tenant, first, 1), repository.saveAssertion(tenant, second, 1)]);
    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((result) => result.status === "rejected" && result.reason instanceof StaleAssertionError)).toHaveLength(1);
  });
});
