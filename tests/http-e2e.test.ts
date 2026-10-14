import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExampleServer } from "../examples/server.js";
import { IntercomAdapter, LinearAdapter } from "../src/adapters/index.js";
import { StaticRouteResolver } from "../src/receiver/index.js";
import { SqliteEventStore } from "../src/sqlite.js";

let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "needl-http-test-"));
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("runnable HTTP example", () => {
  it("ingests a signed request into real SQLite and acknowledges duplicates", async () => {
    const secret = "http-linear-secret";
    const rawBody = await readFile(new URL("./fixtures/linear-issue.json", import.meta.url));
    const store = new SqliteEventStore(join(temporaryDirectory, "http.sqlite"));
    const routes = new StaticRouteResolver()
      .register("demo", "linear", new LinearAdapter(), { secrets: [secret] })
      .register("demo", "intercom", new IntercomAdapter(), { secrets: ["intercom-test-secret"] });
    const server = createExampleServer({
      routes,
      sink: store,
      clock: () => new Date("2026-10-14T09:00:00.000Z"),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const intercomValidation = await fetch(`http://127.0.0.1:${port}/webhooks/demo/intercom`, { method: "HEAD" });
    expect(intercomValidation.status).toBe(200);
    const unsignedLinearHead = await fetch(`http://127.0.0.1:${port}/webhooks/demo/linear`, { method: "HEAD" });
    expect(unsignedLinearHead.status).toBe(404);
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
    const send = () => fetch(`http://127.0.0.1:${port}/webhooks/demo/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "http-delivery-1",
      },
      body: rawBody,
    });

    const first = await send();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: "stored", eventId: expect.stringMatching(/^evt_/) });
    const duplicate = await send();
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ outcome: "duplicate" });
    expect(store.count()).toBe(1);

    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    store.close();
  });
});
