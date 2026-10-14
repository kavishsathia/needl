import { describe, expect, it } from "vitest";
import { parseStoredAssertions, serializeAssertions } from "./storage.js";
import type { AssertionDraft } from "./domain.js";

const valid: AssertionDraft = {
  localId: "local-1",
  expectation: "A release should stay quiet after deployment",
  definition: {
    id: "local-1",
    version: 1,
    tenantId: "synthetic-demo",
    name: "A release should stay quiet after deployment",
    formula: { kind: "always", operand: { kind: "not", operand: { kind: "atom", name: "error" } } },
    scope: { keys: [{ name: "service", extractors: [{ from: "relationship", type: "service" }] }] },
    propositions: [{ name: "error", predicate: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "error.recurred" } }],
  },
  status: "monitoring",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("assertion storage", () => {
  it("round-trips a validated assertion envelope", () => {
    expect(parseStoredAssertions(serializeAssertions([valid]))).toEqual([valid]);
  });

  it.each(["not json", "{}", '{"version":2,"assertions":[]}', '{"version":1,"assertions":[{"localId":"x"}]}'])(
    "rejects invalid restored data: %s",
    (payload) => expect(parseStoredAssertions(payload)).toEqual([]),
  );

  it("rejects executable or unsafe predicate-shaped restore data", () => {
    const tampered = JSON.parse(serializeAssertions([valid]));
    tampered.assertions[0].definition.propositions[0].predicate = { op: "eval", source: "alert(1)" };
    expect(parseStoredAssertions(JSON.stringify(tampered))).toEqual([]);
  });
});
