import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitLabAdapter, LinearAdapter } from "../src/adapters/index.js";
import type { NormalizedEvent } from "../src/core/index.js";
import {
  InMemoryMonitorStore,
  RuntimeMonitor,
  compileAssertion,
  extractValue,
  formatFormula,
  parseFormula,
  validateFormula,
  type AssertionDefinition,
} from "../src/ltl/index.js";

const tenantId = "acme";
const linearSecret = "test-only-linear-secret";
const gitlabKey = Buffer.from("test-only-gitlab-signing-key");
const gitlabSecret = `whsec_${gitlabKey.toString("base64")}`;

async function gitlabDeployment(input: { deliveryId: string; ref: string; environment: string; at: Date }): Promise<NormalizedEvent> {
  const body = Buffer.from(JSON.stringify({
    object_kind: "deployment",
    status: "success",
    status_changed_at: input.at.toISOString(),
    deployment_id: Number(input.deliveryId.replace(/\D/g, "")),
    environment: input.environment,
    ref: input.ref,
    project: { id: 7, path_with_namespace: "acme/shop", web_url: "https://gitlab.example/acme/shop" },
  }));
  const timestamp = String(Math.floor(input.at.getTime() / 1_000));
  const signature = createHmac("sha256", gitlabKey).update(`${input.deliveryId}.${timestamp}.${body.toString()}`).digest("base64");
  const result = await new GitLabAdapter().ingest({
    tenantId,
    rawBody: body,
    receivedAt: input.at,
    headers: { "x-gitlab-event": "Deployment Hook", "webhook-id": input.deliveryId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` },
  }, { secrets: [gitlabSecret], authMode: "signing-token", payloadRetention: "full" });
  if (result.status !== "accepted") throw new Error(`GitLab fixture was not accepted: ${JSON.stringify(result)}`);
  return result.event;
}

async function linearIssueUpdate(input: { deliveryId: string; identifier: string; stateType: string; at: Date }): Promise<NormalizedEvent> {
  const body = Buffer.from(JSON.stringify({
    action: "update",
    type: "Issue",
    createdAt: input.at.toISOString(),
    webhookTimestamp: input.at.getTime(),
    webhookId: input.deliveryId,
    data: {
      id: `uuid-${input.identifier}`,
      identifier: input.identifier,
      title: "Checkout retry loop",
      state: { name: input.stateType === "completed" ? "Done" : "In Progress", type: input.stateType },
      url: `https://linear.app/acme/issue/${input.identifier}`,
    },
  }));
  const signature = createHmac("sha256", linearSecret).update(body).digest("hex");
  const result = await new LinearAdapter().ingest({
    tenantId,
    rawBody: body,
    receivedAt: input.at,
    headers: { "linear-signature": signature, "linear-delivery": input.deliveryId },
  }, { secrets: [linearSecret], payloadRetention: "full" });
  if (result.status !== "accepted") throw new Error(`Linear fixture was not accepted: ${JSON.stringify(result)}`);
  return result.event;
}

/** "After a production deploy of a branch for issue X on GitLab, X must never be reopened on Linear." */
function deployedIssueStaysClosed(): AssertionDefinition {
  return {
    id: "deployed-issue-stays-closed",
    version: 1,
    tenantId,
    name: "A deployed issue is not reopened",
    formula: parseFormula("G (production_deploy -> bind(issue) G !reopened)"),
    scope: { keys: [{ name: "workspace", extractors: [{ from: "literal", value: "all" }] }] },
    bindings: [{
      name: "issue",
      extractors: [{ provider: "gitlab", from: "relationship", type: "ref", pattern: "issue-key" }],
    }],
    propositions: [
      {
        name: "production_deploy",
        predicate: { op: "and", operands: [
          { op: "equal", path: { root: "event", segments: ["providerEventType"] }, value: "deployment.success" },
          { op: "equal", source: { from: "relationship", type: "environment" }, value: "production" },
        ] },
      },
      {
        name: "reopened",
        predicate: { op: "and", operands: [
          { op: "equal", path: { root: "event", segments: ["provider"] }, value: "linear" },
          { op: "equal", source: { from: "relationship", type: "issue-key" }, variable: "issue" },
          { op: "in", source: { from: "payload", path: ["data", "state", "type"] }, values: ["unstarted", "started"] },
        ] },
      },
    ],
  };
}

