import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { NeedlApp } from "./app.js";
import { withClock } from "./clock.js";

function fakeApp() {
  const calls = { ticks: 0, handled: 0 };
  const app = { tick: async () => { calls.ticks += 1; }, handle: async () => { calls.handled += 1; } } as unknown as NeedlApp;
  return { app, calls };
}

function exchange(url: string, authorization?: string) {
  const request = { url, headers: authorization === undefined ? {} : { authorization } } as IncomingMessage;
  const sent: { status?: number; body?: string } = {};
  const response = { writeHead: (status: number) => { sent.status = status; return response; }, end: (body: string) => { sent.body = body; } } as unknown as ServerResponse;
  return { request, response, sent };
}

describe("clock", () => {
  it("ticks on the cron route only with the cron secret", async () => {
    const { app, calls } = fakeApp();
    const handle = withClock(app, { environment: { CRON_SECRET: "s3cret" } });
    const denied = exchange("/api/cron/tick", "Bearer wrong");
    await handle(denied.request, denied.response);
    expect(denied.sent.status).toBe(401);
    expect(calls.ticks).toBe(0);
    const allowed = exchange("/api/cron/tick", "Bearer s3cret");
    await handle(allowed.request, allowed.response);
    expect(allowed.sent).toEqual({ status: 200, body: JSON.stringify({ ticked: true }) });
    expect(calls).toEqual({ ticks: 1, handled: 0 });
  });

  it("refuses the cron route when no secret is configured", async () => {
    const { app, calls } = fakeApp();
    const handle = withClock(app, { environment: {} });
    const attempt = exchange("/api/cron/tick", "Bearer ");
    await handle(attempt.request, attempt.response);
    expect(attempt.sent.status).toBe(401);
    expect(calls.ticks).toBe(0);
  });

  it("ticks on ordinary requests at most once per interval and still serves them", async () => {
    const { app, calls } = fakeApp();
    const handle = withClock(app, { everyMs: 60_000, environment: {} });
    for (let index = 0; index < 3; index += 1) {
      const call = exchange("/api/health");
      await handle(call.request, call.response);
    }
    expect(calls).toEqual({ ticks: 1, handled: 3 });
  });
});
