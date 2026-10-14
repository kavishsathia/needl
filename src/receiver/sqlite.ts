import { DatabaseSync } from "node:sqlite";
import type { NormalizedEvent, Provider } from "../core/types.js";
import type { DeduplicatingEventSink, DeduplicationScope } from "./types.js";

export interface ReplayQuery {
  readonly tenantId?: string;
  readonly provider?: Provider;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface StoredEvent {
  readonly sequence: number;
  readonly event: NormalizedEvent;
}

interface EventRow {
  sequence: number;
  event_json: string;
}

export class SqliteEventStore implements DeduplicatingEventSink {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        occurred_at TEXT,
        received_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        event_json TEXT NOT NULL,
        UNIQUE (tenant_id, provider, delivery_id)
      )
    `);
  }

  async store(event: NormalizedEvent, scope: DeduplicationScope): Promise<"stored" | "duplicate"> {
    if (
      scope.tenantId !== event.tenantId
      || scope.provider !== event.provider
      || scope.deliveryId !== (event.deliveryId ?? event.id)
    ) {
      throw new Error("Deduplication scope does not match event identity");
    }
    const statement = this.#database.prepare(`
      INSERT OR IGNORE INTO webhook_events
        (tenant_id, provider, delivery_id, event_id, occurred_at, received_at, kind, event_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = statement.run(
      scope.tenantId,
      scope.provider,
      scope.deliveryId,
      event.id,
      event.occurredAt ?? null,
      event.receivedAt,
      event.kind,
      JSON.stringify(event),
    );
    return result.changes === 1 ? "stored" : "duplicate";
  }

  count(): number {
    const row = this.#database.prepare("SELECT COUNT(*) AS count FROM webhook_events").get() as { count: number };
    return row.count;
  }

  list(query: ReplayQuery = {}): StoredEvent[] {
    const conditions: string[] = ["sequence > ?"];
    const parameters: (string | number)[] = [query.afterSequence ?? 0];
    if (query.tenantId !== undefined) {
      conditions.push("tenant_id = ?");
      parameters.push(query.tenantId);
    }
    if (query.provider !== undefined) {
      conditions.push("provider = ?");
      parameters.push(query.provider);
    }
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1_000);
    parameters.push(limit);
    const rows = this.#database
      .prepare(`SELECT sequence, event_json FROM webhook_events WHERE ${conditions.join(" AND ")} ORDER BY sequence ASC LIMIT ?`)
      .all(...parameters) as unknown as EventRow[];
    return rows.map((row) => ({ sequence: row.sequence, event: JSON.parse(row.event_json) as NormalizedEvent }));
  }

  async replay(query: ReplayQuery, consumer: (stored: StoredEvent) => Promise<void>): Promise<number> {
    const events = this.list(query);
    for (const event of events) await consumer(event);
    return events.length;
  }

  close(): void {
    this.#database.close();
  }
}
