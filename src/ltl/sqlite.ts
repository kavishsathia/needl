import { DatabaseSync } from "node:sqlite";
import type {
  CounterexampleRecord,
  MonitorCheckpoint,
  MonitorCommit,
  MonitorOutboxItem,
  MonitorStore,
  MonitorTraceItem,
  OutboxAttempt,
} from "./runtime-types.js";

interface JsonRow { readonly json: string }
interface RevisionRow { readonly revision: number }

export class SqliteMonitorStore implements MonitorStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS monitor_checkpoints (
        instance_key TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        assertion_id TEXT NOT NULL,
        assertion_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        checkpoint_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS monitor_inputs (
        instance_key TEXT NOT NULL,
        input_id TEXT NOT NULL,
        PRIMARY KEY (instance_key, input_id)
      );
      CREATE TABLE IF NOT EXISTS monitor_trace (
        instance_key TEXT NOT NULL,
        position INTEGER NOT NULL,
        input_id TEXT NOT NULL,
        item_json TEXT NOT NULL,
        PRIMARY KEY (instance_key, position),
        UNIQUE (instance_key, input_id)
      );
      CREATE TABLE IF NOT EXISTS monitor_violations (
        violation_id TEXT PRIMARY KEY,
        instance_key TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        violation_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS monitor_outbox (
        outbox_id TEXT PRIMARY KEY,
        violation_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        item_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS monitor_checkpoint_assertion
        ON monitor_checkpoints (tenant_id, assertion_id, assertion_version);
      CREATE INDEX IF NOT EXISTS monitor_violation_instance
        ON monitor_violations (instance_key, detected_at);
      CREATE INDEX IF NOT EXISTS monitor_outbox_status
        ON monitor_outbox (status, created_at);
    `);
  }

  async loadCheckpoint(key: string): Promise<MonitorCheckpoint | undefined> {
    const row = this.#database.prepare(
      "SELECT checkpoint_json AS json FROM monitor_checkpoints WHERE instance_key = ?",
    ).get(key) as JsonRow | undefined;
    return row === undefined ? undefined : JSON.parse(row.json) as MonitorCheckpoint;
  }

  async hasProcessedInput(key: string, inputId: string): Promise<boolean> {
    return this.#database.prepare(
      "SELECT 1 AS found FROM monitor_inputs WHERE instance_key = ? AND input_id = ?",
    ).get(key, inputId) !== undefined;
  }

  async loadTrace(key: string): Promise<readonly MonitorTraceItem[]> {
    const rows = this.#database.prepare(
      "SELECT item_json AS json FROM monitor_trace WHERE instance_key = ? ORDER BY position ASC",
    ).all(key) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.json) as MonitorTraceItem);
  }

  async commit(request: MonitorCommit): Promise<"committed" | "duplicate" | "conflict"> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.#database.prepare(
        "SELECT 1 AS found FROM monitor_inputs WHERE instance_key = ? AND input_id = ?",
      ).get(request.instance.key, request.inputId);
      if (duplicate !== undefined) {
        this.#database.exec("COMMIT");
        return "duplicate";
      }
      const current = this.#database.prepare(
        "SELECT revision FROM monitor_checkpoints WHERE instance_key = ?",
      ).get(request.instance.key) as RevisionRow | undefined;
      if ((current?.revision ?? 0) !== request.expectedRevision) {
        this.#database.exec("COMMIT");
        return "conflict";
      }
      this.#database.prepare(
        "INSERT INTO monitor_inputs (instance_key, input_id) VALUES (?, ?)",
      ).run(request.instance.key, request.inputId);
      this.#database.prepare(`
        INSERT INTO monitor_trace (instance_key, position, input_id, item_json)
        VALUES (?, ?, ?, ?)
      `).run(
        request.instance.key,
        request.traceItem.position,
        request.traceItem.inputId,
        JSON.stringify(request.traceItem),
      );
      this.#database.prepare(`
        INSERT INTO monitor_checkpoints
          (instance_key, tenant_id, assertion_id, assertion_version, revision, checkpoint_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_key) DO UPDATE SET
          revision = excluded.revision,
          checkpoint_json = excluded.checkpoint_json
      `).run(
        request.instance.key,
        request.instance.tenantId,
        request.instance.assertionId,
        request.instance.assertionVersion,
        request.checkpoint.revision,
        JSON.stringify(request.checkpoint),
      );
      const insertViolation = this.#database.prepare(`
        INSERT OR IGNORE INTO monitor_violations
          (violation_id, instance_key, detected_at, violation_json)
        VALUES (?, ?, ?, ?)
      `);
      for (const record of request.violations) {
        insertViolation.run(record.id, record.key, record.detectedAt, JSON.stringify(record));
      }
      const insertOutbox = this.#database.prepare(`
        INSERT OR IGNORE INTO monitor_outbox
          (outbox_id, violation_id, status, created_at, item_json)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const item of request.outbox) {
        insertOutbox.run(item.id, item.violationId, item.status, item.createdAt, JSON.stringify(item));
      }
      this.#database.exec("COMMIT");
      return "committed";
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async listCheckpoints(): Promise<readonly MonitorCheckpoint[]> {
    const rows = this.#database.prepare(
      "SELECT checkpoint_json AS json FROM monitor_checkpoints ORDER BY tenant_id, assertion_id, assertion_version, instance_key",
    ).all() as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.json) as MonitorCheckpoint);
  }

  async listViolations(): Promise<readonly CounterexampleRecord[]> {
    const rows = this.#database.prepare(
      "SELECT violation_json AS json FROM monitor_violations ORDER BY detected_at, violation_id",
    ).all() as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.json) as CounterexampleRecord);
  }

  async listOutbox(status?: MonitorOutboxItem["status"]): Promise<readonly MonitorOutboxItem[]> {
    const rows = status === undefined
      ? this.#database.prepare("SELECT item_json AS json FROM monitor_outbox ORDER BY created_at, outbox_id").all()
      : this.#database.prepare("SELECT item_json AS json FROM monitor_outbox WHERE status = ? ORDER BY created_at, outbox_id").all(status);
    return (rows as unknown as JsonRow[]).map((row) => JSON.parse(row.json) as MonitorOutboxItem);
  }

  async recordOutboxAttempt(id: string, attempt: OutboxAttempt): Promise<void> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare(
        "SELECT item_json AS json FROM monitor_outbox WHERE outbox_id = ?",
      ).get(id) as JsonRow | undefined;
      if (row === undefined) throw new Error(`Unknown outbox item ${id}`);
      const current = JSON.parse(row.json) as MonitorOutboxItem;
      const { lastError: _lastError, ...withoutLastError } = current;
      const updated: MonitorOutboxItem = {
        ...withoutLastError,
        status: attempt.success ? "dispatched" : "failed",
        attempts: current.attempts + 1,
        lastAttemptAt: attempt.at,
        ...(attempt.error === undefined ? {} : { lastError: attempt.error }),
      };
      this.#database.prepare(
        "UPDATE monitor_outbox SET status = ?, item_json = ? WHERE outbox_id = ?",
      ).run(updated.status, JSON.stringify(updated), id);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }
}
