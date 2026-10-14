import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedEvent } from "../src/core/index.js";
import { RuntimeMonitor, parseFormula, type AssertionDefinition } from "../src/ltl/index.js";
import { SqliteMonitorStore } from "../src/ltl/sqlite.js";

let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "needl-ltl-sqlite-"));
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

const assertion: AssertionDefinition = {
  id: "sqlite-recurrence",
  version: 1,
  tenantId: "acme",
  name: "A deployment must not recur",
  formula: parseFormula("G (deployed -> G !recurrence)"),
  scope: { keys: [{ name: "issue", extractors: [{ from: "relationship", type: "issue" }] }] },
  propositions: [
    { name: "deployed", predicate: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "fix.deployed" } },
    { name: "recurrence", predicate: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "error.recurred" } },
  ],
};

function event(id: string, kind: string, at: string): NormalizedEvent {
  return {
    id,
    provider: kind === "fix.deployed" ? "gitlab" : "sentry",
    providerEventType: kind,
    tenantId: "acme",
    source: {},
    occurredAt: at,
    receivedAt: at,
    kind,
    subject: { type: "issue", id: "ISSUE-1" },
    relationships: [{ type: "issue", id: "ISSUE-1", evidencePath: "/test/issue" }],
    evidence: { providerPayload: {}, links: [], authenticity: "synthetic-test", bodySha256: id },
  };
}

describe("SqliteMonitorStore", () => {
  it("atomically restores checkpoints, dedupe, traces, violations, and outbox across restart", async () => {
    const path = join(temporaryDirectory, "runtime.sqlite");
    const firstStore = new SqliteMonitorStore(path);
    const firstRuntime = new RuntimeMonitor({ store: firstStore, assertions: [assertion] });
    expect((await firstRuntime.process(event("deploy", "fix.deployed", "2026-01-01T00:00:00Z")))[0])
      .toMatchObject({ outcome: "applied" });
    firstStore.close();

    const restartedStore = new SqliteMonitorStore(path);
    const restartedRuntime = new RuntimeMonitor({ store: restartedStore, assertions: [assertion] });
    expect((await restartedRuntime.process(event("deploy", "fix.deployed", "2026-01-01T00:00:00Z")))[0])
      .toMatchObject({ outcome: "duplicate" });
    expect((await restartedRuntime.process(event("recurrence", "error.recurred", "2026-01-01T00:00:01Z")))[0])
      .toMatchObject({ outcome: "applied", verdict: "violated" });

    expect(await restartedStore.listCheckpoints()).toEqual([expect.objectContaining({ revision: 2, verdict: "violated" })]);
    const trace = await restartedStore.loadTrace((await restartedStore.listCheckpoints())[0]!.key);
    expect(trace.map((item) => item.inputId)).toEqual(["deploy", "recurrence"]);
    const violations = await restartedStore.listViolations();
    expect(violations).toHaveLength(1);
    const pending = await restartedStore.listOutbox("pending");
    expect(pending).toHaveLength(1);
    await restartedStore.recordOutboxAttempt(pending[0]!.id, { at: "2026-01-01T00:00:02Z", success: false, error: "synthetic dispatcher outage" });
    expect(await restartedStore.listOutbox("failed")).toEqual([
      expect.objectContaining({ attempts: 1, lastError: "synthetic dispatcher outage" }),
    ]);
    await restartedStore.recordOutboxAttempt(pending[0]!.id, { at: "2026-01-01T00:00:03Z", success: true });
    expect(await restartedStore.listOutbox("dispatched")).toEqual([
      expect.objectContaining({ attempts: 2, lastAttemptAt: "2026-01-01T00:00:03Z" }),
    ]);
    restartedStore.close();
  });
});