describe("formula bind operator", () => {
  it("parses, formats, and validates bind as a unary operator", () => {
    const formula = parseFormula("G (deploy -> bind(issue) G !reopened)");
    expect(formula).toEqual({
      kind: "always",
      operand: {
        kind: "implies",
        left: { kind: "atom", name: "deploy" },
        right: { kind: "bind", variable: "issue", operand: { kind: "always", operand: { kind: "not", operand: { kind: "atom", name: "reopened" } } } },
      },
    });
    expect(formatFormula(formula)).toBe("G (deploy -> bind(issue) G !reopened)");
    expect(() => parseFormula("bind(G) p")).toThrow(/invalid bind variable/);
    expect(() => validateFormula({ kind: "deadline", withinMs: 1_000, trigger: { kind: "bind", variable: "x", operand: { kind: "atom", name: "p" } }, response: { kind: "atom", name: "q" } }))
      .toThrow(/cannot bind/);
  });

  it("rejects atoms that compare against a variable outside its bind", () => {
    const definition = deployedIssueStaysClosed();
    expect(() => compileAssertion({ ...definition, formula: parseFormula("G (production_deploy -> G !reopened)") }))
      .toThrow(/reopened uses issue outside any bind\(issue\)/);
    expect(() => compileAssertion({ ...definition, bindings: [] }))
      .toThrow(/undeclared binding "issue"/);
    expect(() => compileAssertion({ ...definition, formula: parseFormula("G (production_deploy -> bind(other) G !reopened)") }))
      .toThrow(/bind\(other\) has no binding definition/);
  });
});

describe("value sources", () => {
  it("applies provider filters, named patterns, names, and retained payload paths", async () => {
    const at = new Date("2026-10-15T10:00:00Z");
    const deploy = await gitlabDeployment({ deliveryId: "deploy-1", ref: "eng-42-fix-retry", environment: "production", at });
    expect(extractValue({ provider: "gitlab", from: "relationship", type: "ref", pattern: "issue-key" }, deploy)).toBe("ENG-42");
    expect(extractValue({ provider: "linear", from: "relationship", type: "ref" }, deploy)).toBeUndefined();
    expect(extractValue({ from: "relationship", type: "project", field: "name" }, deploy)).toBe("acme/shop");
    expect(extractValue({ from: "payload", path: ["deployment_id"] }, deploy)).toBe("1");
    const unlinked = await gitlabDeployment({ deliveryId: "deploy-2", ref: "main", environment: "production", at });
    expect(extractValue({ from: "relationship", type: "ref", pattern: "issue-key" }, unlinked)).toBeUndefined();
  });
});

