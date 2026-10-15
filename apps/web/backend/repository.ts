import { randomUUID } from "node:crypto";
import type { Transaction } from "kysely";
import type { NormalizedEvent } from "../../../src/core/types.js";
import type { AssertionDefinition } from "../../../src/ltl/assertion.js";
import { RuntimeMonitor } from "../../../src/ltl/runtime.js";
import type { DeduplicatingEventSink, DeduplicationScope } from "../../../src/receiver/types.js";
import type { DemoReplay, AssertionDraft } from "../src/domain.js";
import { validateProductAssertionCollection } from "../src/collection.js";
import type { DatabaseRuntime, NeedlDatabase } from "./database.js";
import { LiveMonitorStore } from "./monitor-store.js";

export class StaleAssertionError extends Error {
  constructor() { super("Assertion changed in another session; reload before saving"); }
}

export class QuotaExceededError extends Error {
  constructor() { super("Daily translation quota reached"); }
}

export interface StoredIntegration {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly secretEnvName: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type InvestigationStatus = "queued" | "launching" | "running" | "completed" | "failed" | "stopped" | "launch_unknown" | "failed_to_start" | "callback_lost";

export interface InvestigationRecord {
  readonly id: string;
  readonly integrationId: string;
  readonly violationId: string;
  readonly assertionVersion: number;
  readonly attempt: number;
  readonly clientReference: string;
  readonly workflowId?: string;
  readonly webUrl?: string;
  readonly status: InvestigationStatus;
  readonly lastProgress?: unknown;
  readonly resultMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function integrationFromRow(row: {
  id: string; tenantId: string; provider: string; configJson: string; secretEnvName: string;
  enabled: number; createdAt: string; updatedAt: string;
}): StoredIntegration {
  return { ...row, config: JSON.parse(row.configJson) as Record<string, unknown>, enabled: row.enabled === 1 };
}

function investigationFromRow(row: {
  id: string; integrationId: string; violationId: string; assertionVersion: number; attempt: number;
  clientReference: string; workflowId: string | null; webUrl: string | null; status: string;
  lastProgressJson: string | null; resultMessage: string | null; createdAt: string; updatedAt: string;
}): InvestigationRecord {
  return {
    id: row.id, integrationId: row.integrationId, violationId: row.violationId,
    assertionVersion: row.assertionVersion, attempt: row.attempt, clientReference: row.clientReference,
    ...(row.workflowId === null ? {} : { workflowId: row.workflowId }),
    ...(row.webUrl === null ? {} : { webUrl: row.webUrl }),
    status: row.status as InvestigationStatus,
    ...(row.lastProgressJson === null ? {} : { lastProgress: JSON.parse(row.lastProgressJson) }),
    ...(row.resultMessage === null ? {} : { resultMessage: row.resultMessage }),
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export class NeedlRepository implements DeduplicatingEventSink {
  constructor(private readonly runtime: DatabaseRuntime, private readonly translationDailyLimit = 5) {}

  private get db() { return this.runtime.db; }

  async tenantForUser(userId: string, name = "My workspace"): Promise<string> {
    const existing = await this.db.selectFrom("tenants").select("id").where("userId", "=", userId).executeTakeFirst();
    if (existing !== undefined) return existing.id;
    const id = `ten_${randomUUID()}`;
    await this.db.insertInto("tenants").values({ id, userId, name, createdAt: new Date().toISOString() }).onConflict((conflict) => conflict.column("userId").doNothing()).execute();
    const created = await this.db.selectFrom("tenants").select("id").where("userId", "=", userId).executeTakeFirstOrThrow();
    return created.id;
  }

  async listAssertions(tenantId: string): Promise<AssertionDraft[]> {
    const rows = await this.db.selectFrom("assertions").select("draftJson").where("tenantId", "=", tenantId).orderBy("updatedAt", "asc").execute();
    return validateProductAssertionCollection(rows.map((row) => JSON.parse(row.draftJson)), { allowNeedsReview: true });
  }

  async saveAssertion(tenantId: string, value: unknown, expectedVersion?: number): Promise<AssertionDraft> {
    const [draft] = validateProductAssertionCollection([value], { allowNeedsReview: true });
    if (draft === undefined) throw new Error("Assertion is required");
    await this.db.transaction().execute(async (transaction) => {
      const current = await transaction.selectFrom("assertions").select(["version", "createdAt"]).where("tenantId", "=", tenantId).where("assertionId", "=", draft.localId).executeTakeFirst();
      if (expectedVersion !== undefined && current?.version !== expectedVersion) throw new StaleAssertionError();
      if (current !== undefined && draft.definition.version <= current.version && expectedVersion === undefined) throw new StaleAssertionError();
      const serialized = JSON.stringify(draft);
      await transaction.insertInto("assertions").values({
        tenantId, assertionId: draft.localId, version: draft.definition.version, expectation: draft.expectation,
        status: draft.status, definitionJson: JSON.stringify(draft.definition), draftJson: serialized,
        createdAt: current?.createdAt ?? draft.createdAt, updatedAt: draft.updatedAt,
      }).onConflict((conflict) => conflict.columns(["tenantId", "assertionId"]).doUpdateSet({
        version: draft.definition.version, expectation: draft.expectation, status: draft.status,
        definitionJson: JSON.stringify(draft.definition), draftJson: serialized, updatedAt: draft.updatedAt,
      })).execute();
      await transaction.insertInto("assertionVersions").values({ tenantId, assertionId: draft.localId, version: draft.definition.version, draftJson: serialized, createdAt: draft.updatedAt }).onConflict((conflict) => conflict.columns(["tenantId", "assertionId", "version"]).doNothing()).execute();
    });
    return draft;
  }

  async deleteAssertion(tenantId: string, assertionId: string): Promise<boolean> {
    const result = await this.db.deleteFrom("assertions").where("tenantId", "=", tenantId).where("assertionId", "=", assertionId).executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async persistReplay(tenantId: string, replay: DemoReplay): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      for (const event of replay.events) await this.storeEvent(transaction, tenantId, event, event.deliveryId ?? event.id);
      for (const checkpoint of replay.checkpoints) {
        await transaction.insertInto("monitorState").values({ tenantId, assertionId: checkpoint.assertionId, assertionVersion: checkpoint.assertionVersion, checkpointJson: JSON.stringify(checkpoint), updatedAt: replay.replayedAt }).onConflict((conflict) => conflict.columns(["tenantId", "assertionId", "assertionVersion"]).doUpdateSet({ checkpointJson: JSON.stringify(checkpoint), updatedAt: replay.replayedAt })).execute();
      }
      for (const record of replay.violations) {
        await transaction.insertInto("counterexamples").values({ tenantId, counterexampleId: record.id, assertionId: record.assertionId, assertionVersion: record.assertionVersion, recordJson: JSON.stringify(record), detectedAt: record.detectedAt }).onConflict((conflict) => conflict.columns(["tenantId", "counterexampleId"]).doNothing()).execute();
      }
      for (const item of replay.outbox) {
        await transaction.insertInto("outbox").values({ tenantId, outboxId: item.id, assertionId: item.assertionId, assertionVersion: item.assertionVersion, counterexampleId: item.violationId, payloadJson: JSON.stringify(item), status: item.status, createdAt: item.createdAt, updatedAt: item.createdAt }).onConflict((conflict) => conflict.columns(["tenantId", "counterexampleId", "assertionVersion"]).doNothing()).execute();
      }
    });
  }

  async store(event: NormalizedEvent, scope: DeduplicationScope): Promise<"stored" | "duplicate"> {
    if (event.tenantId !== scope.tenantId) throw new Error("Event tenant does not match the deduplication scope");
    await this.processLiveEvent(event);
    return this.db.transaction().execute((transaction) => this.storeEvent(transaction, scope.tenantId, event, scope.deliveryId));
  }

  private async processLiveEvent(event: NormalizedEvent): Promise<void> {
    const rows = await this.db.selectFrom("assertions").select("draftJson")
      .where("tenantId", "=", event.tenantId).where("status", "=", "monitoring").execute();
    const drafts = validateProductAssertionCollection(rows.map((row) => JSON.parse(row.draftJson)), { allowNeedsReview: false });
    if (drafts.length === 0) return;
    const definitions: AssertionDefinition[] = drafts.map((draft) => ({ ...draft.definition, tenantId: event.tenantId }));
    const monitor = new RuntimeMonitor({ store: new LiveMonitorStore(this.runtime, event.tenantId), assertions: definitions });
    await monitor.process(event);
  }

  private async storeEvent(transaction: Transaction<NeedlDatabase>, tenantId: string, event: NormalizedEvent, deliveryId: string): Promise<"stored" | "duplicate"> {
    const result = await transaction.insertInto("monitorEvents").values({ tenantId, eventId: event.id, provider: event.provider, deliveryId, eventJson: JSON.stringify(event), occurredAt: event.occurredAt ?? null, receivedAt: event.receivedAt }).onConflict((conflict) => conflict.columns(["tenantId", "provider", "deliveryId"]).doNothing()).executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) > 0 ? "stored" : "duplicate";
  }

