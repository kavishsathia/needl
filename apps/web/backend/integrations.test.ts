import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDemoBootstrap, runDemoScenario } from "../demo.js";
import type { AssertionDraft } from "../src/domain.js";
import { defaultMeaningValues } from "../src/meaning.js";
import { createDatabaseRuntime, migrateApplicationDatabase, type DatabaseRuntime } from "./database.js";
import { SignedIngestionService } from "./ingestion.js";
import { GitLabCallbackService, GitLabInvestigationService } from "./investigations.js";
import { NeedlRepository } from "./repository.js";

const runtimes: DatabaseRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); });

async function setup() {
  const path = join(await mkdtemp(join(tmpdir(), "needl-integrations-")), "needl.sqlite");
  const runtime = createDatabaseRuntime({ NODE_ENV: "test", NEEDL_SQLITE_PATH: path });
  runtimes.push(runtime);
  await migrateApplicationDatabase(runtime);
  return { runtime, repository: new NeedlRepository(runtime, 2) };
}

function ghostDraft(): AssertionDraft {
  const template = getDemoBootstrap().templates[0]!;
  return {
    localId: template.definition.id,
    expectation: template.prompt,
    definition: template.definition,
    status: "monitoring",
    templateId: template.id,
    meaning: { templateId: template.id, values: defaultMeaningValues(template.id) },
    createdAt: "2026-02-18T10:39:00.000Z",
    updatedAt: "2026-02-18T10:39:00.000Z",
  };
}

async function createViolation(repository: NeedlRepository, tenantId: string): Promise<string> {
  const assertion = ghostDraft();
  await repository.saveAssertion(tenantId, assertion);
  const replay = await runDemoScenario({ assertions: [assertion], scenario: "violating" });
  for (const event of replay.events.slice(0, 3)) {
    const scoped = { ...event, tenantId };
    await repository.store(scoped, { tenantId, provider: scoped.provider, deliveryId: scoped.id });
  }
  const [record] = (await repository.loadMonitorSnapshot(tenantId)).counterexamples as { id: string }[];
  return record!.id;
}