describe("RuntimeMonitor with bound variables over real adapter output", () => {
  it("ties a Linear reopen to the issue key frozen from the GitLab deploy branch", async () => {
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [deployedIssueStaysClosed()] });
    const base = Date.parse("2026-10-15T10:00:00Z");
    const at = (minutes: number) => new Date(base + minutes * 60_000);

    const deploy = await gitlabDeployment({ deliveryId: "deploy-42", ref: "eng-42-fix-retry", environment: "production", at: at(0) });
    expect((await monitor.process(deploy))[0]).toMatchObject({ outcome: "applied", verdict: "inconclusive" });
    const checkpoint = await store.loadCheckpoint((await store.listCheckpoints())[0]!.key);
    expect(JSON.stringify(checkpoint?.residual)).toContain("\"issue\":\"ENG-42\"");

    const otherIssue = await linearIssueUpdate({ deliveryId: "lin-7", identifier: "ENG-7", stateType: "started", at: at(1) });
    expect((await monitor.process(otherIssue))[0]).toMatchObject({ outcome: "applied", verdict: "inconclusive" });
    const stillDone = await linearIssueUpdate({ deliveryId: "lin-42-done", identifier: "ENG-42", stateType: "completed", at: at(2) });
    expect((await monitor.process(stillDone))[0]).toMatchObject({ outcome: "applied", verdict: "inconclusive" });

    const reopened = await linearIssueUpdate({ deliveryId: "lin-42-reopen", identifier: "ENG-42", stateType: "started", at: at(3) });
    expect((await monitor.process(reopened))[0]).toMatchObject({ outcome: "applied", verdict: "violated" });

    const [record] = await store.listViolations();
    expect(record).toMatchObject({ cause: "formula_false", assertionId: "deployed-issue-stays-closed" });
    expect(record!.sourceEvents.map((source) => source.providerEventType)).toEqual(["deployment.success", "Issue.update", "Issue.update", "Issue.update"]);
    const deployItem = record!.trace[0]!;
    expect(deployItem.type === "observation" && deployItem.captured).toEqual({ issue: "ENG-42" });
    // The bind point is only reached on the deploy; later observations capture nothing.
    expect(record!.trace.slice(1).every((item) => item.type !== "observation" || item.captured === undefined)).toBe(true);
    const reopenItem = record!.trace.at(-1)!;
    expect(reopenItem.type === "observation" && reopenItem.valuation).toMatchObject({ 'reopened{issue="ENG-42"}': true });
  });

  it("keeps one frozen obligation per bound value and ignores deploys whose branch carries no key", async () => {
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [deployedIssueStaysClosed()] });
    const base = Date.parse("2026-10-15T11:00:00Z");
    const at = (minutes: number) => new Date(base + minutes * 60_000);

    await monitor.process(await gitlabDeployment({ deliveryId: "deploy-1", ref: "eng-1-fix", environment: "production", at: at(0) }));
    await monitor.process(await gitlabDeployment({ deliveryId: "deploy-2", ref: "eng-2-fix", environment: "production", at: at(1) }));
    await monitor.process(await gitlabDeployment({ deliveryId: "deploy-3", ref: "eng-1-followup", environment: "production", at: at(2) }));
    const unlinked = await monitor.process(await gitlabDeployment({ deliveryId: "deploy-4", ref: "main", environment: "production", at: at(3) }));
    expect(unlinked[0]).toMatchObject({ outcome: "applied", verdict: "inconclusive" });
    await monitor.process(await gitlabDeployment({ deliveryId: "deploy-5", ref: "eng-3-fix", environment: "staging", at: at(4) }));

    const residual = JSON.stringify((await store.listCheckpoints())[0]!.residual);
    expect(residual.match(/"issue":"ENG-1"/g)).toHaveLength(1);
    expect(residual).toContain("\"issue\":\"ENG-2\"");
    expect(residual).not.toContain("ENG-3");

    const reopenedStaging = await monitor.process(await linearIssueUpdate({ deliveryId: "lin-3", identifier: "ENG-3", stateType: "started", at: at(5) }));
    expect(reopenedStaging[0]).toMatchObject({ verdict: "inconclusive" });
    const reopened = await monitor.process(await linearIssueUpdate({ deliveryId: "lin-2", identifier: "ENG-2", stateType: "unstarted", at: at(6) }));
    expect(reopened[0]).toMatchObject({ verdict: "violated" });
  });

  it("finalizes a bound formula from its residual", async () => {
    const definition: AssertionDefinition = {
      ...deployedIssueStaysClosed(),
      id: "deploy-then-close",
      formula: parseFormula("G (production_deploy -> bind(issue) F closed)"),
      propositions: [
        deployedIssueStaysClosed().propositions[0]!,
        {
          name: "closed",
          predicate: { op: "and", operands: [
            { op: "equal", source: { provider: "linear", from: "relationship", type: "issue-key" }, variable: "issue" },
            { op: "equal", source: { from: "payload", path: ["data", "state", "type"] }, value: "completed" },
          ] },
        },
      ],
    };
    const store = new InMemoryMonitorStore();
    const monitor = new RuntimeMonitor({ store, assertions: [definition] });
    const base = Date.parse("2026-10-15T12:00:00Z");
    await monitor.process(await gitlabDeployment({ deliveryId: "deploy-9", ref: "eng-9-fix", environment: "production", at: new Date(base) }));
    await monitor.process(await linearIssueUpdate({ deliveryId: "lin-8", identifier: "ENG-8", stateType: "completed", at: new Date(base + 60_000) }));
    const scope = { workspace: "all" };
    const finalized = await monitor.finalize({ id: "final-1", tenantId, assertionId: definition.id, assertionVersion: 1, scope, at: new Date(base + 120_000).toISOString() });
    expect(finalized).toMatchObject({ outcome: "finalized", verdict: "violated" });

    const satisfiedStore = new InMemoryMonitorStore();
    const satisfiedMonitor = new RuntimeMonitor({ store: satisfiedStore, assertions: [definition] });
    await satisfiedMonitor.process(await gitlabDeployment({ deliveryId: "deploy-9", ref: "eng-9-fix", environment: "production", at: new Date(base) }));
    await satisfiedMonitor.process(await linearIssueUpdate({ deliveryId: "lin-9", identifier: "ENG-9", stateType: "completed", at: new Date(base + 60_000) }));
    await expect(satisfiedMonitor.finalize({ id: "final-2", tenantId, assertionId: definition.id, assertionVersion: 1, scope, at: new Date(base + 120_000).toISOString() }))
      .resolves.toMatchObject({ outcome: "finalized", verdict: "satisfied" });
  });
});
