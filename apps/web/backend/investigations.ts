import { Buffer } from "node:buffer";
import { hmac, secureEqual } from "../../../src/core/crypto.js";
import type { CounterexampleRecord } from "../../../src/ltl/runtime-types.js";
import type { NeedlRepository, InvestigationRecord, StoredIntegration } from "./repository.js";
import { SecretBox } from "./secrets.js";

interface GitLabInvestigationConfig {
  readonly baseUrl: string;
  readonly projectId: string;
  readonly consumerId: number;
  readonly tokenType: "private-token" | "bearer";
  readonly callbackHookId?: number;
  readonly callbackSecretEnvName?: string;
  readonly sourceBranch?: string;
  readonly mergeRequestIid?: number;
  readonly issueIid?: number;
  /** What the flow is asked to do. The violation id and its record (as needl_counterexample) are always passed. */
  readonly goal?: string;
}

export class GitLabLaunchError extends Error {
  constructor(message: string, readonly ambiguous: boolean) { super(message); }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function investigationConfig(integration: StoredIntegration): GitLabInvestigationConfig {
  const baseUrl = text(integration.config.baseUrl);
  const project = integration.config.projectId;
  const projectId = typeof project === "number" && Number.isSafeInteger(project) ? String(project) : text(project);
  const consumerId = integer(integration.config.consumerId);
  const tokenType = integration.config.tokenType === "bearer" ? "bearer" : integration.config.tokenType === "private-token" ? "private-token" : undefined;
  if (baseUrl === undefined || projectId === undefined || consumerId === undefined || tokenType === undefined) {
    throw new Error("GitLab investigation integration is missing baseUrl, projectId, consumerId, or tokenType");
  }
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("GitLab investigation baseUrl must use HTTPS");
  }
  return {
    baseUrl: parsed.origin,
    projectId,
    consumerId,
    tokenType,
    ...(integer(integration.config.callbackHookId) === undefined ? {} : { callbackHookId: integer(integration.config.callbackHookId) }),
    ...(text(integration.config.callbackSecretEnvName) === undefined ? {} : { callbackSecretEnvName: text(integration.config.callbackSecretEnvName) }),
    ...(text(integration.config.sourceBranch) === undefined ? {} : { sourceBranch: text(integration.config.sourceBranch) }),
    ...(integer(integration.config.mergeRequestIid) === undefined ? {} : { mergeRequestIid: integer(integration.config.mergeRequestIid) }),
    ...(integer(integration.config.issueIid) === undefined ? {} : { issueIid: integer(integration.config.issueIid) }),
    ...(text(integration.config.goal) === undefined ? {} : { goal: text(integration.config.goal)!.slice(0, 4_000) }),
  };
}

function counterexampleEnvelope(record: CounterexampleRecord, config: GitLabInvestigationConfig): Record<string, unknown> {
  return {
    schema_version: "1",
    violation_id: record.id,
    assertion_id: record.assertionId,
    assertion_version: record.assertionVersion,
    expectation: record.assertionName,
    detected_at: record.detectedAt,
    entity_bindings: { ...record.scope, gitlab_project: config.projectId },
    timeline: record.sourceEvents.slice(-20).map((source) => ({
      at: source.occurredAt ?? source.receivedAt,
      source: source.provider,
      kind: source.kind,
      summary: `${source.subject.type} ${source.subject.id}`.slice(0, 300),
      ...(source.links[0]?.url === undefined ? {} : { source_url: source.links[0].url }),
    })),
    unknowns: [],
  };
}

function safeProviderMessage(value: unknown, fallback: string): string {
  const source = text(object(value)?.message) ?? text(object(value)?.error) ?? fallback;
  return source.replace(/[\r\n\t]+/g, " ").slice(0, 1_000);
}

