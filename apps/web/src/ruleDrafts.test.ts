import { describe, expect, it } from "vitest";
import { validateProductAssertionCollection } from "./collection.js";
import { exampleRules } from "./examples.js";
import { createDraftFromRule, exampleDraft, ruleProviders, updateRuleChoice, updateRuleSource, upgradeLegacyDraft } from "./ruleDrafts.js";

const [ghost, boomerang] = exampleRules;

describe("rule drafts", () => {
  it("creates paused, uniquely identified drafts compiled from the rule", () => {
    const first = createDraftFromRule({ expectation: "Keep checkout quiet", rule: { source: ghost!.source, values: { environment: "production" } }, existingIds: [], now: "2026-01-01T00:00:00.000Z" });
    const second = createDraftFromRule({ expectation: "Keep checkout quiet", rule: { source: ghost!.source, values: { environment: "production" } }, existingIds: [first.localId] });
    expect(first.status).toBe("paused");
    expect(second.localId).toBe(`${first.localId}-2`);
    expect(first.definition.version).toBe(1);
    expect(ruleProviders(first)).toEqual(["gitlab", "sentry"]);
    expect(() => validateProductAssertionCollection([first, second])).not.toThrow();
  });

  it("refuses a rule whose inputs are not all set, unless they have defaults", () => {
    const source = "input environment: text\nnever gitlab.deployment(status = \"failed\", environment = $environment)";
    expect(() => createDraftFromRule({ expectation: "No failed deploys", rule: { source, values: {} }, existingIds: [] })).toThrow(/Choose an environment/);
    expect(JSON.stringify(createDraftFromRule({ expectation: "Keep checkout quiet", rule: { source: ghost!.source, values: {} }, existingIds: [] }).definition)).toContain("production");
  });

  it("upgrades a saved rule written with notes without changing its monitor", () => {
    const legacySource = `always (
  #"once {1}, {2}"
  (
    #"a branch for an issue gets a {1} deploy to {2}, keeping {3}"
    gitlab.deployment(status = "success", environment = $environment) bind issue = ref.issue_key
    ->
    #"{1} must never appear there again"
    never (
      #"an error alert tagged {1} in {2}"
      sentry.event_alert(tags.linear_issue.issue_key = issue, environment = $environment)
      or
      #"an error tagged {1} in {2}"
      sentry.error(tags.linear_issue.issue_key = issue, environment = $environment)
    )
  )
)`;
    const current = exampleDraft(ghost!, { values: { environment: "staging" } });
    const saved = { ...current, rule: { source: legacySource, values: { environment: "staging" } } };
    const example = upgradeLegacyDraft(saved);
    expect(example.upgraded).toBe(true);
    expect(example.draft).toMatchObject({ exampleId: "no-ghosts", rule: { source: ghost!.source, values: { environment: "staging" } }, definition: current.definition });
    const custom = upgradeLegacyDraft({ ...saved, exampleId: undefined, localId: "mine" });
    expect((custom.draft as typeof current).rule?.source).toMatch(/^input environment: text\n\nalways \(/);
    expect(upgradeLegacyDraft(current).upgraded).toBe(false);
  });

  it("versions choice changes and recompiles the monitor", () => {
    const draft = exampleDraft(ghost!);
    const staging = updateRuleChoice(draft, "environment", "staging", "2026-01-02T00:00:00.000Z");
    expect(staging.definition.version).toBe(2);
    expect(staging.rule?.values).toEqual({ environment: "staging" });
    expect(staging.definition.formula).toEqual(draft.definition.formula);
    expect(JSON.stringify(staging.definition.propositions)).toContain("staging");
  });

  it("saves edited rule text as a new version, keeping choices that still exist", () => {
    const draft = exampleDraft(ghost!, { values: { environment: "production" } });
    const edited = updateRuleSource(draft, {
      expectation: "No failed production deploys",
      source: "input environment: text\nnever gitlab.deployment(status = \"failed\", environment = $environment)",
    }, "2026-01-02T00:00:00.000Z");
    expect(edited.definition.version).toBe(2);
    expect(edited.rule?.values).toEqual({ environment: "production" });
    expect(edited.exampleId).toBeUndefined();
    expect(() => updateRuleSource(draft, { expectation: "Every deploy is eventually followed up", source: "always (gitlab.deployment -> eventually sentry.issue)" }))
      .toThrow(/Line 1, column 30: `eventually` has no time limit/);
  });

  it("rejects stored rules that do not match their monitor", () => {
    const draft = exampleDraft(ghost!);
    const tampered = { ...draft, rule: { ...draft.rule!, values: { environment: "staging" } } };
    expect(() => validateProductAssertionCollection([tampered])).toThrow(/rule does not match its stored monitor/);
  });

  it("rewrites template-based assertions as rules with a new version", () => {
    const legacy = {
      ...exampleDraft(boomerang!),
      rule: undefined, exampleId: undefined,
      templateId: "ghost", meaning: { templateId: "ghost", values: { trigger: "fix-branch-deployed", outcome: "tagged-errors", environment: "staging" } },
      localId: "no-ghosts",
      definition: { ...exampleDraft(ghost!).definition, version: 4 },
    };
    const { draft, upgraded } = upgradeLegacyDraft(legacy);
    expect(upgraded).toBe(true);
    const [validated] = validateProductAssertionCollection([draft]);
    expect(validated).toMatchObject({ exampleId: "no-ghosts", rule: { values: { environment: "staging" } }, definition: { version: 5 } });
    expect(validated).not.toHaveProperty("meaning");
    expect(upgradeLegacyDraft(exampleDraft(ghost!)).upgraded).toBe(false);
  });
});
