import { describe, expect, it } from "vitest";
import type { AssertionDraft } from "./src/domain.js";
import { authoringTemplates, runDemoScenario } from "./demo.js";

function drafts(): AssertionDraft[] {
  return authoringTemplates.map((template) => ({
    localId: template.definition.id,
    expectation: template.prompt,
    definition: template.definition,
    status: "monitoring" as const,
    templateId: template.id,
    createdAt: "2026-02-18T10:39:00.000Z",
    updatedAt: "2026-02-18T10:39:00.000Z",
  }));
}

describe("deterministic demo replay", () => {
  it("produces engine-backed counterexamples for the violating fixture", async () => {
    const output = await runDemoScenario({ scenario: "violating", assertions: drafts() });
    expect(output.violations).toHaveLength(3);
    expect(output.violations.map((violation) => violation.assertionId).sort()).toEqual([
      "disabled-feature-error",
      "linked-issue-recurrence",
      "provisioning-support",
    ]);
    expect(output.violations.every((violation) => violation.trace.length > 1)).toBe(true);
    expect(output.outbox.every((item) => item.status === "pending")).toBe(true);
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
});
