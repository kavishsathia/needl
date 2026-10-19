import { randomBytes } from "node:crypto";
import { Client } from "pg";

// Tests get their own throwaway database on a local Postgres server.
const adminUrl = process.env.NEEDL_TEST_DATABASE_URL ?? "postgres://localhost:5432/postgres";
const created: string[] = [];

async function admin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

/** Creates an empty database and returns its connection string. */
export async function createTestDatabase(): Promise<string> {
  const name = `needl_test_${randomBytes(6).toString("hex")}`;
  await admin((client) => client.query(`CREATE DATABASE ${name}`));
  created.push(name);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Drops every database this test file created. Call from afterAll. */
export async function dropTestDatabases(): Promise<void> {
  const names = created.splice(0);
  if (names.length === 0) return;
  await admin(async (client) => {
    for (const name of names) await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
}
