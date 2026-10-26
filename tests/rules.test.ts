import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "../src/core/index.js";
import { InMemoryMonitorStore, RuntimeMonitor, formatFormula, findLiveness, type LtlFormula } from "../src/ltl/index.js";
import {
  catalogue,
  checkRule,
  choiceIssues,
  compileRule,
  readRule,
  readingText,
  suggestChoices,
  stripNotes,
  upgradeRuleSource,
  type CheckedRule,
  breakingExamples,
  type BreakExample,
} from "../src/rules/index.js";

const tenantId = "acme";

function ok(source: string, options?: Parameters<typeof checkRule>[1]): CheckedRule {
  const result = checkRule(source, options);
  if (!result.ok) throw new Error(result.errors.map((error) => `${error.message} @${error.span.line}:${error.span.column}`).join("\n"));
  return result.rule;
}

function errors(source: string, options?: Parameters<typeof checkRule>[1]): string[] {
  const result = checkRule(source, options);
  if (result.ok) throw new Error("expected errors");
  return result.errors.map((error) => error.message);
}

function event(input: {
  id: string;
  provider: NormalizedEvent["provider"];
  type: string;
  at: string;
  subject?: string;
  relationships?: Readonly<Record<string, string>>;
  payload?: Readonly<Record<string, unknown>>;
}): NormalizedEvent {
  return {
    id: input.id,
    provider: input.provider,
    providerEventType: input.type,
    tenantId,
    source: {},
    occurredAt: input.at,
    receivedAt: input.at,
    kind: input.type,
    subject: { type: "thing", id: input.subject ?? input.id },
    relationships: Object.entries(input.relationships ?? {}).map(([type, id]) => ({ type, id, evidencePath: `/${type}` })),
    evidence: { providerPayload: input.payload ?? {}, links: [], authenticity: "test", bodySha256: "0".repeat(64) },
  };
}

const ghost = `input env: text
always (
  gitlab.deployment(status = "success", environment = $env) bind issue = ref.issue_key
  -> never sentry.event_alert(tags.linear_issue.issue_key = issue, environment = $env)
)`;

describe("rule syntax", () => {
  it("reports syntax errors with their position", () => {
    const result = checkRule("always (gitlab.deployment(status = \"success\")");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ message: expect.stringMatching(/close the parenthesis/), span: { line: 1 } });
    expect(errors("eventually within 5x stripe.invoice.paid")[0]).toMatch(/duration unit/);
    expect(errors("stripe.invoice.paid until stripe.charge.failed unless stripe.charge.succeeded")[0]).toMatch(/Chained until is ambiguous/);
  });
});

