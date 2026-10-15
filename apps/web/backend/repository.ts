import { randomUUID } from "node:crypto";
import type { Transaction } from "kysely";
import type { NormalizedEvent } from "../../../src/core/types.js";
import type { DeduplicatingEventSink, DeduplicationScope } from "../../../src/receiver/types.js";
import type { DemoReplay, AssertionDraft } from "../src/domain.js";
import { validateProductAssertionCollection } from "../src/collection.js";
import type { DatabaseRuntime, NeedlDatabase } from "./database.js";

export class StaleAssertionError extends Error {
  constructor() { super("Assertion changed in another session; reload before saving"); }
}

export class QuotaExceededError extends Error {
  constructor() { super("Daily translation quota reached"); }
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
    return this.db.transaction().execute((transaction) => this.storeEvent(transaction, scope.tenantId, event, scope.deliveryId));
  }

  private async storeEvent(transaction: Transaction<NeedlDatabase>, tenantId: string, event: NormalizedEvent, deliveryId: string): Promise<"stored" | "duplicate"> {
    const result = await transaction.insertInto("monitorEvents").values({ tenantId, eventId: event.id, provider: event.provider, deliveryId, eventJson: JSON.stringify(event), occurredAt: event.occurredAt ?? null, receivedAt: event.receivedAt }).onConflict((conflict) => conflict.columns(["tenantId", "provider", "deliveryId"]).doNothing()).executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) > 0 ? "stored" : "duplicate";
  }

  async loadMonitorSnapshot(tenantId: string) {
    const [events, checkpoints, counterexamples, outbox] = await Promise.all([
      this.db.selectFrom("monitorEvents").select("eventJson").where("tenantId", "=", tenantId).orderBy("receivedAt").execute(),
      this.db.selectFrom("monitorState").select("checkpointJson").where("tenantId", "=", tenantId).execute(),
      this.db.selectFrom("counterexamples").select("recordJson").where("tenantId", "=", tenantId).execute(),
      this.db.selectFrom("outbox").select("payloadJson").where("tenantId", "=", tenantId).execute(),
    ]);
    return { events: events.map((row) => JSON.parse(row.eventJson)), checkpoints: checkpoints.map((row) => JSON.parse(row.checkpointJson)), counterexamples: counterexamples.map((row) => JSON.parse(row.recordJson)), outbox: outbox.map((row) => JSON.parse(row.payloadJson)) };
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
}
