import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitLabAdapter, LaunchDarklyAdapter, LinearAdapter } from "../src/adapters/index.js";
import type { WebhookRequest } from "../src/core/index.js";

const fixture = async (name: string): Promise<Uint8Array> =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url));

const request = (rawBody: Uint8Array, headers: Record<string, string>, receivedAt = new Date("2026-10-14T09:00:00.000Z")): WebhookRequest => ({
  tenantId: "tenant-a",
  sourceId: "configured-hook",
  rawBody,
  headers,
  receivedAt,
});

describe("GitLabAdapter", () => {
  it("verifies a documented Standard Webhooks signature and normalizes a pipeline", async () => {
    const rawBody = await fixture("gitlab-pipeline.json");
    const rawKey = Buffer.from("gitlab-test-signing-key");
    const secret = `whsec_${rawKey.toString("base64")}`;
    const timestamp = "1791968400";
    const delivery = "gitlab-delivery-1";
    const signature = createHmac("sha256", rawKey)
      .update(`${delivery}.${timestamp}.${rawBody.toString()}`)
      .digest("base64");
    const result = await new GitLabAdapter().ingest(request(rawBody, {
      "X-Gitlab-Event": "Pipeline Hook",
      "webhook-id": delivery,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    }), { authMode: "signing-token", secrets: [secret] });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.event.providerEventType).toBe("pipeline.success");
    expect(result.event.subject).toMatchObject({ type: "pipeline", id: "9001" });
    expect(result.event.relationships).toContainEqual(expect.objectContaining({ type: "project", id: "101" }));
  });

  it("rejects tampered bytes and never falls back to a present legacy token", async () => {
    const rawBody = await fixture("gitlab-pipeline.json");
    const result = await new GitLabAdapter().ingest(request(rawBody, {
      "X-Gitlab-Event": "Pipeline Hook",
      "X-Gitlab-Token": "also-present",
      "webhook-id": "delivery",
      "webhook-timestamp": "1791968400",
      "webhook-signature": "v1,bad",
    }), { authMode: "signing-token", secrets: [`whsec_${Buffer.from("key").toString("base64")}`] });
    expect(result).toMatchObject({ status: "rejected", reason: "unauthenticated" });
  });

  it("supports explicitly configured legacy secret-token mode", async () => {
    const rawBody = await fixture("gitlab-pipeline.json");
    const result = await new GitLabAdapter().ingest(request(rawBody, {
      "X-Gitlab-Event": "Pipeline Hook",
      "X-Gitlab-Token": "legacy-secret",
    }), { authMode: "secret-token", secrets: ["legacy-secret"] });
    expect(result.status).toBe("accepted");
  });
});

describe("LinearAdapter", () => {
  it("verifies raw bytes, replay window, and explicit issue relationship evidence", async () => {
    const rawBody = await fixture("linear-issue.json");
    const secret = "linear-secret";
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
    const result = await new LinearAdapter().ingest(request(rawBody, {
      "Linear-Signature": signature,
      "Linear-Delivery": "linear-delivery-1",
    }), { secrets: [secret], payloadRetention: "full" });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.event.providerEventType).toBe("Issue.update");
    expect(result.event.relationships).toContainEqual(expect.objectContaining({ type: "issue-key", id: "NDL-42" }));
    expect(result.event.evidence.providerPayload.updatedFrom).toEqual({ stateId: "state-progress" });
    expect(result.event.evidence.providerPayload).toMatchObject({ stateName: "Done", stateType: "completed", stateChanged: true });
    expect(result.event.evidence.originalPayload).toBe(rawBody.toString());
    expect(result.event.evidence.bodySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects stale signed input", async () => {
    const rawBody = await fixture("linear-issue.json");
    const secret = "linear-secret";
    const result = await new LinearAdapter().ingest(request(rawBody, {
      "Linear-Signature": createHmac("sha256", secret).update(rawBody).digest("hex"),
    }, new Date("2026-10-14T10:00:00.000Z")), { secrets: [secret] });
    expect(result).toMatchObject({ status: "rejected", reason: "stale" });
  });
});

describe("LaunchDarklyAdapter", () => {
  it("normalizes a signed audit-log flag change without inferring flag state", async () => {
    const rawBody = await fixture("launchdarkly-flag.json");
    const secret = "ld-secret";
    const result = await new LaunchDarklyAdapter().ingest(request(rawBody, {
      "X-LD-Signature": createHmac("sha256", secret).update(rawBody).digest("hex"),
    }), { secrets: [secret] });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.event.providerEventType).toBe("flag.updateOn");
    expect(result.event.evidence.providerPayload).not.toHaveProperty("enabled");
    expect(result.event.evidence).not.toHaveProperty("originalPayload");
    expect(result.event.relationships).toContainEqual(expect.objectContaining({
      id: "proj/needl:env/production:flag/checkout-v2",
      evidencePath: "/accesses/0/resource",
    }));
  });

  it("distinguishes an authenticated unknown event from malformed input", async () => {
    const rawBody = Buffer.from(JSON.stringify({
      _id: "audit-x",
      date: 1791968400000,
      kind: "account",
      accesses: [{ action: "update", resource: "account/one" }],
    }));
    const secret = "ld-secret";
    const result = await new LaunchDarklyAdapter().ingest(request(rawBody, {
      "X-LD-Signature": createHmac("sha256", secret).update(rawBody).digest("hex"),
    }), { secrets: [secret] });
    expect(result).toMatchObject({ status: "ignored", reason: "unknown_event", eventType: "account.update" });
  });
});
