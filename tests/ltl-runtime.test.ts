import { describe, expect, it } from "vitest";
import type { NormalizedEvent, Provider } from "../src/core/index.js";
import {
  InMemoryMonitorStore,
  RuntimeMonitor,
  compileAssertion,
  parseFormula,
  type AssertionDefinition,
} from "../src/ltl/index.js";

function observation(input: {
  id: string;
  at: string;
  kind: string;
  issue?: string;
  environment?: string;
  tenantId?: string;
  provider?: Provider;
}): NormalizedEvent {
  return {
    id: input.id,
    provider: input.provider ?? "sentry",
    providerEventType: input.kind,
    tenantId: input.tenantId ?? "acme",
    source: {},
    occurredAt: input.at,
    receivedAt: input.at,
    kind: input.kind,
    subject: { type: "observation", id: input.id },
    relationships: [
      ...(input.issue === undefined ? [] : [{ type: "issue", id: input.issue, evidencePath: "/test/issue" }]),
      ...(input.environment === undefined ? [] : [{ type: "environment", id: input.environment, evidencePath: "/test/environment" }]),
    ],
    evidence: {
      providerPayload: { synthetic: true },
      links: [{ rel: "source", url: `https://example.test/events/${input.id}` }],
      authenticity: "synthetic-test",
      bodySha256: input.id,
    },
  };
}

function recurrenceAssertion(overrides: Partial<AssertionDefinition> = {}): AssertionDefinition {
  return {
    id: "no-recurrence",
    version: 1,
    tenantId: "acme",
    name: "A deployed issue must not recur",
    formula: parseFormula("G (deployed -> G !recurrence)"),
    scope: { keys: [
      { name: "issue", extractors: [{ from: "relationship", type: "issue" }] },
      { name: "environment", extractors: [{ from: "relationship", type: "environment" }] },
    ] },
    propositions: [
      { name: "deployed", predicate: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "fix.deployed" } },
      { name: "recurrence", predicate: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "error.recurred" } },
    ],
    checkpointTraceLimit: 1,
    ...overrides,
  };
}

