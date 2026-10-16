import { describe, expect, it } from "vitest";
import type { AssertionDraft } from "./src/domain.js";
import { legacyProvisioningDefinition, runDemoScenario } from "./demo.js";
import { exampleRules } from "./src/examples.js";
import { exampleDraft, updateRuleChoice } from "./src/ruleDrafts.js";

function drafts(): AssertionDraft[] {
  return exampleRules.map((example) => exampleDraft(example));
}

describe("deterministic demo replay", () => {
  it("produces engine-backed counterexamples for the violating fixture", async () => {
    const output = await runDemoScenario({ scenario: "violating", assertions: drafts() });
    expect(output.violations).toHaveLength(3);
    expect(output.violations.map((violation) => violation.assertionId).sort()).toEqual([
      "boomerang",
      "clean-break",
      "no-ghosts",
    ]);
    expect(output.violations.every((violation) => violation.trace.length > 1)).toBe(true);
    expect(output.outbox.every((item) => item.status === "pending")).toBe(true);
  });

  it("changes discriminating engine output when a $ choice changes", async () => {
    const draft = exampleDraft(exampleRules.find((example) => example.id === "no-ghosts")!);
    const production = await runDemoScenario({ scenario: "violating", assertions: [draft] });
    const staging = await runDemoScenario({ scenario: "violating", assertions: [updateRuleChoice(draft, "environment", "staging")] });

    expect(production.violations).toHaveLength(1);
    expect(staging.violations).toHaveLength(0);
  });

  it("keeps all three monitors non-violating for the healthy fixture", async () => {
    const output = await runDemoScenario({ scenario: "healthy", assertions: drafts() });
    expect(output.violations).toHaveLength(0);
    expect(output.outbox).toHaveLength(0);
  });

  it("does not run a paused assertion", async () => {
    const input = drafts();
    input[0] = { ...input[0]!, status: "paused" };
    const output = await runDemoScenario({ scenario: "violating", assertions: input });
    expect(output.checkpoints.some((checkpoint) => checkpoint.assertionId === input[0]!.localId)).toBe(false);
  });

  it("advances every instantiated timed assertion through the replay horizon", async () => {
    const timedDraft = (id: string, withinMs: number, status: AssertionDraft["status"] = "monitoring"): AssertionDraft => ({
      localId: id,
      expectation: `Probe ${id}`,
      definition: {
        ...structuredClone(legacyProvisioningDefinition),
        id,
        name: `Probe ${id}`,
        formula: { ...legacyProvisioningDefinition.formula, withinMs },
      },
      status,
      createdAt: "2026-02-18T10:39:00.000Z",
      updatedAt: "2026-02-18T10:39:00.000Z",
    });
    const input = [
      timedDraft("local-probe", 600_000),
      timedDraft("local-second-scope", 600_000),
      timedDraft("local-long-deadline", 1_200_000),
      timedDraft("local-paused-probe", 600_000, "paused"),
    ];

    const violating = await runDemoScenario({ scenario: "violating", assertions: input });
    expect(violating.violations.map((item) => item.assertionId).sort()).toEqual([
      "local-probe",
      "local-second-scope",
    ]);
    expect(violating.checkpoints.filter((item) => item.assertionId !== "local-paused-probe"))
      .toHaveLength(3);
    expect(violating.checkpoints.filter((item) => item.assertionId === "local-probe")).toHaveLength(1);
    expect(violating.checkpoints.every((item) => item.lastLogicalTime === violating.replayedAt)).toBe(true);
    expect(violating.checkpoints.flatMap((item) => item.assertionId === "local-long-deadline" ? item.pendingObligations : []))
      .toHaveLength(1);
    expect(violating.checkpoints.some((item) => item.assertionId === "local-paused-probe")).toBe(false);

    const healthy = await runDemoScenario({ scenario: "healthy", assertions: input });
    expect(healthy.violations).toHaveLength(0);
    expect(healthy.checkpoints.every((item) => item.pendingObligations.length === 0)).toBe(true);
    expect(healthy.checkpoints.every((item) => item.lastLogicalTime === healthy.replayedAt)).toBe(true);
  });

  it("rejects unknown statuses and compiles paused definitions before filtering", async () => {
    const unknownStatus = { ...drafts()[0]!, status: "sleeping" } as unknown as AssertionDraft;
    await expect(runDemoScenario({ scenario: "violating", assertions: [unknownStatus] }))
      .rejects.toThrow(/status/i);

    const pausedMalformed = structuredClone(drafts()[0]!);
    pausedMalformed.status = "paused";
    pausedMalformed.definition.formula = {
      kind: "always",
      operand: { kind: "atom", name: "undeclared_atom" },
    };
    await expect(runDemoScenario({ scenario: "violating", assertions: [pausedMalformed] }))
      .rejects.toThrow(/undeclared_atom/i);
  });
});