describe("rule checking against the catalogue", () => {
  it("names unknown integrations, events and fields with the valid choices", () => {
    expect(errors("never gitlub.deployment")[0]).toMatch(/Unknown integration "gitlub".*Did you mean gitlab/);
    expect(errors("never gitlab.deploy")[0]).toMatch(/gitlab has no event "deploy".*deployment/);
    expect(errors("never linear.issue(status = \"Done\")")[0]).toMatch(/linear.issue has no field "status". Its fields are: action, identifier/);
  });

  it("checks types, provider-fixed values and comparisons", () => {
    expect(errors("never stripe.charge.succeeded(amount = \"10\")")[0]).toMatch(/amount is a number/);
    expect(errors("never gitlab.deployment(status = \"succeeded\")")[0]).toMatch(/not a value of gitlab.deployment.status. Allowed: "created"/);
    expect(errors("never stripe.charge.succeeded(amount contains 3)")[0]).toMatch(/amount is a number; use =/);
    expect(ok("never stripe.charge.succeeded(amount > 10000, currency in [\"usd\", \"eur\"])").params).toEqual([]);
  });

  it("requires a rule to apply at every event and rejects invented id values", () => {
    expect(errors("stripe.invoice.payment_failed -> eventually within 1h stripe.invoice.paid")[0]).toMatch(/Start the rule with `always/);
    expect(errors("always (gitlab.deployment -> eventually within 30m linear.issue(state_id = \"done\"))")[0]).toMatch(/not a valid linear.issue.state_id: it holds Linear UUIDs/);
    expect(errors("never stripe.invoice.paid(customer = \"acme\")")[0]).toMatch(/Stripe ids starting with cus_/);
    expect(ok("never stripe.invoice.paid(customer = \"cus_A1\")")).toBeDefined();
  });

  it("marks problems confined to the sentence so a caller can drop it", () => {
    const result = checkRule("rule \"A deploy fails {env}\"\nnever gitlab.deployment(status = \"failed\")");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.every((error) => error.kind === "sentence")).toBe(true);
  });

  it("scopes bound values to where they were bound", () => {
    expect(errors("always (sentry.issue(action = \"resolved\") -> never sentry.issue(issue = issue))")[0]).toMatch(/"issue" is not bound/);
    expect(errors("never sentry.issue(action = \"resolved\") bind issue = issue")[0]).toMatch(/only works on the left of `->`/);
    expect(errors("always (sentry.issue bind x = issue -> never sentry.issue bind x = issue)")[0]).toMatch(/only works on the left/);
    const prefix = ok("always (sentry.issue(action = \"resolved\") -> bind issue = sentry.issue.issue in never sentry.issue(action = \"unresolved\", issue = issue))");
    expect(prefix.bindings.get("issue")?.field.name).toBe("issue");
  });

  it("types inputs by their declaration and checks it against where they are used", () => {
    const rule = ok(ghost);
    expect(rule.params).toHaveLength(1);
    expect(rule.params[0]).toMatchObject({ name: "env", type: "string", list: false, label: "environment" });
    expect(rule.params[0]!.usages.map((usage) => `${usage.event.provider}.${usage.event.name}.${usage.field.name}`))
      .toEqual(["gitlab.deployment.environment", "sentry.event_alert.environment"]);
    const fixed = ok("input statuses: list of text\nnever gitlab.deployment(status in $statuses)");
    expect(fixed.params[0]).toMatchObject({ list: true, options: expect.arrayContaining([{ value: "failed", label: "failed" }]) });
    expect(errors("input x: text\nnever (gitlab.deployment(environment = $x) or stripe.charge.succeeded(amount = $x))")[0]).toMatch(/different types/);
    expect(errors("never gitlab.deployment(environment = $env)")[0]).toMatch(/\$env is not declared. Add `input env: text`/);
    expect(errors("input env: number\nnever gitlab.deployment(environment = $env)")[0]).toMatch(/declared as number.*needs text/);
    expect(errors("input env: text\nnever gitlab.deployment(status in $env)")[0]).toMatch(/needs list of text/);
    expect(errors("input env: text\ninput spare: number\nnever gitlab.deployment(environment = $env)")[0]).toMatch(/spare is declared but the rule never uses/);
    expect(errors("input env: text\ninput env: text\nnever gitlab.deployment(environment = $env)")[0]).toMatch(/declared twice/);
    expect(errors("input wait: text\nalways (gitlab.deployment -> eventually within $wait linear.issue)")[0]).toMatch(/declared as text.*needs duration/);
  });

  it("checks defaults against the input's type and allowed values, and fills them in", () => {
    const rule = ok("input env: text = \"production\"\ninput limit: duration = 2h\nalways (gitlab.deployment(environment = $env) -> eventually within $limit linear.issue)");
    expect(rule.params.map((param) => [param.name, param.default])).toEqual([["limit", "2h"], ["env", "production"]]);
    expect(choiceIssues(rule, {})).toEqual([]);
    expect(JSON.stringify(compileRule(rule, {}, { id: "r", version: 1, tenantId, name: "r" }).formula)).toContain('"withinMs":7200000');
    expect(JSON.stringify(compileRule(rule, { env: "staging" }, { id: "r", version: 1, tenantId, name: "r" }))).toContain("staging");
    expect(errors("input s: text = \"exploded\"\nnever gitlab.deployment(status = $s)")[0]).toMatch(/Default for s: "exploded" is not an allowed status/);
    expect(errors("input a: number = \"10\"\nnever stripe.charge.succeeded(amount > $a)")[0]).toMatch(/Default for a: "10" is not a number/);
    expect(errors("input s: list of text = \"failed\"\nnever gitlab.deployment(status in $s)")[0]).toMatch(/list of status values/);
    expect(ok("input on: boolean = true\nnever linear.issue(state_changed = $on)").params[0]?.default).toBe(true);
  });

  it("rejects liveness and accepts bounded or safe shapes, pointing at the operator", () => {
    expect(errors("always (gitlab.deployment -> eventually linear.issue)")[0]).toMatch(/`eventually` has no time limit/);
    expect(errors("stripe.invoice.paid until stripe.charge.failed")[0]).toMatch(/`until` also requires/);
    expect(errors("not always stripe.invoice.paid")[0]).toMatch(/`not always/);
    expect(errors("not never stripe.invoice.paid")[0]).toMatch(/`not never/);
    expect(errors("(not stripe.charge.succeeded) unless within 5m stripe.invoice.paid")[0]).toMatch(/`unless` cannot take a time window/);
    for (const source of [
      "always (gitlab.deployment -> eventually within 30m linear.issue)",
      "always (stripe.customer.subscription.deleted bind c = customer -> (not stripe.invoice.paid(customer = c)) unless stripe.customer.subscription.updated(customer = c, status = \"active\"))",
      "always (stripe.charge.failed -> next not eventually stripe.charge.failed)",
      "always (gitlab.deployment -> always within 1h not sentry.error)",
    ]) {
      const rule = ok(source);
      expect(findLiveness(compileRule(rule, {}, { id: "r", version: 1, tenantId, name: "r" }).formula), source).toBeUndefined();
    }
  });

  it("refuses a `never` that the starting event itself satisfies, and suggests `next never`", () => {
    // The authoring agent wrote this for "an invoice must never be paid twice": it breaks on every paid invoice.
    expect(errors("always (stripe.invoice.paid bind invoice = id -> never stripe.invoice.paid(id = invoice))")[0]).toMatch(/next never/);
    expect(errors("always (stripe.invoice.paid(livemode = true) bind c = customer -> never stripe.invoice.paid(livemode = true, customer = c))")[0]).toMatch(/next never/);
    ok("always (stripe.invoice.paid bind invoice = id -> next never stripe.invoice.paid(id = invoice))");
    // A condition the starting event may not meet keeps the rule meaningful.
    ok("always (stripe.invoice.paid bind c = customer -> never stripe.invoice.paid(customer = c, livemode = false))");
    ok("always (stripe.charge.dispute.created bind pi = payment_intent -> never stripe.charge.succeeded(payment_intent = pi))");
  });
});

describe("the rule sentence", () => {
  const body = "input env: text = \"production\"\nnever gitlab.deployment(status = \"failed\", environment = $env)";

  it("must show every input and never write out numbers, events or input values", () => {
    expect(ok(`rule "No deploy to {env} may fail"\n${body}`).sentence?.text).toBe("No deploy to {env} may fail");
    expect(errors(`rule "No deploy may fail"\n${body}`)[0]).toMatch(/must show \{env\}/);
    expect(errors(`rule "No deploy to {envy} may fail {env}"\n${body}`)[0]).toMatch(/no input envy/);
    expect(errors(`rule "No deploy to {env} may fail in production"\n${body}`)[0]).toMatch(/cannot write out "production"/);
    expect(errors(`rule "No staging deploy to {env} may fail"\n${body}`, { paramValues: { env: "staging" } })[0]).toMatch(/"staging"/);
    expect(errors(`rule "No {env} deploy may fail twice in 2 days"\n${body}`)[0]).toMatch(/numbers/);
    expect(errors(`rule "No gitlab.deployment to {env} may fail"\n${body}`)[0]).toMatch(/provider.event/);
    expect(errors(`rule "No {env} deploy {may} fail"\n${body}`)[0]).toMatch(/no input may/);
    expect(errors(`${body.split("\n")[0]}\nrule "late {env}"\n${body.split("\n")[1]}`)[0]).toMatch(/sentence comes first/);
    expect(errors("never #\"a {1} deploy\" gitlab.deployment(status = \"failed\")")[0]).toMatch(/Notes .* are gone/);
  });

  it("reads the sentence with the chosen values as choices, and the rule word for word on request", () => {
    const rule = ok(`rule "Once an issue's branch is deployed to {env}, no error tagged with it may appear in {env}"
input env: text
always (gitlab.deployment(status = "success", environment = $env) bind issue = ref.issue_key
  -> never sentry.event_alert(tags.linear_issue.issue_key = issue, environment = $env))`);
    const reading = readRule(rule, { env: "staging" });
    expect(readingText(reading)).toBe("Once an issue's branch is deployed to staging, no error tagged with it may appear in staging.");
    expect(reading.filter((segment) => segment.kind === "choice")).toEqual([
      { kind: "choice", param: "env", label: "environment", text: "staging" },
      { kind: "choice", param: "env", label: "environment", text: "staging" },
    ]);
    expect(readingText(readRule(rule, {}, "mechanical"))).toMatch(/^Whenever there is a GitLab deployment where status is successful and environment is \[environment\]/);
    expect(readingText(readRule(ok(ghost), { env: "staging" }))).toMatch(/^Whenever there is a GitLab deployment/);
  });
});

describe("upgrading rules written with notes", () => {
  it("drops notes and declares each $ input from its use, leaving the logic unchanged", () => {
    const old = `always (
  #"once {1}, {2}"
  (
    #"a push to {1}, keeping its commit as {2}"
    gitlab.push(ref = $ref) bind commit = commit
    ->
    #"within {1}, {2}"
    eventually within $time_limit
      linear.issue(title contains commit) // the note text "a {1}" stays inside comments and strings
  )
)`;
    const upgraded = upgradeRuleSource(old)!;
    expect(upgraded.split("\n").slice(0, 3)).toEqual(["input time_limit: duration", "input ref: text", ""]);
    expect(upgraded).not.toContain("#\"");
    expect(upgraded).toContain("// the note text \"a {1}\" stays");
    const values = { ref: "refs/heads/main", time_limit: "1h" };
    const before = compileRule(ok(stripNotes(old), { inferUndeclared: true }), values, { id: "r", version: 1, tenantId, name: "r" });
    expect(compileRule(ok(upgraded), values, { id: "r", version: 1, tenantId, name: "r" })).toEqual(before);
    expect(upgradeRuleSource(upgraded)).toBeUndefined();
  });
});

describe("compiling and running rules", () => {
  it("compiles per-entity rules into partitioned monitors with frozen bindings", () => {
    const rule = ok(ghost);
    expect(choiceIssues(rule, {})).toEqual([{ param: "env", message: "Choose an environment" }]);
    const definition = compileRule(rule, { env: "production" }, { id: "ghost", version: 1, tenantId, name: "Ghost" });
    expect(formatFormula(definition.formula as LtlFormula)).toBe("G (e1_gitlab_deployment -> bind(issue) G !e2_sentry_event_alert)");
    expect(definition.scope.keys).toEqual([{ name: "issue", extractors: [
      { from: "relationship", type: "ref", pattern: "issue-key", provider: "gitlab" },
      { from: "relationship", type: "tag.linear_issue", pattern: "issue-key", provider: "sentry" },
    ] }]);
  });

  it("monitors the global rule as one instance when events are not all about the bound value", () => {
    const rule = ok("always (sentry.issue(action = \"resolved\") bind issue = issue -> never (sentry.issue(action = \"unresolved\", issue = issue) or gitlab.deployment(status = \"failed\")))");
    expect(rule.partition).toBeUndefined();
    expect(compileRule(rule, {}, { id: "r", version: 1, tenantId, name: "r" }).scope.keys).toEqual([{ name: "rule", extractors: [{ from: "literal", value: "all" }] }]);
  });

  it("catches a broken rule from real event sequences", async () => {
    const rule = ok(ghost);
    const definition = compileRule(rule, { env: "production" }, { id: "ghost", version: 1, tenantId, name: "Ghost" });
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [definition] });
    await monitor.process(event({ id: "d1", provider: "gitlab", type: "deployment.success", at: "2026-10-15T10:00:00Z", relationships: { ref: "eng-42-fix", environment: "production" }, payload: { status: "success" } }));
    await monitor.process(event({ id: "s0", provider: "sentry", type: "event_alert.triggered", at: "2026-10-15T10:01:00Z", relationships: { "tag.linear_issue": "ENG-7", environment: "production" } }));
    await monitor.process(event({ id: "s1", provider: "sentry", type: "event_alert.triggered", at: "2026-10-15T10:02:00Z", relationships: { "tag.linear_issue": "ENG-42", environment: "staging" } }));
    expect(await store.listViolations()).toHaveLength(0);
    await monitor.process(event({ id: "s2", provider: "sentry", type: "event_alert.triggered", at: "2026-10-15T10:03:00Z", relationships: { "tag.linear_issue": "eng-42", environment: "production" } }));
    const violations = await store.listViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ scope: { issue: "ENG-42" }, cause: "formula_false" });
  });

  it("runs a time-bounded response rule over a bound customer and catches the deadline on a clock tick", async () => {
    const rule = ok("always (stripe.invoice.payment_failed bind customer = customer -> eventually within 1h stripe.invoice.paid(customer = customer))");
    expect(rule.partition?.variable).toBe("customer");
    const definition = compileRule(rule, {}, { id: "recover", version: 1, tenantId, name: "Recover" });
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [definition] });
    await monitor.process(event({ id: "f1", provider: "stripe", type: "invoice.payment_failed", at: "2026-10-15T10:00:00Z", relationships: { customer: "cus_a" } }));
    await monitor.process(event({ id: "f2", provider: "stripe", type: "invoice.payment_failed", at: "2026-10-15T10:05:00Z", relationships: { customer: "cus_b" } }));
    await monitor.process(event({ id: "p2", provider: "stripe", type: "invoice.paid", at: "2026-10-15T10:30:00Z", relationships: { customer: "cus_b" } }));
    for (const checkpoint of await store.listCheckpoints()) {
      if (checkpoint.nextDueAt === undefined) continue;
      await monitor.advanceTime({ id: `tick-${checkpoint.key}`, tenantId, assertionId: "recover", assertionVersion: 1, scope: checkpoint.scope, at: "2026-10-15T11:30:00Z" });
    }
    const violations = await store.listViolations();
    expect(violations.map((record) => [record.scope.customer, record.cause])).toEqual([["cus_a", "deadline_expired"]]);
  });
});

describe("monitoring continues after a violation", () => {
  it("reports every broken obligation of a shared monitor, from events and from clock ticks", async () => {
    const rule = ok("always (gitlab.push bind commit = commit -> eventually within 1m linear.issue(title contains commit))");
    expect(rule.partition).toBeUndefined();
    const definition = compileRule(rule, {}, { id: "sha", version: 1, tenantId, name: "sha" });
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [definition] });
    const push = (id: string, sha: string, at: string) => monitor.process(event({ id, provider: "gitlab", type: "push", at, relationships: { commit: sha } }));
    await push("p1", "aaa111", "2026-10-15T10:00:00Z");
    await push("p2", "bbb222", "2026-10-15T10:00:10Z");
    await monitor.process(event({ id: "l1", provider: "linear", type: "Issue.update", at: "2026-10-15T10:00:20Z", subject: "issue-1" }));
    await monitor.process({ ...event({ id: "l2", provider: "linear", type: "Issue.update", at: "2026-10-15T10:00:30Z" }), subject: { type: "issue", id: "x", name: "Shipped aaa111" } });
    await monitor.advanceTime({ id: "t1", tenantId, assertionId: "sha", assertionVersion: 1, scope: { rule: "all" }, at: "2026-10-15T10:01:15Z" });
    await push("p3", "ccc333", "2026-10-15T10:02:00Z");
    await monitor.advanceTime({ id: "t2", tenantId, assertionId: "sha", assertionVersion: 1, scope: { rule: "all" }, at: "2026-10-15T10:03:05Z" });
    expect((await store.listViolations()).map((record) => record.cause)).toEqual(["deadline_expired", "deadline_expired"]);
    expect((await store.listCheckpoints())[0]?.nextDueAt).toBeUndefined();
  });

  it("reports a second breach for the same entity", async () => {
    const definition = compileRule(ok(ghost), { env: "production" }, { id: "ghost", version: 1, tenantId, name: "Ghost" });
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [definition] });
    await monitor.process(event({ id: "d1", provider: "gitlab", type: "deployment.success", at: "2026-10-15T10:00:00Z", relationships: { ref: "eng-42-fix", environment: "production" }, payload: { status: "success" } }));
    for (const [id, at] of [["s1", "2026-10-15T10:01:00Z"], ["s2", "2026-10-15T10:02:00Z"]] as const) {
      await monitor.process(event({ id, provider: "sentry", type: "event_alert.triggered", at, relationships: { "tag.linear_issue": "ENG-42", environment: "production" } }));
    }
    expect(await store.listViolations()).toHaveLength(2);
  });
});

describe("time-limit choices", () => {
  const source = "input time_limit: duration\nalways (stripe.invoice.payment_failed bind customer = customer -> eventually within $time_limit stripe.invoice.paid(customer = customer))";

  it("are typed as durations, validated, compiled and read back as choices", () => {
    const rule = ok(source);
    expect(rule.params).toEqual([{ name: "time_limit", type: "duration", list: false, label: "time limit", usages: [], declared: true }]);
    expect(choiceIssues(rule, { time_limit: "soon" })[0]?.message).toMatch(/not a time limit/);
    const definition = compileRule(rule, { time_limit: "2m" }, { id: "r", version: 1, tenantId, name: "r" });
    expect(JSON.stringify(definition.formula)).toContain('"withinMs":120000');
    expect(readRule(rule, { time_limit: "2m" }, "mechanical")).toContainEqual({ kind: "choice", param: "time_limit", label: "time limit", text: "2 minutes" });
    const [suggestions] = suggestChoices(rule, []);
    expect(suggestions?.freeText).toBe(true);
    expect(suggestions?.values.map((value) => value.value)).toContain("1h");
    expect(errors("input x: duration\nalways (stripe.invoice.payment_failed -> eventually within $x stripe.charge.succeeded(amount = $x))")[0]).toMatch(/both as a time limit and as a field value/);
  });
});

describe("choice suggestions", () => {
  it("ranks values seen everywhere a choice is used, with counts", () => {
    const rule = ok(ghost);
    const events = [
      event({ id: "d1", provider: "gitlab", type: "deployment.success", at: "2026-10-15T10:00:00Z", relationships: { environment: "production" } }),
      event({ id: "d2", provider: "gitlab", type: "deployment.success", at: "2026-10-15T10:01:00Z", relationships: { environment: "staging" } }),
      event({ id: "d3", provider: "gitlab", type: "deployment.success", at: "2026-10-15T10:02:00Z", relationships: { environment: "production" } }),
      event({ id: "s1", provider: "sentry", type: "event_alert.triggered", at: "2026-10-15T10:03:00Z", relationships: { environment: "production" } }),
      event({ id: "x1", provider: "sentry", type: "issue.resolved", at: "2026-10-15T10:04:00Z", relationships: { environment: "review" } }),
    ];
    const [suggestions] = suggestChoices(rule, events);
    expect(suggestions?.freeText).toBe(true);
    expect(suggestions?.values.map((value) => [value.value, value.counts, value.seenEverywhere])).toEqual([
      ["production", [2, 1], true],
      ["staging", [1, 0], false],
    ]);
  });
});

describe("catalogue", () => {
  it("only reads relationships and payload keys its adapter writes", async () => {
    for (const entry of catalogue) {
      const adapter = await readFile(new URL(`../src/adapters/${entry.provider}.ts`, import.meta.url), "utf8");
      for (const catalogueEvent of entry.events) {
        for (const field of catalogueEvent.fields) {
          const read = field.read;
          if (read.from === "path") {
            const [root, scope, key] = read.segments;
            if (root === "providerEventType") continue;
            expect(root === "evidence" && scope === "providerPayload", `${entry.provider}.${catalogueEvent.name}.${field.name}`).toBe(true);
            expect(adapter, `${entry.provider} adapter writes payload key ${key}`).toMatch(new RegExp(`\\b${key}\\b`));
          } else if (read.source.from === "relationship") {
            expect(adapter, `${entry.provider} adapter emits relationship ${read.source.type}`).toContain(`"${read.source.type}"`);
          }
        }
      }
    }
  });
});

describe("breaking examples", () => {
  const events = (example: BreakExample): string[] => example.steps.map((step) =>
    step.kind === "time" ? "time" : step.kind === "anyOf" ? `any(${step.events.map((event) => event.provider).join(",")})` : step.provider);

  it("shows each shortest way a launch rule breaks, grouping alternatives", () => {
    const rule = ok(`rule "When a flag goes on in {environment}, its Linear issue must reach Done within {time_limit}, with no failed payment"
input environment: text = "production"
input time_limit: duration = 1h
always (
  launchdarkly.flag(actions contains "updateOn", environment = $environment) bind f = flag
  -> (eventually within $time_limit linear.issue(identifier = f, state = "Done"))
     and (always within $time_limit not (stripe.payment_intent.payment_failed or stripe.charge.failed))
)`);
    const examples = breakingExamples(rule, {});
    expect(examples.map(events)).toEqual([["launchdarkly", "any(stripe,stripe)"], ["launchdarkly", "time"]]);
    const time = examples[1]!.steps[1]!;
    expect(time.kind === "time" && time.text).toBe("The time limit runs out (1 hour later)");
  });

  it("drops examples that only repeat a step of a shorter one", () => {
    const rule = ok(`rule "A critical metric alert must be resolved within {time_limit}"
input time_limit: duration = 1h
always (sentry.metric_alert(action = "critical") -> eventually within $time_limit sentry.metric_alert(action = "resolved"))`);
    expect(breakingExamples(rule, {}).map(events)).toEqual([["sentry", "time"]]);
  });

  it("finds nothing for a rule no short sequence can break", () => {
    const rule = ok(`rule "Anything goes"
always (stripe.charge.succeeded -> true)`);
    expect(breakingExamples(rule, {})).toEqual([]);
  });
});