describe("RuntimeMonitor ordinary LTL", () => {
  it("partitions by tenant, assertion version, issue, and environment", async () => {
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [recurrenceAssertion()] });

    expect((await monitor.process(observation({ id: "deploy-1", at: "2026-01-01T00:00:00Z", kind: "fix.deployed", issue: "I-1", environment: "prod" })))[0])
      .toMatchObject({ outcome: "applied", verdict: "inconclusive" });
    expect((await monitor.process(observation({ id: "other-issue", at: "2026-01-01T00:00:01Z", kind: "error.recurred", issue: "I-2", environment: "prod" })))[0])
      .toMatchObject({ outcome: "applied", verdict: "inconclusive" });
    expect((await monitor.process(observation({ id: "other-env", at: "2026-01-01T00:00:02Z", kind: "error.recurred", issue: "I-1", environment: "staging" })))[0])
      .toMatchObject({ outcome: "applied", verdict: "inconclusive" });
    const violation = (await monitor.process(observation({ id: "recurrence-1", at: "2026-01-01T00:00:03Z", kind: "error.recurred", issue: "I-1", environment: "prod" })))[0];
    expect(violation).toMatchObject({ outcome: "applied", verdict: "violated" });

    const records = await store.listViolations();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      assertionId: "no-recurrence",
      assertionVersion: 1,
      scope: { issue: "I-1", environment: "prod" },
      cause: "formula_false",
      minimal: false,
    });
    expect(records[0]!.sourceEvents.map((source) => source.eventId)).toEqual(["deploy-1", "recurrence-1"]);
    expect(records[0]!.trace).toHaveLength(2); // Full durable trace despite a one-item checkpoint cache.
    expect((await store.listOutbox())).toEqual([expect.objectContaining({ violationId: records[0]!.id, status: "pending" })]);
  });

  it("ignores missing relationships and wrong tenants without creating partitions", async () => {
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [recurrenceAssertion()] });
    expect((await monitor.process(observation({ id: "missing", at: "2026-01-01T00:00:00Z", kind: "fix.deployed" })))[0])
      .toMatchObject({ outcome: "missing_scope" });
    expect(await monitor.process(observation({ id: "wrong-tenant", at: "2026-01-01T00:00:00Z", kind: "fix.deployed", issue: "I-1", environment: "prod", tenantId: "other" })))
      .toEqual([]);
    expect(await store.listCheckpoints()).toEqual([]);
  });

  it("applies slightly late events at the current clock instead of dropping them", async () => {
    const monitor = new RuntimeMonitor({ store: new InMemoryMonitorStore(), assertions: [recurrenceAssertion()], reorderToleranceMs: 2_000 });
    const scope = { issue: "I-1", environment: "prod" } as const;
    expect((await monitor.process(observation({ id: "deploy", at: "2026-01-01T00:00:05Z", kind: "fix.deployed", ...scope })))[0]).toMatchObject({ outcome: "applied" });
    // Too late even for the tolerance: still refused.
    expect((await monitor.process(observation({ id: "stale", at: "2026-01-01T00:00:01Z", kind: "error.recurred", ...scope })))[0]).toMatchObject({ outcome: "out_of_order" });
    // A second late, as Stripe delivers them: applied, and it breaks the rule.
    expect((await monitor.process(observation({ id: "late", at: "2026-01-01T00:00:04Z", kind: "error.recurred", ...scope })))[0]).toMatchObject({ outcome: "applied", verdict: "violated" });
  });

  it("deduplicates inputs, rejects time regression, and resumes from checkpoints", async () => {
    const store = new InMemoryMonitorStore();
    const deploy = observation({ id: "deploy", at: "2026-01-01T00:00:05Z", kind: "fix.deployed", issue: "I-1", environment: "prod" });
    const first = new RuntimeMonitor({ store, assertions: [recurrenceAssertion()] });
    expect((await first.process(deploy))[0]).toMatchObject({ outcome: "applied" });
    expect((await first.process(deploy))[0]).toMatchObject({ outcome: "duplicate" });
    expect((await first.process(observation({ id: "late", at: "2026-01-01T00:00:04Z", kind: "error.recurred", issue: "I-1", environment: "prod" })))[0])
      .toMatchObject({ outcome: "out_of_order" });

    const restarted = new RuntimeMonitor({ store, assertions: [recurrenceAssertion()] });
    expect((await restarted.process(observation({ id: "recurrence", at: "2026-01-01T00:00:06Z", kind: "error.recurred", issue: "I-1", environment: "prod" })))[0])
      .toMatchObject({ outcome: "applied", verdict: "violated" });
    expect(await store.listViolations()).toHaveLength(1);
  });

  it("keeps rule versions isolated", async () => {
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [
      recurrenceAssertion({ version: 1 }),
      recurrenceAssertion({ version: 2 }),
    ] });
    expect(await monitor.process(observation({ id: "deploy", at: "2026-01-01T00:00:00Z", kind: "fix.deployed", issue: "I-1", environment: "prod" })))
      .toHaveLength(2);
    expect((await store.listCheckpoints()).map((checkpoint) => checkpoint.assertionVersion).sort()).toEqual([1, 2]);
  });

  it("finalizes pending eventuality and strong-next traces only when explicitly requested", async () => {
    const eventual: AssertionDefinition = {
      ...recurrenceAssertion(), id: "eventual", name: "Eventually done", formula: parseFormula("F done"),
      propositions: [{ name: "done", predicate: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "done" } }],
    };
    const next: AssertionDefinition = {
      ...eventual, id: "next", name: "Next done", formula: parseFormula("X done"),
    };
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [eventual, next] });
    const pending = observation({ id: "start", at: "2026-01-01T00:00:00Z", kind: "start", issue: "I-1", environment: "prod" });
    const processed = await monitor.process(pending);
    expect(processed.map((result) => result.outcome === "applied" ? result.verdict : result.outcome)).toEqual(["inconclusive", "inconclusive"]);

    for (const assertionId of ["eventual", "next"]) {
      expect(await monitor.finalize({
        id: `finalize-${assertionId}`,
        tenantId: "acme",
        assertionId,
        assertionVersion: 1,
        scope: { issue: "I-1", environment: "prod" },
        at: "2026-01-01T00:00:01Z",
      })).toMatchObject({ outcome: "finalized", verdict: "violated" });
    }
    expect(await store.listViolations()).toHaveLength(2);
  });
});

describe("deadline timed extension", () => {
  function deadlineAssertion(): AssertionDefinition {
    return {
      ...recurrenceAssertion(),
      id: "support-deadline",
      name: "Provisioning failure gets a support ticket",
      formula: {
        kind: "deadline",
        trigger: { kind: "atom", name: "failed" },
        response: { kind: "atom", name: "ticket" },
        withinMs: 600_000,
      },
      propositions: [
        { name: "failed", predicate: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "provisioning.failed" } },
        { name: "ticket", predicate: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "support.ticket_created" } },
      ],
    };
  }

  it("discharges at the inclusive deadline and expires only on an explicit tick", async () => {
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [deadlineAssertion()] });
    await monitor.process(observation({ id: "failure", at: "2026-01-01T00:00:00Z", kind: "provisioning.failed", issue: "order-1", environment: "prod" }));
    expect((await monitor.process(observation({ id: "ticket", at: "2026-01-01T00:10:00Z", kind: "support.ticket_created", issue: "order-1", environment: "prod", provider: "intercom" })))[0])
      .toMatchObject({ outcome: "applied", pendingObligations: 0 });
    expect(await store.listViolations()).toHaveLength(0);

    await monitor.process(observation({ id: "failure-2", at: "2026-01-01T00:11:00Z", kind: "provisioning.failed", issue: "order-1", environment: "prod" }));
    expect(await monitor.advanceTime({
      id: "tick-order-1",
      tenantId: "acme",
      assertionId: "support-deadline",
      assertionVersion: 1,
      scope: { issue: "order-1", environment: "prod" },
      at: "2026-01-01T00:21:00Z",
    })).toMatchObject({ outcome: "applied", verdict: "violated", pendingObligations: 0 });
    const violations = await store.listViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ cause: "deadline_expired", triggerEventId: "failure-2" });
  });
});

