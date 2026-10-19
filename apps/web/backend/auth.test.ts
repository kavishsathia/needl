import { betterAuth } from "better-auth";
import { sql } from "kysely";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createAuthOptions, migrateAuthDatabase, signupEnabled } from "./auth.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "./database.js";
import { createTestDatabase, dropTestDatabases } from "./test-database.js";

const runtimes: DatabaseRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); });
afterAll(async () => { await dropTestDatabases(); });

describe("production signup policy", () => {
  it("is closed by default and opens only for an explicit email allowlist", () => {
    expect(signupEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(signupEnabled({ NODE_ENV: "production", NEEDL_SIGNUP_ALLOWLIST: "approved@needl.test" })).toBe(true);
    expect(signupEnabled({ NODE_ENV: "test" })).toBe(true);
  });
});

describe("auth schema migrations", () => {
  it("re-runs cleanly on a populated database and keeps snake_case columns", async () => {
    const environment = { NODE_ENV: "test", DATABASE_URL: await createTestDatabase() };
    const first = createDatabaseRuntime(environment);
    runtimes.push(first);
    const options = createAuthOptions(first, environment);
    await migrateAuthDatabase(options);
    await betterAuth(options).api.signUpEmail({ body: { email: "restart@needl.test", password: "restart-password-1", name: "Restart" } });
    await first.close();
    runtimes.splice(runtimes.indexOf(first), 1);

    // A restart runs the same migration against the populated tables.
    const second = createDatabaseRuntime(environment);
    runtimes.push(second);
    const restartedOptions = createAuthOptions(second, environment);
    await expect(migrateAuthDatabase(restartedOptions)).resolves.toBeUndefined();
    const columns = await sql<{ name: string }>`select column_name as name from information_schema.columns where table_name = 'user' order by ordinal_position`.execute(second.db.withoutPlugins());
    expect(columns.rows.map((row) => row.name)).toEqual(["id", "name", "email", "email_verified", "image", "created_at", "updated_at"]);
    const signIn = await betterAuth(restartedOptions).api.signInEmail({ body: { email: "restart@needl.test", password: "restart-password-1" } });
    expect(signIn.user.email).toBe("restart@needl.test");
  });
});
