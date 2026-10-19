import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { encodeEvent } from "../../simulator/encoders.js";
import { connectionSettings } from "./connections.js";
import { createDatabaseRuntime, migrateApplicationDatabase, type DatabaseRuntime } from "./database.js";
import { SignedIngestionService } from "./ingestion.js";
import { NeedlRepository } from "./repository.js";
import { SecretBox } from "./secrets.js";
import { createTestDatabase, dropTestDatabases } from "./test-database.js";

const runtimes: DatabaseRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); });
afterAll(async () => { await dropTestDatabases(); });

async function setup() {
  const runtime = createDatabaseRuntime({ NODE_ENV: "test", DATABASE_URL: await createTestDatabase() });
  runtimes.push(runtime);
  await migrateApplicationDatabase(runtime);
  const repository = new NeedlRepository(runtime, 2);
  const box = new SecretBox(randomBytes(32));
  return { repository, box, tenantId: await repository.tenantForUser("connections-user"), ingestion: new SignedIngestionService(repository, {}, box) };
}

describe("SecretBox", () => {
  it("round-trips secrets and refuses tampered or foreign ciphertext", () => {
    const box = new SecretBox(randomBytes(32));
    const sealed = box.seal("whsec_example");
    expect(sealed).not.toContain("whsec_example");
    expect(box.open(sealed)).toBe("whsec_example");
    expect(() => new SecretBox(randomBytes(32)).open(sealed)).toThrow();
    const [version, iv, tag, ciphertext] = sealed.split(":");
    const flipped = Buffer.from(ciphertext!, "base64");
    flipped[0]! ^= 1;
    expect(() => box.open([version, iv, tag, flipped.toString("base64")].join(":"))).toThrow();
    expect(() => SecretBox.fromEnvironment({ NODE_ENV: "production" })).toThrow(/NEEDL_SECRET_KEY is required/);
  });
});

describe("connectionSettings", () => {
  it("catches pastes in the wrong format before any webhook arrives", () => {
    expect(() => connectionSettings("stripe", "sk_live_1234567890")).toThrow(/whsec_/);
    expect(connectionSettings("stripe", " whsec_abcdef123 ")).toEqual({ secret: "whsec_abcdef123", config: {} });
    expect(() => connectionSettings("gitlab", "plain-token-123")).toThrow(/Secret token/);
    expect(connectionSettings("gitlab", "plain-token-123", "secret-token").config).toEqual({ authMode: "secret-token" });
    expect(connectionSettings("posthog", "token-abcdef", "shared-header").config).toMatchObject({ authentication: { mode: "shared-header", prefix: "Bearer " } });
    expect(() => connectionSettings("sentry", "short")).toThrow(/full signing secret/);
    expect(() => connectionSettings("sentry", "has spaces in it")).toThrow(/without spaces/);
  });
});

describe("connections created in the app", () => {
  it("stay closed until the secret is saved, then verify deliveries with it and report each outcome", async () => {
    const { repository, box, tenantId, ingestion } = await setup();
    const created = await repository.createConnection(tenantId, "sentry", {});
    const secret = randomBytes(16).toString("hex");
    const send = async (key: string) => {
      const delivery = encodeEvent("sentry.issue", { action: "resolved" }, new Date(), key);
      return ingestion.receive(created.id, Buffer.from(delivery.body), delivery.headers);
    };

    expect((await send(secret)).statusCode).toBe(404);
    expect((await repository.listConnections(tenantId))[0]).toMatchObject({ secretSource: "none", enabled: false, lastOutcome: "no_secret" });

    await repository.saveConnectionSecret(tenantId, created.id, box.seal(secret), connectionSettings("sentry", secret).config);
    expect(await send("not-the-secret")).toMatchObject({ statusCode: 401, outcome: "rejected" });
    expect((await repository.listConnections(tenantId))[0]).toMatchObject({ secretSource: "workspace", lastOutcome: "rejected", lastDetail: "unauthenticated" });

    expect(await send(secret)).toMatchObject({ statusCode: 200, outcome: "stored" });
    const [connection] = await repository.listConnections(tenantId);
    expect(connection).toMatchObject({ enabled: true, lastOutcome: "stored", lastDetail: "issue.resolved" });
    expect(connection?.lastReceivedAt).toBeDefined();
  });

  it("are private to their workspace", async () => {
    const { repository, box, tenantId } = await setup();
    const other = await repository.tenantForUser("someone-else");
    const created = await repository.createConnection(tenantId, "linear", {});
    await expect(repository.saveConnectionSecret(other, created.id, box.seal("abcdefgh123"), {})).rejects.toThrow(/not found/);
    expect(await repository.deleteConnection(other, created.id)).toBe(false);
    expect(await repository.listConnections(other)).toEqual([]);
    expect(await repository.deleteConnection(tenantId, created.id)).toBe(true);
  });
});
