import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createDatabaseRuntime, migrateApplicationDatabase, type DatabaseRuntime } from "./database.js";
import { NeedlRepository } from "./repository.js";
import { SecretBox } from "./secrets.js";
import { createTestDatabase, dropTestDatabases } from "./test-database.js";

const runtimes: DatabaseRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); });
afterAll(async () => { await dropTestDatabases(); });

const key = () => randomBytes(32).toString("base64");

describe("secret key rotation", () => {
  it("opens secrets sealed with either key and seals new ones with the next key", () => {
    const current = key();
    const next = key();
    const old = SecretBox.fromEnvironment({ NODE_ENV: "production", NEEDL_SECRET_KEY: current });
    const rotating = SecretBox.fromEnvironment({ NODE_ENV: "production", NEEDL_SECRET_KEY: current, NEEDL_SECRET_KEY_NEXT: next });
    const after = SecretBox.fromEnvironment({ NODE_ENV: "production", NEEDL_SECRET_KEY: next });
    const sealedOld = old.seal("whsec_old");
    expect(old.rotating).toBe(false);
    expect(rotating.rotating).toBe(true);
    expect(rotating.open(sealedOld)).toBe("whsec_old");
    expect(rotating.isCurrent(sealedOld)).toBe(false);
    const sealedNew = rotating.seal("whsec_new");
    expect(after.open(sealedNew)).toBe("whsec_new");
    expect(() => after.open(sealedOld)).toThrow();
  });

  it("moves every stored secret to the next key, leaving none behind", async () => {
    const path = await createTestDatabase();
    const runtime = createDatabaseRuntime({ NODE_ENV: "test", DATABASE_URL: path });
    runtimes.push(runtime);
    await migrateApplicationDatabase(runtime);
    const repository = new NeedlRepository(runtime);
    const current = key();
    const next = key();
    const old = SecretBox.fromEnvironment({ NODE_ENV: "production", NEEDL_SECRET_KEY: current });
    const tenantId = await repository.tenantForUser("rotation-user");
    const ids: string[] = [];
    for (const provider of ["stripe", "linear"]) {
      const connection = await repository.createConnection(tenantId, provider, { purpose: "ingestion" });
      ids.push(connection.id);
      await repository.saveConnectionSecret(tenantId, connection.id, old.seal(`secret-${provider}`), {});
    }
    const rotating = SecretBox.fromEnvironment({ NODE_ENV: "production", NEEDL_SECRET_KEY: current, NEEDL_SECRET_KEY_NEXT: next });
    expect(await repository.resealSecrets(rotating)).toEqual({ resealed: 2, unreadable: 0 });
    expect(await repository.resealSecrets(rotating)).toEqual({ resealed: 0, unreadable: 0 });

    const after = SecretBox.fromEnvironment({ NODE_ENV: "production", NEEDL_SECRET_KEY: next });
    const stored = (await Promise.all(ids.map((id) => repository.getIntegration(id)))).map((integration) => after.open(integration.secretCiphertext!)).sort();
    expect(stored).toEqual(["secret-linear", "secret-stripe"]);
  });
});
