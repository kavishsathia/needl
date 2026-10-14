import { describe, expect, it } from "vitest";
import { parseStoredAssertions, serializeAssertions } from "./storage.js";
import { validateProductAssertionCollection } from "./collection.js";
import type { AssertionDraft } from "./domain.js";
import { authoringTemplates } from "../demo.js";
import { createDraftFromTemplate } from "./authoring.js";

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

  it("restores canonical meaning for legacy authored clones without relying on a built-in ID", () => {
    const authored = createDraftFromTemplate("A renamed recurrence rule", authoringTemplates[0]!, []);
    const legacy = { ...authored, meaning: undefined };
    const restored = parseStoredAssertions(JSON.stringify({ version: 1, assertions: [legacy] }));

    expect(restored[0]!.localId).toMatch(/^local-/);
    expect(restored[0]!.localId).not.toBe(authoringTemplates[0]!.definition.id);
    expect(restored[0]!.meaning).toEqual(authored.meaning);
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

  it("rejects invalid collections instead of validating drafts in isolation", () => {
    const duplicate = { version: 1, assertions: [valid, structuredClone(valid)] };
    expect(parseStoredAssertions(JSON.stringify(duplicate))).toEqual([]);

    const wrongTenant = {
      ...structuredClone(valid),
      definition: { ...structuredClone(valid.definition), tenantId: "another-tenant" },
    };
    expect(parseStoredAssertions(JSON.stringify({ version: 1, assertions: [wrongTenant] }))).toEqual([]);

    const oversized = Array.from({ length: 26 }, (_, index) => ({
      ...structuredClone(valid),
      localId: `local-${index}`,
      definition: { ...structuredClone(valid.definition), id: `local-${index}` },
    }));
    expect(parseStoredAssertions(JSON.stringify({ version: 1, assertions: oversized }))).toEqual([]);
  });

  it("refuses to serialize invalid changes so accepted storage can be preserved", () => {
    expect(() => serializeAssertions([valid, structuredClone(valid)])).toThrow(/duplicate/i);
    expect(() => serializeAssertions(Array.from({ length: 26 }, (_, index) => ({
      ...structuredClone(valid),
      localId: `local-${index}`,
      definition: { ...structuredClone(valid.definition), id: `local-${index}` },
    })))).toThrow(/at most 25/i);
  });

  it("retains unsupported saved rules and user text as disabled needs-review records", () => {
    const unsupported = {
      ...structuredClone(valid),
      expectation: "Every paid order should eventually be fulfilled",
      definition: {
        ...structuredClone(valid.definition),
        name: "Every paid order should eventually be fulfilled",
        formula: { kind: "eventually", operand: { kind: "atom", name: "error" } } as const,
      },
      history: [{ at: "2025-12-01T00:00:00.000Z", note: "User-owned historical evidence" }],
    };
    const restored = parseStoredAssertions(JSON.stringify({ version: 1, assertions: [unsupported] }));

    expect(restored).toHaveLength(1);
    expect(restored[0]!.expectation).toBe(unsupported.expectation);
    expect(restored[0]!.definition).toEqual(unsupported.definition);
    expect(restored[0]!.status).toBe("needs-review");
    expect(restored[0]!.reviewReason).toMatch(/eventually happen/i);
    expect((restored[0] as AssertionDraft & { history: unknown }).history).toEqual(unsupported.history);
  });

  it("does not let paused or needs-review records bypass enablement policy", () => {
    const eventual = {
      ...structuredClone(valid),
      status: "paused" as const,
      definition: {
        ...structuredClone(valid.definition),
        formula: { kind: "eventually", operand: { kind: "atom", name: "error" } } as const,
      },
    };
    expect(() => validateProductAssertionCollection([eventual])).toThrow(/eventually happen/i);
    expect(() => validateProductAssertionCollection([{ ...eventual, status: "needs-review", reviewReason: "Legacy liveness rule" }], { allowNeedsReview: false }))
      .toThrow(/eventually happen/i);
  });
});