  async loadMonitorSnapshot(tenantId: string) {
    const [events, demoCheckpoints, liveCheckpoints, counterexamples, outbox, investigations] = await Promise.all([
      this.db.selectFrom("monitorEvents").select("eventJson").where("tenantId", "=", tenantId).orderBy("receivedAt").execute(),
      this.db.selectFrom("monitorState").select("checkpointJson").where("tenantId", "=", tenantId).execute(),
      this.db.selectFrom("liveMonitorState").select("checkpointJson").where("tenantId", "=", tenantId).execute(),
      this.db.selectFrom("counterexamples").select("recordJson").where("tenantId", "=", tenantId).execute(),
      this.db.selectFrom("outbox").select("payloadJson").where("tenantId", "=", tenantId).execute(),
      this.db.selectFrom("investigations").selectAll().where("tenantId", "=", tenantId).orderBy("createdAt", "desc").execute(),
    ]);
    return {
      events: events.map((row) => JSON.parse(row.eventJson)),
      checkpoints: [...demoCheckpoints, ...liveCheckpoints].map((row) => JSON.parse(row.checkpointJson)),
      counterexamples: counterexamples.map((row) => JSON.parse(row.recordJson)),
      outbox: outbox.map((row) => JSON.parse(row.payloadJson)),
      investigations: investigations.map(investigationFromRow),
    };
  }

