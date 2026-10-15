import type { Transaction } from "kysely";
import type {
  CounterexampleRecord,
  MonitorCheckpoint,
  MonitorCommit,
  MonitorOutboxItem,
  MonitorStore,
  MonitorTraceItem,
  OutboxAttempt,
} from "../../../src/ltl/runtime-types.js";
import type { DatabaseRuntime, NeedlDatabase } from "./database.js";

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

export class LiveMonitorStore implements MonitorStore {
  constructor(private readonly runtime: DatabaseRuntime, private readonly tenantId: string) {}

  async loadCheckpoint(key: string): Promise<MonitorCheckpoint | undefined> {
    const row = await this.runtime.db.selectFrom("liveMonitorState").select("checkpointJson")
      .where("tenantId", "=", this.tenantId).where("instanceKey", "=", key).executeTakeFirst();
    return row === undefined ? undefined : parse<MonitorCheckpoint>(row.checkpointJson);
  }

  async hasProcessedInput(key: string, inputId: string): Promise<boolean> {
    const row = await this.runtime.db.selectFrom("liveMonitorInputs").select("inputId")
      .where("tenantId", "=", this.tenantId).where("instanceKey", "=", key).where("inputId", "=", inputId).executeTakeFirst();
    return row !== undefined;
  }

  async loadTrace(key: string): Promise<readonly MonitorTraceItem[]> {
    const rows = await this.runtime.db.selectFrom("liveMonitorTrace").select("traceJson")
      .where("tenantId", "=", this.tenantId).where("instanceKey", "=", key).orderBy("position").execute();
    return rows.map((row) => parse<MonitorTraceItem>(row.traceJson));
  }

  async commit(request: MonitorCommit): Promise<"committed" | "duplicate" | "conflict"> {
    if (request.instance.tenantId !== this.tenantId || request.checkpoint.tenantId !== this.tenantId) {
      throw new Error("Monitor commit tenant does not match its store");
    }
    return this.runtime.db.transaction().execute(async (transaction) => {
      const duplicate = await transaction.selectFrom("liveMonitorInputs").select("inputId")
        .where("tenantId", "=", this.tenantId).where("instanceKey", "=", request.instance.key)
        .where("inputId", "=", request.inputId).executeTakeFirst();
      if (duplicate !== undefined) return "duplicate";

      const now = request.traceItem.at;
      if (request.expectedRevision === 0) {
        const inserted = await transaction.insertInto("liveMonitorState").values({
          tenantId: this.tenantId,
          instanceKey: request.instance.key,
          assertionId: request.instance.assertionId,
          assertionVersion: request.instance.assertionVersion,
          checkpointJson: JSON.stringify(request.checkpoint),
          revision: request.checkpoint.revision,
          updatedAt: now,
        }).onConflict((conflict) => conflict.columns(["tenantId", "instanceKey"]).doNothing()).executeTakeFirst();
        if (Number(inserted.numInsertedOrUpdatedRows ?? 0) !== 1) return "conflict";
      } else {
        const updated = await transaction.updateTable("liveMonitorState").set({
          checkpointJson: JSON.stringify(request.checkpoint),
          revision: request.checkpoint.revision,
          updatedAt: now,
        }).where("tenantId", "=", this.tenantId).where("instanceKey", "=", request.instance.key)
          .where("revision", "=", request.expectedRevision).executeTakeFirst();
        if (Number(updated.numUpdatedRows) !== 1) return "conflict";
      }

      await transaction.insertInto("liveMonitorTrace").values({
        tenantId: this.tenantId,
        instanceKey: request.instance.key,
        position: request.traceItem.position,
        traceJson: JSON.stringify(request.traceItem),
        createdAt: now,
      }).execute();
      for (const record of request.violations) await this.insertCounterexample(transaction, record);
      for (const item of request.outbox) await this.insertOutbox(transaction, item);
      await transaction.insertInto("liveMonitorInputs").values({
        tenantId: this.tenantId,
        instanceKey: request.instance.key,
        inputId: request.inputId,
        processedAt: now,
      }).execute();
      return "committed";
    });
  }

  private async insertCounterexample(transaction: Transaction<NeedlDatabase>, record: CounterexampleRecord): Promise<void> {
    await transaction.insertInto("counterexamples").values({
      tenantId: this.tenantId,
      counterexampleId: record.id,
      assertionId: record.assertionId,
      assertionVersion: record.assertionVersion,
      recordJson: JSON.stringify(record),
      detectedAt: record.detectedAt,
    }).onConflict((conflict) => conflict.columns(["tenantId", "counterexampleId"]).doNothing()).execute();
  }

  private async insertOutbox(transaction: Transaction<NeedlDatabase>, item: MonitorOutboxItem): Promise<void> {
    await transaction.insertInto("outbox").values({
      tenantId: this.tenantId,
      outboxId: item.id,
      assertionId: item.assertionId,
      assertionVersion: item.assertionVersion,
      counterexampleId: item.violationId,
      payloadJson: JSON.stringify(item),
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
    }).onConflict((conflict) => conflict.columns(["tenantId", "counterexampleId", "assertionVersion"]).doNothing()).execute();
  }

  async listCheckpoints(): Promise<readonly MonitorCheckpoint[]> {
    const rows = await this.runtime.db.selectFrom("liveMonitorState").select("checkpointJson")
      .where("tenantId", "=", this.tenantId).execute();
    return rows.map((row) => parse<MonitorCheckpoint>(row.checkpointJson));
  }

  async listViolations(): Promise<readonly CounterexampleRecord[]> {
    const rows = await this.runtime.db.selectFrom("counterexamples").select("recordJson")
      .where("tenantId", "=", this.tenantId).orderBy("detectedAt").execute();
    return rows.map((row) => parse<CounterexampleRecord>(row.recordJson));
  }

  async listOutbox(status?: MonitorOutboxItem["status"]): Promise<readonly MonitorOutboxItem[]> {
    let query = this.runtime.db.selectFrom("outbox").select("payloadJson").where("tenantId", "=", this.tenantId);
    if (status !== undefined) query = query.where("status", "=", status);
    const rows = await query.orderBy("createdAt").execute();
    return rows.map((row) => parse<MonitorOutboxItem>(row.payloadJson));
  }

  async recordOutboxAttempt(id: string, attempt: OutboxAttempt): Promise<void> {
    await this.runtime.db.transaction().execute(async (transaction) => {
      const row = await transaction.selectFrom("outbox").select(["payloadJson", "status"])
        .where("tenantId", "=", this.tenantId).where("outboxId", "=", id).executeTakeFirst();
      if (row === undefined) throw new Error("Outbox item was not found in this workspace");
      const current = parse<MonitorOutboxItem>(row.payloadJson);
      const next: MonitorOutboxItem = {
        ...current,
        attempts: current.attempts + 1,
        lastAttemptAt: attempt.at,
        ...(attempt.success ? { status: "dispatched" as const } : { status: "failed" as const, lastError: attempt.error ?? "Dispatch failed" }),
      };
      await transaction.updateTable("outbox").set({ payloadJson: JSON.stringify(next), status: next.status, updatedAt: attempt.at })
        .where("tenantId", "=", this.tenantId).where("outboxId", "=", id).execute();
    });
  }
}
