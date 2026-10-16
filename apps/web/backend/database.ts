import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { CamelCasePlugin, Kysely, PostgresDialect, SqliteDialect, sql } from "kysely";
import { Pool } from "pg";

export interface NeedlDatabase {
  readonly user: unknown;
  readonly session: unknown;
  readonly account: unknown;
  readonly verification: unknown;
  readonly tenants: {
    id: string;
    userId: string;
    name: string;
    createdAt: string;
  };
  readonly assertions: {
    tenantId: string;
    assertionId: string;
    version: number;
    expectation: string;
    status: string;
    definitionJson: string;
    draftJson: string;
    createdAt: string;
    updatedAt: string;
  };
  readonly assertionVersions: {
    tenantId: string;
    assertionId: string;
    version: number;
    draftJson: string;
    createdAt: string;
  };
  readonly monitorEvents: {
    tenantId: string;
    eventId: string;
    provider: string;
    deliveryId: string;
    eventJson: string;
    occurredAt: string | null;
    receivedAt: string;
  };
  readonly monitorState: {
    tenantId: string;
    assertionId: string;
    assertionVersion: number;
    checkpointJson: string;
    updatedAt: string;
  };
  readonly liveMonitorState: {
    tenantId: string;
    instanceKey: string;
    assertionId: string;
    assertionVersion: number;
    checkpointJson: string;
    revision: number;
    updatedAt: string;
    /** When a clock tick can next change this monitor (an open time window ends); null when none is pending. */
    nextDueAt: string | null;
  };
  readonly liveMonitorTrace: {
    tenantId: string;
    instanceKey: string;
    position: number;
    traceJson: string;
    createdAt: string;
  };
  readonly liveMonitorInputs: {
    tenantId: string;
    instanceKey: string;
    inputId: string;
    processedAt: string;
  };
  readonly counterexamples: {
    tenantId: string;
    counterexampleId: string;
    assertionId: string;
    assertionVersion: number;
    recordJson: string;
    detectedAt: string;
  };
  readonly outbox: {
    tenantId: string;
    outboxId: string;
    assertionId: string;
    assertionVersion: number;
    counterexampleId: string;
    payloadJson: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  readonly translationProposals: {
    id: string;
    tenantId: string;
    inputText: string;
    proposalJson: string;
    model: string;
    status: string;
    createdAt: string;
    confirmedAt: string | null;
  };
  readonly translationUsage: {
    tenantId: string;
    usageDay: string;
    requestCount: number;
  };
  readonly integrationConfigs: {
    id: string;
    tenantId: string;
    provider: string;
    configJson: string;
    secretEnvName: string;
    /** Signing secret saved through the app, sealed with NEEDL_SECRET_KEY; null when it lives in an environment variable. */
    secretCiphertext: string | null;
    /** Latest webhook delivery to this route, for setup feedback. */
    lastAttemptAt: string | null;
    lastOutcome: string | null;
    lastDetail: string | null;
    lastReceivedAt: string | null;
    enabled: number;
    createdAt: string;
    updatedAt: string;
  };
  readonly investigations: {
    tenantId: string;
    id: string;
    integrationId: string;
    violationId: string;
    assertionVersion: number;
    attempt: number;
    clientReference: string;
    workflowId: string | null;
    webUrl: string | null;
    status: string;
    lastProgressJson: string | null;
    resultMessage: string | null;
    createdAt: string;
    updatedAt: string;
  };
  readonly webhookDeliveries: {
    tenantId: string;
    integrationId: string;
    eventId: string;
    receivedAt: string;
  };
}

export interface DatabaseRuntime {
  readonly db: Kysely<NeedlDatabase>;
  readonly type: "postgres" | "sqlite";
  readonly resource: string;
  close(): Promise<void>;
}

export function createDatabaseRuntime(environment: NodeJS.ProcessEnv = process.env): DatabaseRuntime {
  const connectionString = environment.DATABASE_URL;
  if (connectionString !== undefined && connectionString.length > 0) {
    const parsed = new URL(connectionString);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("DATABASE_URL must use PostgreSQL");
    }
    const pool = new Pool({ connectionString, max: 10, ssl: parsed.hostname === "localhost" ? undefined : { rejectUnauthorized: true } });
    return {
      db: new Kysely<NeedlDatabase>({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] }),
      type: "postgres",
      resource: `${parsed.hostname}/${parsed.pathname.replace(/^\//, "")}`,
      async close() { await pool.end(); },
    };
  }
  if (environment.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production; local SQLite fallback is disabled");
  }
  const filename = resolve(environment.NEEDL_SQLITE_PATH ?? ".needl/needl.sqlite");
  mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return {
    db: new Kysely<NeedlDatabase>({ dialect: new SqliteDialect({ database: sqlite }), plugins: [new CamelCasePlugin()] }),
    type: "sqlite",
    resource: filename,
    async close() { sqlite.close(); },
  };
}