  async consumeTranslationQuota(tenantId: string, now = new Date()): Promise<number> {
    const day = now.toISOString().slice(0, 10);
    return this.db.transaction().execute(async (transaction) => {
      const current = await transaction.selectFrom("translationUsage").select("requestCount").where("tenantId", "=", tenantId).where("usageDay", "=", day).executeTakeFirst();
      if ((current?.requestCount ?? 0) >= this.translationDailyLimit) throw new QuotaExceededError();
      const count = (current?.requestCount ?? 0) + 1;
      await transaction.insertInto("translationUsage").values({ tenantId, usageDay: day, requestCount: count }).onConflict((conflict) => conflict.columns(["tenantId", "usageDay"]).doUpdateSet({ requestCount: count })).execute();
      return this.translationDailyLimit - count;
    });
  }

  async createTranslationProposal(tenantId: string, inputText: string, proposal: unknown, model: string): Promise<string> {
    const id = `trn_${randomUUID()}`;
    await this.db.insertInto("translationProposals").values({ id, tenantId, inputText, proposalJson: JSON.stringify(proposal), model, status: "pending", createdAt: new Date().toISOString(), confirmedAt: null }).execute();
    return id;
  }

  async confirmTranslationProposal(tenantId: string, proposalId: string): Promise<void> {
    const result = await this.db.updateTable("translationProposals").set({ status: "confirmed", confirmedAt: new Date().toISOString() }).where("id", "=", proposalId).where("tenantId", "=", tenantId).where("status", "=", "pending").executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) throw new Error("Translation proposal is missing, belongs to another workspace, or was already used");
  }

  async getTranslationProposal(tenantId: string, proposalId: string): Promise<{ inputText: string; proposal: unknown; status: string }> {
    const row = await this.db.selectFrom("translationProposals").select(["inputText", "proposalJson", "status"]).where("id", "=", proposalId).where("tenantId", "=", tenantId).executeTakeFirst();
    if (row === undefined) throw new Error("Translation proposal was not found in this workspace");
    return { inputText: row.inputText, proposal: JSON.parse(row.proposalJson), status: row.status };
  }

