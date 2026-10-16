import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "../src/core/index.js";
import {
  InMemoryMonitorStore,
  RuntimeMonitor,
  advanceFormulaTime,
  findLiveness,
  nextDeadline,
  parseFormula,
  prefixVerdict,
  progressFormula,
  type AssertionDefinition,
  type LtlFormula,
} from "../src/ltl/index.js";

const tenantId = "acme";
const start = Date.parse("2026-10-15T10:00:00Z");
const minutes = (count: number): string => new Date(start + count * 60_000).toISOString();

function observe(formula: LtlFormula, atoms: Readonly<Record<string, boolean>>, at: string): LtlFormula {
  return progressFormula(formula, { atom: (name) => atoms[name] === true, bind: () => undefined, at });
}

describe("timed operators", () => {
  const within = (operand: LtlFormula): LtlFormula => ({ kind: "eventuallyWithin", operand, withinMs: 30 * 60_000 });
  const p: LtlFormula = { kind: "atom", name: "p" };

  it("opens the window at the first observation and is met inside it", () => {
    const opened = observe(within(p), { p: false }, minutes(0));
    expect(opened).toEqual({ kind: "eventuallyBy", operand: p, by: minutes(30) });
    expect(nextDeadline(opened)).toBe(minutes(30));
    expect(prefixVerdict(observe(opened, { p: true }, minutes(30)))).toBe("satisfied");
  });

  it("fails on a late observation and on a clock tick after the window closes", () => {
    const opened = observe(within(p), { p: false }, minutes(0));
    expect(prefixVerdict(observe(opened, { p: true }, minutes(31)))).toBe("violated");
    expect(advanceFormulaTime(opened, minutes(30))).toEqual(opened);
    expect(prefixVerdict(advanceFormulaTime(opened, minutes(31)))).toBe("violated");
  });

  it("treats always-within as satisfied once its window passes", () => {
    const opened = observe({ kind: "alwaysWithin", operand: p, withinMs: 60_000 }, { p: true }, minutes(0));
    expect(prefixVerdict(observe(opened, { p: false }, minutes(1)))).toBe("violated");
    expect(prefixVerdict(advanceFormulaTime(opened, minutes(2)))).toBe("satisfied");
  });

  it("keeps weak until open while its left side holds and never requires the right side", () => {
    const formula = parseFormula("!p W q");
    const progressed = observe(formula, { p: false, q: false }, minutes(0));
    expect(prefixVerdict(progressed)).toBe("inconclusive");
    expect(prefixVerdict(observe(progressed, { p: true, q: false }, minutes(1)))).toBe("violated");
    expect(prefixVerdict(observe(progressed, { p: false, q: true }, minutes(1)))).toBe("satisfied");
  });
});

describe("syntactic safety", () => {
  it("accepts safety shapes and rejects unbounded eventualities with their location", () => {
    expect(findLiveness(parseFormula("G (p -> bind(x) G !q)"))).toBeUndefined();
    expect(findLiveness(parseFormula("G (!p W q)"))).toBeUndefined();
    expect(findLiveness(parseFormula("!F p"))).toBeUndefined();
    expect(findLiveness(parseFormula("!(p U q)"))).toBeUndefined();
    expect(findLiveness({ kind: "always", operand: { kind: "implies", left: { kind: "atom", name: "p" }, right: { kind: "eventuallyWithin", operand: { kind: "atom", name: "q" }, withinMs: 1_000 } } })).toBeUndefined();
    expect(findLiveness(parseFormula("G (p -> F q)"))).toMatchObject({ operator: "eventually", path: "$.operand.right" });
    expect(findLiveness(parseFormula("p U q"))).toMatchObject({ operator: "until" });
    expect(findLiveness(parseFormula("!G p"))).toMatchObject({ operator: "always", negated: true });
    expect(findLiveness(parseFormula("(G p) -> q"))).toMatchObject({ operator: "always", negated: true });
    expect(findLiveness(parseFormula("!(p W q)"))).toMatchObject({ operator: "weakUntil", negated: true });
  });
});

function event(id: string, kind: string, issue: string, at: string): NormalizedEvent {
  return {
    id,
    provider: "gitlab",
    providerEventType: kind,
    tenantId,
    source: {},
    occurredAt: at,
    receivedAt: at,
    kind,
    subject: { type: kind, id },
    relationships: [{ type: "issue", id: issue, evidencePath: "/issue" }],
    evidence: { providerPayload: {}, links: [], authenticity: "test", bodySha256: "0".repeat(64) },
  };
}

/** After a deploy for an issue, that issue must be closed within 30 minutes. */
const closedAfterDeploy: AssertionDefinition = {
  id: "closed-after-deploy",
  version: 1,
  tenantId,
  name: "Deployed issues close within 30 minutes",
  formula: { kind: "always", operand: { kind: "implies", left: { kind: "atom", name: "deployed" }, right: { kind: "bind", variable: "issue", operand: { kind: "eventuallyWithin", operand: { kind: "atom", name: "closed" }, withinMs: 30 * 60_000 } } } },
  scope: { keys: [{ name: "issue", extractors: [{ from: "relationship", type: "issue" }] }] },
  bindings: [{ name: "issue", extractors: [{ from: "relationship", type: "issue" }] }],
  propositions: [
    { name: "deployed", predicate: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "deploy" } },
    { name: "closed", predicate: { op: "and", operands: [
      { op: "equal", path: { root: "event", segments: ["kind"] }, value: "close" },
      { op: "equal", source: { from: "relationship", type: "issue" }, variable: "issue" },
    ] } },
  ],
};

describe("runtime with time windows over bound values", () => {
  it("reports an expired window on a clock tick and exposes when the next tick is due", async () => {
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [closedAfterDeploy] });
    const [opened] = await monitor.process(event("deploy-1", "deploy", "ENG-1", minutes(0)));
    expect(opened).toMatchObject({ outcome: "applied", verdict: "inconclusive" });
    const [checkpoint] = await store.listCheckpoints();
    expect(checkpoint?.nextDueAt).toBe(minutes(30));

    const early = await monitor.advanceTime({ id: "tick-early", tenantId, assertionId: closedAfterDeploy.id, assertionVersion: 1, scope: { issue: "ENG-1" }, at: minutes(20) });
    expect(early).toMatchObject({ outcome: "applied", verdict: "inconclusive", violationIds: [] });
    const late = await monitor.advanceTime({ id: "tick-late", tenantId, assertionId: closedAfterDeploy.id, assertionVersion: 1, scope: { issue: "ENG-1" }, at: minutes(31) });
    expect(late).toMatchObject({ outcome: "applied", verdict: "violated" });
    const [record] = await store.listViolations();
    expect(record).toMatchObject({ cause: "deadline_expired", scope: { issue: "ENG-1" } });
    expect((await store.listCheckpoints())[0]?.nextDueAt).toBeUndefined();
  });

  it("is satisfied when the bound issue closes in time, regardless of other issues", async () => {
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [closedAfterDeploy] });
    await monitor.process(event("deploy-1", "deploy", "ENG-1", minutes(0)));
    await monitor.process(event("close-2", "close", "ENG-2", minutes(5)));
    const [closed] = await monitor.process(event("close-1", "close", "ENG-1", minutes(10)));
    expect(closed).toMatchObject({ outcome: "applied", verdict: "inconclusive", violationIds: [] });
    const late = await monitor.advanceTime({ id: "tick", tenantId, assertionId: closedAfterDeploy.id, assertionVersion: 1, scope: { issue: "ENG-1" }, at: minutes(45) });
    expect(late).toMatchObject({ violationIds: [] });
  });
});