export class GitLabInvestigationService {
  constructor(
    private readonly repository: NeedlRepository,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async launch(tenantId: string, violationId: string): Promise<InvestigationRecord> {
    const integration = await this.repository.findInvestigationIntegration(tenantId);
    if (integration === undefined) throw Object.assign(new Error("No enabled GitLab investigation integration is configured for this workspace"), { statusCode: 503 });
    const config = investigationConfig(integration);
    const counterexample = await this.repository.getCounterexample(tenantId, violationId) as CounterexampleRecord;
    const queued = await this.repository.queueInvestigation(tenantId, integration.id, violationId, counterexample.assertionVersion);
    if (!(await this.repository.claimInvestigationLaunch(tenantId, queued.id))) return this.repository.getInvestigation(tenantId, queued.id);

    try {
      const launched = await this.callGitLab(integration, config, counterexample, queued.clientReference);
      return await this.repository.recordInvestigationLaunch(tenantId, queued.id, launched);
    } catch (cause) {
      const error = cause instanceof GitLabLaunchError ? cause : new GitLabLaunchError("GitLab launch outcome is unknown after a transport failure", true);
      return this.repository.recordInvestigationLaunchFailure(tenantId, queued.id, error.ambiguous ? "launch_unknown" : "failed_to_start", error.message);
    }
  }

  #box: SecretBox | undefined;

  /** Tokens saved in the app are sealed in the database; older setups name a server environment variable. */
  private token(integration: StoredIntegration): string | undefined {
    if (integration.secretCiphertext !== undefined) return (this.#box ??= SecretBox.fromEnvironment(this.environment)).open(integration.secretCiphertext);
    const value = integration.secretEnvName === "" ? undefined : this.environment[integration.secretEnvName];
    return value === undefined || value.length === 0 ? undefined : value;
  }

  /** Launches flows for violations that arrived since the last pass, where the workspace opted into autoLaunch. */
  async launchPending(): Promise<number> {
    let launched = 0;
    for (const { tenantId, violationId } of await this.repository.listViolationsAwaitingLaunch()) {
      try {
        await this.launch(tenantId, violationId);
        launched += 1;
      } catch (error) {
        process.stderr.write(`Automatic GitLab launch failed for ${violationId}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    return launched;
  }

  /** Asks GitLab how running flows are doing, so finished flows show as finished without anyone clicking refresh. */
  async refreshRunning(): Promise<number> {
    let refreshed = 0;
    for (const { tenantId, id } of await this.repository.listInvestigationsToRefresh()) {
      try {
        await this.refresh(tenantId, id);
        refreshed += 1;
      } catch (error) {
        await this.repository.touchInvestigation(tenantId, id).catch(() => undefined);
        process.stderr.write(`GitLab status check failed for ${id}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    return refreshed;
  }

  async refresh(tenantId: string, investigationId: string): Promise<InvestigationRecord> {
    const investigation = await this.repository.getInvestigation(tenantId, investigationId);
    if (["completed", "failed", "stopped"].includes(investigation.status) || investigation.workflowId === undefined) return investigation;
    const integration = await this.repository.getIntegration(investigation.integrationId);
    if (integration.tenantId !== tenantId || !integration.enabled || integration.config.purpose !== "investigation") {
      throw Object.assign(new Error("GitLab investigation integration is not enabled for this workspace"), { statusCode: 404 });
    }
    const config = investigationConfig(integration);
    const token = this.token(integration);
    if (token === undefined) throw Object.assign(new Error("The GitLab flow connection has no access token"), { statusCode: 503 });
    const headers: Record<string, string> = { "content-type": "application/json" };
    headers[config.tokenType === "bearer" ? "authorization" : "private-token"] = config.tokenType === "bearer" ? `Bearer ${token}` : token;
    let response: Response;
    try {
      response = await this.fetcher(`${config.baseUrl}/api/graphql`, {
        method: "POST", headers, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          query: "query NeedlFlowStatus($workflowId: AiDuoWorkflowsWorkflowID!) { duoWorkflowWorkflows(workflowId: $workflowId) { nodes { id status statusName statusGroup webUrl summary title updatedAt aiCatalogItemVersionId mergeRequestLinks(first: 5) { nodes { mergeRequest { webUrl title } } } latestCheckpoint { lastDuoMessage { content } } } } }",
          variables: { workflowId: `gid://gitlab/Ai::DuoWorkflows::Workflow/${investigation.workflowId}` },
        }),
      });
    } catch {
      throw Object.assign(new Error("GitLab status could not be resolved after a timeout or network failure"), { statusCode: 502 });
    }
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    if (!response.ok) throw Object.assign(new Error(`GitLab status lookup failed (${response.status}): ${safeProviderMessage(body, response.statusText || "request failed")}`), { statusCode: 502 });
    const root = object(body);
    const data = object(root?.data);
    const connection = object(data?.duoWorkflowWorkflows);
    const nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];
    const node = object(nodes[0]);
    if (node === undefined) throw Object.assign(new Error("GitLab status lookup returned no workflow owned by this credential"), { statusCode: 404 });
    const rawStatus = `${text(node.statusGroup) ?? ""} ${text(node.status) ?? ""} ${text(node.statusName) ?? ""}`.toUpperCase();
    const status = /FAIL|ERROR/.test(rawStatus) ? "failed" as const
      : /CANCEL|STOP/.test(rawStatus) ? "stopped" as const
        : /SUCCESS|COMPLETE|FINISH/.test(rawStatus) ? "completed" as const
          : "running" as const;
    const mergeRequests = (Array.isArray(object(node.mergeRequestLinks)?.nodes) ? object(node.mergeRequestLinks)!.nodes as unknown[] : [])
      .flatMap((link) => {
        const mergeRequest = object(object(link)?.mergeRequest);
        const url = text(mergeRequest?.webUrl);
        return url === undefined ? [] : [{ url, title: text(mergeRequest?.title) ?? url }];
      });
    // The flow's last message is what it concluded; GitLab's summary field is usually empty.
    const lastMessage = text(object(object(node.latestCheckpoint)?.lastDuoMessage)?.content);
    const resultMessage = text(node.summary) ?? lastMessage;
    return this.repository.recordInvestigationStatus(tenantId, investigationId, {
      status,
      ...(text(node.webUrl) === undefined ? {} : { webUrl: text(node.webUrl) }),
      progress: {
        source: "gitlab-graphql", status: node.status ?? null, statusName: node.statusName ?? null,
        statusGroup: node.statusGroup ?? null, updatedAt: node.updatedAt ?? null,
        catalogVersionId: node.aiCatalogItemVersionId ?? null, mergeRequests,
      },
      ...(resultMessage === undefined || status === "running" ? {} : { resultMessage }),
    });
  }

  private async callGitLab(
    integration: StoredIntegration,
    config: GitLabInvestigationConfig,
    counterexample: CounterexampleRecord,
    clientReference: string,
  ): Promise<{ workflowId: string; webUrl?: string; progress?: unknown }> {
    const token = this.token(integration);
    if (token === undefined) throw new GitLabLaunchError("The GitLab flow connection has no access token", false);
    const envelope = counterexampleEnvelope(counterexample, config);
    const content = JSON.stringify(envelope);
    if (Buffer.byteLength(content) > 12_000) throw new GitLabLaunchError("Counterexample exceeds the 12 KB limit for flow instructions", false);
    const payload: Record<string, unknown> = {
      project_id: config.projectId,
      ai_catalog_item_consumer_id: config.consumerId,
      goal: config.goal === undefined
        ? `Investigate Needl violation ${counterexample.id}. Return evidence, confidence, explicit unknowns, and a proposed GitLab issue or draft-MR plan. Do not merge, deploy, or modify external providers.\n\nThe violation record (also attached as needl_counterexample context, which some flows do not receive):\n${content}`
        : `${config.goal}\n\nNeedl violation ${counterexample.id}. The violation record (also attached as needl_counterexample context, which some flows do not receive):\n${content}`,
      start_workflow: true,
      allow_agent_to_request_user: false,
      additional_context: [{ Category: "needl_counterexample", Content: content }],
      client_reference: clientReference,
      ...(config.callbackHookId === undefined ? {} : { callback_hook_id: config.callbackHookId }),
      ...(config.sourceBranch === undefined ? {} : { source_branch: config.sourceBranch }),
      ...(config.mergeRequestIid === undefined ? {} : { merge_request_id: config.mergeRequestIid }),
      ...(config.issueIid === undefined ? {} : { issue_id: config.issueIid }),
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    headers[config.tokenType === "bearer" ? "authorization" : "private-token"] = config.tokenType === "bearer" ? `Bearer ${token}` : token;
    let response: Response;
    try {
      response = await this.fetcher(`${config.baseUrl}/api/v4/ai/duo_workflows/workflows`, {
        method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GitLabLaunchError("GitLab launch outcome is unknown after a timeout or network failure; Needl will not retry automatically", true);
    }
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    if (response.status !== 201) {
      throw new GitLabLaunchError(`GitLab rejected the launch (${response.status}): ${safeProviderMessage(body, response.statusText || "request failed")}`, false);
    }
    const responseObject = object(body);
    const rawId = responseObject?.id;
    const workflowId = typeof rawId === "number" && Number.isSafeInteger(rawId) ? String(rawId) : text(rawId);
    if (workflowId === undefined) throw new GitLabLaunchError("GitLab accepted the launch but returned no workflow id; launch state is ambiguous", true);
    const webUrl = text(responseObject?.web_url);
    return {
      workflowId,
      ...(webUrl === undefined ? {} : { webUrl }),
      progress: { status: text(responseObject?.status) ?? "accepted", catalogVersionId: responseObject?.ai_catalog_item_version_id ?? null },
    };
  }
}

export class GitLabCallbackService {
  constructor(private readonly repository: NeedlRepository, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async receive(integrationId: string, rawBody: Uint8Array, headers: Readonly<Record<string, string | readonly string[] | undefined>>, receivedAt = new Date()) {
    const integration = await this.repository.getIntegration(integrationId);
    const config = investigationConfig(integration);
    if (!integration.enabled || integration.config.purpose !== "investigation" || config.callbackSecretEnvName === undefined) {
      throw Object.assign(new Error("GitLab callback route is not enabled"), { statusCode: 404 });
    }
    const secret = this.environment[config.callbackSecretEnvName];
    if (secret === undefined || !secret.startsWith("whsec_")) throw Object.assign(new Error("GitLab callback signing credential is not configured"), { statusCode: 503 });
    const header = (name: string): string | undefined => {
      const value = headers[name] ?? headers[name.toLowerCase()];
      return typeof value === "string" ? value : value?.[0];
    };
    const messageId = header("webhook-id");
    const timestamp = header("webhook-timestamp");
    const signatures = header("webhook-signature");
    const seconds = Number(timestamp);
    if (messageId === undefined || timestamp === undefined || signatures === undefined || !Number.isFinite(seconds)) {
      throw Object.assign(new Error("Missing GitLab callback signature headers"), { statusCode: 401 });
    }
    if (Math.abs(receivedAt.getTime() / 1_000 - seconds) > 300) throw Object.assign(new Error("GitLab callback timestamp is stale"), { statusCode: 401 });
    const key = Buffer.from(secret.slice(6), "base64");
    if (key.length === 0) throw Object.assign(new Error("GitLab callback signing credential is invalid"), { statusCode: 503 });
    const signed = Buffer.concat([Buffer.from(`${messageId}.${timestamp}.`), Buffer.from(rawBody)]);
    const expected = `v1,${hmac("sha256", key, signed, "base64")}`;
    let valid = false;
    for (const signature of signatures.split(" ")) valid = secureEqual(expected, signature) || valid;
    if (!valid) throw Object.assign(new Error("Invalid GitLab callback signature"), { statusCode: 401 });

    let payload: Record<string, unknown>;
    try { payload = object(JSON.parse(Buffer.from(rawBody).toString("utf8"))) ?? {}; }
    catch { throw Object.assign(new Error("GitLab callback body is malformed"), { statusCode: 400 }); }
    const eventId = text(payload.event_id) ?? messageId;
    const eventType = text(payload.event_type);
    const workflow = object(payload.workflow);
    const clientReference = text(payload.client_reference) ?? text(workflow?.client_reference);
    if (!(["flow.started", "flow.progress", "flow.completed", "flow.failed"] as const).includes(eventType as never) || clientReference === undefined) {
      throw Object.assign(new Error("GitLab callback is missing a supported event_type or client_reference"), { statusCode: 400 });
    }
    const result = object(payload.result);
    const error = object(payload.error);
    return this.repository.applyInvestigationCallback({
      tenantId: integration.tenantId,
      integrationId,
      eventId,
      clientReference,
      eventType: eventType as "flow.started" | "flow.progress" | "flow.completed" | "flow.failed",
      ...(text(workflow?.id) === undefined ? {} : { workflowId: text(workflow?.id) }),
      ...(payload.progress === undefined ? {} : { progress: payload.progress }),
      ...(text(result?.message) === undefined && text(error?.message) === undefined ? {} : { resultMessage: text(result?.message) ?? text(error?.message) }),
    });
  }
}