  async upsertIntegration(input: {
    readonly id?: string;
    readonly tenantId: string;
    readonly provider: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly secretEnvName: string;
    readonly enabled: boolean;
  }): Promise<StoredIntegration> {
    if (!/^[A-Z][A-Z0-9_]{2,100}$/.test(input.secretEnvName)) throw new Error("Integration secret reference must be an environment variable name");
    const id = input.id ?? `int_${randomUUID()}`;
    const now = new Date().toISOString();
    await this.db.insertInto("integrationConfigs").values({
      id, tenantId: input.tenantId, provider: input.provider, configJson: JSON.stringify(input.config),
      secretEnvName: input.secretEnvName, enabled: input.enabled ? 1 : 0, createdAt: now, updatedAt: now,
    }).onConflict((conflict) => conflict.column("id").doUpdateSet({
      provider: input.provider, configJson: JSON.stringify(input.config), secretEnvName: input.secretEnvName,
      enabled: input.enabled ? 1 : 0, updatedAt: now,
    })).execute();
    return this.getIntegration(id);
  }

  async getIntegration(id: string): Promise<StoredIntegration> {
    const row = await this.db.selectFrom("integrationConfigs").selectAll().where("id", "=", id).executeTakeFirst();
    if (row === undefined) throw Object.assign(new Error("Integration route was not found"), { statusCode: 404 });
    return integrationFromRow(row);
  }

  async listIntegrationSummaries(tenantId: string): Promise<readonly { id: string; provider: string; purpose: string; enabled: boolean; webhookPath?: string }[]> {
    const rows = await this.db.selectFrom("integrationConfigs").selectAll().where("tenantId", "=", tenantId).orderBy("createdAt").execute();
    return rows.map((row) => {
      const integration = integrationFromRow(row);
      const purpose = typeof integration.config.purpose === "string" ? integration.config.purpose : "ingestion";
      return {
        id: integration.id, provider: integration.provider, purpose, enabled: integration.enabled,
        ...(purpose === "ingestion" ? { webhookPath: `/api/hooks/${encodeURIComponent(integration.id)}` } : {}),
      };
    });
  }

  async findInvestigationIntegration(tenantId: string): Promise<StoredIntegration | undefined> {
    const rows = await this.db.selectFrom("integrationConfigs").selectAll()
      .where("tenantId", "=", tenantId).where("provider", "=", "gitlab").where("enabled", "=", 1).execute();
    return rows.map(integrationFromRow).find((integration) => integration.config.purpose === "investigation");
  }

  async getCounterexample(tenantId: string, violationId: string): Promise<unknown> {
    const row = await this.db.selectFrom("counterexamples").select("recordJson")
      .where("tenantId", "=", tenantId).where("counterexampleId", "=", violationId).executeTakeFirst();
    if (row === undefined) throw Object.assign(new Error("Counterexample was not found in this workspace"), { statusCode: 404 });
    return JSON.parse(row.recordJson);
  }

  async queueInvestigation(tenantId: string, integrationId: string, violationId: string, assertionVersion: number): Promise<InvestigationRecord> {
    const existing = await this.db.selectFrom("investigations").selectAll().where("tenantId", "=", tenantId)
      .where("integrationId", "=", integrationId).where("violationId", "=", violationId)
      .where("assertionVersion", "=", assertionVersion).where("attempt", "=", 1).executeTakeFirst();
    if (existing !== undefined) return investigationFromRow(existing);
    const id = `inv_${randomUUID()}`;
    const now = new Date().toISOString();
    const clientReference = `needl:${violationId}:attempt:1`.slice(0, 255);
    await this.db.insertInto("investigations").values({
      tenantId, id, integrationId, violationId, assertionVersion, attempt: 1, clientReference,
      workflowId: null, webUrl: null, status: "queued", lastProgressJson: null, resultMessage: null,
      createdAt: now, updatedAt: now,
    }).onConflict((conflict) => conflict.columns(["tenantId", "integrationId", "violationId", "assertionVersion", "attempt"]).doNothing()).execute();
    const row = await this.db.selectFrom("investigations").selectAll().where("tenantId", "=", tenantId)
      .where("integrationId", "=", integrationId).where("violationId", "=", violationId)
      .where("assertionVersion", "=", assertionVersion).where("attempt", "=", 1).executeTakeFirstOrThrow();
    return investigationFromRow(row);
  }