describe("signed ingestion", () => {
  it("resolves an opaque integration to its tenant, verifies raw bytes, and deduplicates", async () => {
    const { repository } = await setup();
    const tenantA = await repository.tenantForUser("hook-user-a");
    const tenantB = await repository.tenantForUser("hook-user-b");
    const rawKey = Buffer.from("dedicated-needl-gitlab-signing-key");
    const signingSecret = `whsec_${rawKey.toString("base64")}`;
    await repository.upsertIntegration({
      id: "int_gitlab_a", tenantId: tenantA, provider: "gitlab", enabled: true,
      secretEnvName: "NEEDL_TEST_GITLAB_SIGNING_SECRET",
      config: { purpose: "ingestion", authMode: "signing-token", enabledEvents: ["pipeline.success"], kindMappings: { "pipeline.success": "fix.deployed" } },
    });
    const body = Buffer.from(JSON.stringify({ object_kind: "pipeline", object_attributes: { id: 42, status: "success" }, project: { id: 7, path_with_namespace: "needl/test" } }));
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const messageId = "delivery-live-1";
    const signature = createHmac("sha256", rawKey).update(`${messageId}.${timestamp}.${body.toString()}`).digest("base64");
    const headers = { "x-gitlab-event": "Pipeline Hook", "webhook-id": messageId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` };
    const service = new SignedIngestionService(repository, { NEEDL_TEST_GITLAB_SIGNING_SECRET: signingSecret });
    await expect(service.receive("int_gitlab_a", body, headers)).resolves.toMatchObject({ outcome: "stored" });
    await expect(service.receive("int_gitlab_a", body, headers)).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(service.receive("int_gitlab_a", Buffer.from(`${body.toString()} `), headers)).resolves.toMatchObject({ outcome: "rejected", code: "unauthenticated" });
    expect((await repository.loadMonitorSnapshot(tenantA)).events).toHaveLength(1);
    expect((await repository.loadMonitorSnapshot(tenantB)).events).toHaveLength(0);
  });
});

describe("GitLab investigations", () => {
  it("launches once, correlates a signed terminal callback, and isolates sibling tenants", async () => {
    const { repository } = await setup();
    const tenantA = await repository.tenantForUser("investigation-user-a");
    const tenantB = await repository.tenantForUser("investigation-user-b");
    const violationId = await createViolation(repository, tenantA);
    const callbackKey = Buffer.from("dedicated-needl-callback-key");
    await repository.upsertIntegration({
      id: "int_investigation_a", tenantId: tenantA, provider: "gitlab", enabled: true,
      secretEnvName: "NEEDL_TEST_GITLAB_TOKEN",
      config: {
        purpose: "investigation", baseUrl: "https://gitlab.example", projectId: "needl/test",
        consumerId: 12, tokenType: "private-token", callbackHookId: 81,
        callbackSecretEnvName: "NEEDL_TEST_GITLAB_CALLBACK_SECRET",
      },
    });
    await repository.upsertIntegration({
      id: "int_investigation_b", tenantId: tenantB, provider: "gitlab", enabled: true,
      secretEnvName: "NEEDL_TEST_GITLAB_TOKEN",
      config: { purpose: "investigation", baseUrl: "https://gitlab.example", projectId: "needl/test-b", consumerId: 13, tokenType: "private-token" },
    });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/graphql")) {
        const query = JSON.parse(String(init?.body)) as { variables: { workflowId: string } };
        expect(query.variables.workflowId).toBe("gid://gitlab/Ai::DuoWorkflows::Workflow/918");
        return new Response(JSON.stringify({ data: { duoWorkflowWorkflows: { nodes: [{ id: query.variables.workflowId, status: "RUNNING", statusName: "Running", statusGroup: "RUNNING", webUrl: "https://gitlab.example/needl/test/-/automate/agent-sessions/918", updatedAt: "2026-10-15T00:00:00Z" }] } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(sent).toMatchObject({ project_id: "needl/test", ai_catalog_item_consumer_id: 12, start_workflow: true, allow_agent_to_request_user: false });
      expect(JSON.stringify(sent)).not.toContain("test-private-token");
      return new Response(JSON.stringify({ id: 918, web_url: "https://gitlab.example/needl/test/-/automate/agent-sessions/918", status: "running", ai_catalog_item_version_id: 77 }), { status: 201, headers: { "content-type": "application/json" } });
    });
    const environment = { NEEDL_TEST_GITLAB_TOKEN: "test-private-token", NEEDL_TEST_GITLAB_CALLBACK_SECRET: `whsec_${callbackKey.toString("base64")}` };
    const service = new GitLabInvestigationService(repository, environment, fetcher as typeof fetch);
    const launched = await service.launch(tenantA, violationId);
    expect(launched).toMatchObject({ status: "running", workflowId: "918", attempt: 1 });
    await expect(service.launch(tenantA, violationId)).resolves.toMatchObject({ id: launched.id, status: "running" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(service.launch(tenantB, violationId)).rejects.toThrow(/not found in this workspace/i);
    await expect(service.refresh(tenantA, launched.id)).resolves.toMatchObject({ status: "running", workflowId: "918" });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const callbackBody = Buffer.from(JSON.stringify({ event_id: "callback-1", event_type: "flow.completed", client_reference: launched.clientReference, workflow: { id: "918" }, result: { message: "Read-only investigation completed." } }));
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const messageId = "callback-delivery-1";
    const callbackSignature = createHmac("sha256", callbackKey).update(Buffer.concat([Buffer.from(`${messageId}.${timestamp}.`), callbackBody])).digest("base64");
    const callback = new GitLabCallbackService(repository, environment);
    const callbackHeaders = { "webhook-id": messageId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${callbackSignature}` };
    await expect(callback.receive("int_investigation_a", callbackBody, callbackHeaders)).resolves.toBe("processed");
    await expect(callback.receive("int_investigation_a", callbackBody, callbackHeaders)).resolves.toBe("duplicate");
    await expect(repository.getInvestigation(tenantA, launched.id)).resolves.toMatchObject({ status: "completed", resultMessage: "Read-only investigation completed." });
  });

  it("records ambiguous launch outcomes without retrying", async () => {
    const { repository } = await setup();
    const tenant = await repository.tenantForUser("ambiguous-user");
    const violationId = await createViolation(repository, tenant);
    await repository.upsertIntegration({
      id: "int_ambiguous", tenantId: tenant, provider: "gitlab", enabled: true,
      secretEnvName: "NEEDL_TEST_GITLAB_TOKEN",
      config: { purpose: "investigation", baseUrl: "https://gitlab.example", projectId: "needl/test", consumerId: 12, tokenType: "private-token" },
    });
    const fetcher = vi.fn(async () => { throw new Error("synthetic timeout"); });
    const service = new GitLabInvestigationService(repository, { NEEDL_TEST_GITLAB_TOKEN: "test-private-token" }, fetcher as typeof fetch);
    await expect(service.launch(tenant, violationId)).resolves.toMatchObject({ status: "launch_unknown" });
    await expect(service.launch(tenant, violationId)).resolves.toMatchObject({ status: "launch_unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
