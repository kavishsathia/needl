import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "../src/core/index.js";
import {
  applyStateUpdates,
  compileAssertion,
  evaluatePropositions,
  extractScope,
  type AssertionDefinition,
} from "../src/ltl/index.js";

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: "evt-1",
    provider: "sentry",
    providerEventType: "issue.created",
    tenantId: "tenant-a",
    source: {},
    occurredAt: "2026-10-14T10:00:00.000Z",
    receivedAt: "2026-10-14T10:00:01.000Z",
    kind: "error.recurred",
    subject: { type: "issue", id: "SENTRY-1" },
    relationships: [
      { type: "feature_flag", id: "checkout-v2", evidencePath: "/tags/feature" },
      { type: "environment", id: "production", evidencePath: "/environment" },
    ],
    evidence: {
      providerPayload: { level: "error", count: 2 },
      links: [],
      authenticity: "synthetic-test",
      bodySha256: "abc",
    },
    ...overrides,
  };
}

const definition: AssertionDefinition = {
  id: "no-disabled-feature-error",
  version: 1,
  tenantId: "tenant-a",
  name: "Disabled feature does not execute",
  formula: {
    kind: "always",
    operand: {
      kind: "not",
      operand: {
        kind: "and",
        operands: [{ kind: "atom", name: "disabled" }, { kind: "atom", name: "feature_error" }],
      },
    },
  },
  scope: {
    keys: [
      { name: "feature", extractors: [{ from: "relationship", type: "feature_flag" }] },
      { name: "environment", extractors: [{ from: "relationship", type: "environment" }] },
    ],
  },
  propositions: [
    {
      name: "disabled",
      predicate: { op: "equal", path: { root: "state", segments: ["enabled"] }, value: false },
    },
    {
      name: "feature_error",
      predicate: {
        op: "and",
        operands: [
          { op: "equal", path: { root: "event", segments: ["provider"] }, value: "sentry" },
          { op: "equal", path: { root: "event", segments: ["kind"] }, value: "error.recurred" },
          { op: "in", path: { root: "event", segments: ["evidence", "providerPayload", "level"] }, values: ["error", "fatal"] },
        ],
      },
    },
  ],
  stateUpdates: [
    {
      when: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "feature.disabled" },
      set: { enabled: { from: "literal", value: false } },
    },
    {
      when: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "feature.enabled" },
      set: { enabled: { from: "literal", value: true } },
    },
  ],
};

describe("declarative proposition extraction", () => {
  it("compiles formulas, scope, predicates, and state rules", () => {
    const assertion = compileAssertion(definition);
    expect(assertion.formula).toEqual(definition.formula);
    expect(assertion.atomNames).toEqual(["disabled", "feature_error"]);
  });

  it("requires every explicit scope binding and never correlates on time", () => {
    const assertion = compileAssertion(definition);
    expect(extractScope(assertion, event())).toEqual({ feature: "checkout-v2", environment: "production" });
    expect(extractScope(assertion, event({ relationships: [] }))).toBeUndefined();
    expect(extractScope(assertion, event({
      relationships: [{ type: "feature_flag", id: "checkout-v2", evidencePath: "/tags/feature" }],
    }))).toBeUndefined();
  });

  it("updates persisted state before evaluating propositions", () => {
    const assertion = compileAssertion(definition);
    const disable = event({ provider: "launchdarkly", kind: "feature.disabled" });
    const state = applyStateUpdates(assertion, disable, {});
    expect(state).toEqual({ enabled: false });
    const result = evaluatePropositions(assertion, event(), state);
    expect(result.valuation).toEqual({ disabled: true, feature_error: true });
    expect(result.evaluations.feature_error!.explanation).toMatch(/provider|kind/);

    const enabled = applyStateUpdates(assertion, event({ provider: "launchdarkly", kind: "feature.enabled" }), state);
    expect(evaluatePropositions(assertion, event(), enabled).valuation.disabled).toBe(false);
  });

  it("gives missing properties explicit false comparison semantics", () => {
    const compiled = compileAssertion({
      ...definition,
      propositions: [
        { name: "not_equal_missing", predicate: { op: "notEqual", path: { root: "event", segments: ["evidence", "providerPayload", "absent"] }, value: 1 } },
        { name: "exists_missing", predicate: { op: "exists", path: { root: "event", segments: ["evidence", "providerPayload", "absent"] } } },
      ],
      formula: { kind: "or", operands: [{ kind: "atom", name: "not_equal_missing" }, { kind: "atom", name: "exists_missing" }] },
    });
    expect(evaluatePropositions(compiled, event(), {}).valuation).toEqual({
      not_equal_missing: false,
      exists_missing: false,
    });
  });

  it("rejects duplicate atoms, unsafe paths, malformed values, and unsupported predicates", () => {
    expect(() => compileAssertion({ ...definition, propositions: [...definition.propositions, definition.propositions[0]!] })).toThrow(/duplicate/i);
    expect(() => compileAssertion({
      ...definition,
      propositions: [{ name: "disabled", predicate: { op: "exists", path: { root: "event", segments: ["__proto__"] } } }],
      formula: { kind: "atom", name: "disabled" },
    })).toThrow(/unsafe/i);
    expect(() => compileAssertion({
      ...definition,
      propositions: [{ name: "disabled", predicate: { op: "matches", code: "process.exit()" } as never }],
      formula: { kind: "atom", name: "disabled" },
    })).toThrow(/predicate/i);
  });
});