  async claimInvestigationLaunch(tenantId: string, id: string): Promise<boolean> {
    const result = await this.db.updateTable("investigations").set({ status: "launching", updatedAt: new Date().toISOString() })
      .where("tenantId", "=", tenantId).where("id", "=", id).where("status", "=", "queued").executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async recordInvestigationLaunch(tenantId: string, id: string, input: { workflowId: string; webUrl?: string; progress?: unknown }): Promise<InvestigationRecord> {
    const now = new Date().toISOString();
    const result = await this.db.updateTable("investigations").set({
      workflowId: input.workflowId, webUrl: input.webUrl ?? null, status: "running",
      lastProgressJson: input.progress === undefined ? null : JSON.stringify(input.progress), updatedAt: now,
    }).where("tenantId", "=", tenantId).where("id", "=", id).where("status", "=", "launching").executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) throw new Error("Investigation launch state changed before it could be recorded");
    return this.getInvestigation(tenantId, id);
  }

  async recordInvestigationLaunchFailure(tenantId: string, id: string, status: "launch_unknown" | "failed_to_start", message: string): Promise<InvestigationRecord> {
    await this.db.updateTable("investigations").set({ status, resultMessage: message.slice(0, 2_000), updatedAt: new Date().toISOString() })
      .where("tenantId", "=", tenantId).where("id", "=", id).where("status", "=", "launching").execute();
    return this.getInvestigation(tenantId, id);
  }

  async getInvestigation(tenantId: string, id: string): Promise<InvestigationRecord> {
    const row = await this.db.selectFrom("investigations").selectAll().where("tenantId", "=", tenantId).where("id", "=", id).executeTakeFirst();
    if (row === undefined) throw Object.assign(new Error("Investigation was not found in this workspace"), { statusCode: 404 });
    return investigationFromRow(row);
  }

  async applyInvestigationCallback(input: {
    readonly tenantId: string;
    readonly integrationId: string;
    readonly eventId: string;
    readonly clientReference: string;
    readonly workflowId?: string;
    readonly eventType: "flow.started" | "flow.progress" | "flow.completed" | "flow.failed";
    readonly progress?: unknown;
    readonly resultMessage?: string;
  }): Promise<"processed" | "duplicate" | "unmatched"> {
    return this.db.transaction().execute(async (transaction) => {
      const delivered = await transaction.insertInto("webhookDeliveries").values({
        tenantId: input.tenantId, integrationId: input.integrationId, eventId: input.eventId, receivedAt: new Date().toISOString(),
      }).onConflict((conflict) => conflict.columns(["tenantId", "integrationId", "eventId"]).doNothing()).executeTakeFirst();
      if (Number(delivered.numInsertedOrUpdatedRows ?? 0) !== 1) return "duplicate";
      let query = transaction.selectFrom("investigations").selectAll().where("tenantId", "=", input.tenantId)
        .where("integrationId", "=", input.integrationId).where("clientReference", "=", input.clientReference);
      const workflowId = input.workflowId;
      if (workflowId !== undefined) query = query.where((builder) => builder.or([builder("workflowId", "=", workflowId), builder("workflowId", "is", null)]));
      const row = await query.executeTakeFirst();
      if (row === undefined) return "unmatched";
      if (["completed", "failed", "stopped"].includes(row.status)) return "processed";
      const status: InvestigationStatus = input.eventType === "flow.completed" ? "completed"
        : input.eventType === "flow.failed" ? "failed" : "running";
      await transaction.updateTable("investigations").set({
        status,
        ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
        ...(input.progress === undefined ? {} : { lastProgressJson: JSON.stringify(input.progress) }),
        ...(input.resultMessage === undefined ? {} : { resultMessage: input.resultMessage.slice(0, 10_000) }),
        updatedAt: new Date().toISOString(),
      }).where("tenantId", "=", input.tenantId).where("id", "=", row.id).execute();
      return "processed";
    });
  }
}
