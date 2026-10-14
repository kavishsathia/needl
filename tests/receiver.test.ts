import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LinearAdapter } from "../src/adapters/index.js";
import type { DeduplicatingEventSink, DeduplicationScope } from "../src/receiver/index.js";
import {
  InMemoryEventSink,
  StaticRouteResolver,
  WebhookReceiver,
} from "../src/receiver/index.js";
import { SqliteEventStore } from "../src/sqlite.js";
import type { NormalizedEvent } from "../src/core/index.js";

const receivedAt = new Date("2026-10-14T09:00:00.000Z");
let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "needl-receiver-test-"));
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function signedLinearInput(tenantId: string, secret: string) {
  const rawBody = await readFile(new URL("./fixtures/linear-issue.json", import.meta.url));
  return {
    tenantId,
    provider: "linear" as const,
    rawBody,
    receivedAt,
    headers: {
      "Linear-Signature": createHmac("sha256", secret).update(rawBody).digest("hex"),
      "Linear-Delivery": "shared-provider-delivery-id",
    },
  };
}

describe("WebhookReceiver", () => {
  it("deduplicates within tenant/provider scope but isolates tenants", async () => {
    const routes = new StaticRouteResolver()
      .register("tenant-a", "linear", new LinearAdapter(), { secrets: ["secret-a"] })
      .register("tenant-b", "linear", new LinearAdapter(), { secrets: ["secret-b"] });
    const sink = new InMemoryEventSink();
    const receiver = new WebhookReceiver({ routes, sink });

    expect((await receiver.receive(await signedLinearInput("tenant-a", "secret-a"))).outcome).toBe("stored");
    expect((await receiver.receive(await signedLinearInput("tenant-a", "secret-a"))).outcome).toBe("duplicate");
    expect((await receiver.receive(await signedLinearInput("tenant-b", "secret-b"))).outcome).toBe("stored");
    expect(sink.values()).toHaveLength(2);
  });

  it("never crosses tenant key routes", async () => {
    const routes = new StaticRouteResolver()
      .register("tenant-a", "linear", new LinearAdapter(), { secrets: ["secret-a"] })
      .register("tenant-b", "linear", new LinearAdapter(), { secrets: ["secret-b"] });
    const receiver = new WebhookReceiver({ routes, sink: new InMemoryEventSink() });
    const result = await receiver.receive(await signedLinearInput("tenant-b", "secret-a"));
    expect(result).toMatchObject({ statusCode: 401, outcome: "rejected", code: "unauthenticated" });
  });

  it("returns retryable failure and succeeds when persistence recovers", async () => {
    class FailOnceSink implements DeduplicatingEventSink {
      attempts = 0;
      async store(_event: NormalizedEvent, _scope: DeduplicationScope): Promise<"stored"> {
        this.attempts += 1;
        if (this.attempts === 1) throw new Error("synthetic storage outage");
        return "stored";
      }
    }
    const routes = new StaticRouteResolver().register("tenant-a", "linear", new LinearAdapter(), { secrets: ["secret-a"] });
    const sink = new FailOnceSink();
    const receiver = new WebhookReceiver({ routes, sink });
    expect(await receiver.receive(await signedLinearInput("tenant-a", "secret-a"))).toMatchObject({
      statusCode: 503,
      outcome: "retry",
    });
    expect(await receiver.receive(await signedLinearInput("tenant-a", "secret-a"))).toMatchObject({
      statusCode: 200,
      outcome: "stored",
    });
  });

  it("rejects oversized bodies before route or parsing work", async () => {
    const receiver = new WebhookReceiver({
      routes: new StaticRouteResolver(),
      sink: new InMemoryEventSink(),
      maxPayloadBytes: 3,
    });
    expect(await receiver.receive({
      tenantId: "missing",
      provider: "linear",
      rawBody: new TextEncoder().encode("four"),
      headers: {},
    })).toMatchObject({ statusCode: 413, code: "payload_too_large" });
  });
});

describe("SqliteEventStore", () => {
  it("persists across restart, deduplicates, and replays in sequence", async () => {
    const databasePath = join(temporaryDirectory, "events.sqlite");
    const routes = new StaticRouteResolver().register("tenant-a", "linear", new LinearAdapter(), { secrets: ["secret-a"] });
    const firstStore = new SqliteEventStore(databasePath);
    const firstReceiver = new WebhookReceiver({ routes, sink: firstStore });
    expect((await firstReceiver.receive(await signedLinearInput("tenant-a", "secret-a"))).outcome).toBe("stored");
    expect(firstStore.count()).toBe(1);
    firstStore.close();

    const restartedStore = new SqliteEventStore(databasePath);
    const restartedReceiver = new WebhookReceiver({ routes, sink: restartedStore });
    expect((await restartedReceiver.receive(await signedLinearInput("tenant-a", "secret-a"))).outcome).toBe("duplicate");
    const replayed: string[] = [];
    expect(await restartedStore.replay({ tenantId: "tenant-a", provider: "linear" }, async ({ event }) => {
      replayed.push(event.id);
    })).toBe(1);
    expect(replayed).toHaveLength(1);
    expect(restartedStore.list({ afterSequence: 1 })).toEqual([]);
    restartedStore.close();
  });
});