const applicationTables = [
  `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS assertions (tenant_id TEXT NOT NULL, assertion_id TEXT NOT NULL, version INTEGER NOT NULL, expectation TEXT NOT NULL, status TEXT NOT NULL, definition_json TEXT NOT NULL, draft_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, assertion_id), FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS assertion_versions (tenant_id TEXT NOT NULL, assertion_id TEXT NOT NULL, version INTEGER NOT NULL, draft_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, assertion_id, version), FOREIGN KEY (tenant_id, assertion_id) REFERENCES assertions(tenant_id, assertion_id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS monitor_events (tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, provider TEXT NOT NULL, delivery_id TEXT NOT NULL, event_json TEXT NOT NULL, occurred_at TEXT, received_at TEXT NOT NULL, PRIMARY KEY (tenant_id, event_id), UNIQUE (tenant_id, provider, delivery_id), FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS monitor_state (tenant_id TEXT NOT NULL, assertion_id TEXT NOT NULL, assertion_version INTEGER NOT NULL, checkpoint_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, assertion_id, assertion_version), FOREIGN KEY (tenant_id, assertion_id) REFERENCES assertions(tenant_id, assertion_id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS live_monitor_state (tenant_id TEXT NOT NULL, instance_key TEXT NOT NULL, assertion_id TEXT NOT NULL, assertion_version INTEGER NOT NULL, checkpoint_json TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, next_due_at TEXT, PRIMARY KEY (tenant_id, instance_key), FOREIGN KEY (tenant_id, assertion_id) REFERENCES assertions(tenant_id, assertion_id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS live_monitor_trace (tenant_id TEXT NOT NULL, instance_key TEXT NOT NULL, position INTEGER NOT NULL, trace_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, instance_key, position), FOREIGN KEY (tenant_id, instance_key) REFERENCES live_monitor_state(tenant_id, instance_key) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS live_monitor_inputs (tenant_id TEXT NOT NULL, instance_key TEXT NOT NULL, input_id TEXT NOT NULL, processed_at TEXT NOT NULL, PRIMARY KEY (tenant_id, instance_key, input_id), FOREIGN KEY (tenant_id, instance_key) REFERENCES live_monitor_state(tenant_id, instance_key) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS counterexamples (tenant_id TEXT NOT NULL, counterexample_id TEXT NOT NULL, assertion_id TEXT NOT NULL, assertion_version INTEGER NOT NULL, record_json TEXT NOT NULL, detected_at TEXT NOT NULL, PRIMARY KEY (tenant_id, counterexample_id), FOREIGN KEY (tenant_id, assertion_id) REFERENCES assertions(tenant_id, assertion_id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS outbox (tenant_id TEXT NOT NULL, outbox_id TEXT NOT NULL, assertion_id TEXT NOT NULL, assertion_version INTEGER NOT NULL, counterexample_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, outbox_id), UNIQUE (tenant_id, counterexample_id, assertion_version), FOREIGN KEY (tenant_id, counterexample_id) REFERENCES counterexamples(tenant_id, counterexample_id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS translation_proposals (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, input_text TEXT NOT NULL, proposal_json TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_at TEXT, FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS translation_usage (tenant_id TEXT NOT NULL, usage_day TEXT NOT NULL, request_count INTEGER NOT NULL, PRIMARY KEY (tenant_id, usage_day), FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS integration_configs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, provider TEXT NOT NULL, config_json TEXT NOT NULL, secret_env_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (tenant_id, provider, id), FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS investigations (tenant_id TEXT NOT NULL, id TEXT NOT NULL, integration_id TEXT NOT NULL, violation_id TEXT NOT NULL, assertion_version INTEGER NOT NULL, attempt INTEGER NOT NULL, client_reference TEXT NOT NULL, workflow_id TEXT, web_url TEXT, status TEXT NOT NULL, last_progress_json TEXT, result_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, integration_id, violation_id, assertion_version, attempt), UNIQUE (tenant_id, client_reference), FOREIGN KEY (integration_id) REFERENCES integration_configs(id))`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (tenant_id TEXT NOT NULL, integration_id TEXT NOT NULL, event_id TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY (tenant_id, integration_id, event_id), FOREIGN KEY (integration_id) REFERENCES integration_configs(id))`,
] as const;

async function addColumn(runtime: DatabaseRuntime, table: string, column: string): Promise<void> {
  if (runtime.type === "postgres") {
    await sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} TEXT`).execute(runtime.db);
    return;
  }
  const columns = await sql.raw<{ name: string }>(`PRAGMA table_info(${table})`).execute(runtime.db);
  if (!columns.rows.some((existing) => existing.name === column)) await sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`).execute(runtime.db);
}

export async function migrateApplicationDatabase(runtime: DatabaseRuntime): Promise<void> {
  for (const statement of applicationTables) await sql.raw(statement).execute(runtime.db);
  await sql`CREATE INDEX IF NOT EXISTS assertions_tenant_updated_idx ON assertions (tenant_id, updated_at)`.execute(runtime.db);
  await sql`CREATE INDEX IF NOT EXISTS events_tenant_received_idx ON monitor_events (tenant_id, received_at)`.execute(runtime.db);
  await sql`CREATE INDEX IF NOT EXISTS investigations_tenant_status_idx ON investigations (tenant_id, status)`.execute(runtime.db);
  await sql`CREATE INDEX IF NOT EXISTS live_monitor_inputs_tenant_idx ON live_monitor_inputs (tenant_id, input_id)`.execute(runtime.db);
  // Columns added after the first release; databases created earlier get them here.
  await addColumn(runtime, "live_monitor_state", "next_due_at");
  for (const column of ["secret_ciphertext", "last_attempt_at", "last_outcome", "last_detail", "last_received_at"]) {
    await addColumn(runtime, "integration_configs", column);
  }
  await sql`CREATE INDEX IF NOT EXISTS live_monitor_state_due_idx ON live_monitor_state (next_due_at)`.execute(runtime.db);
}
