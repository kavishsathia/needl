import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { IntercomAdapter, PostHogAdapter, SentryAdapter, StripeAdapter } from "../src/adapters/index.js";
import type { WebhookRequest } from "../src/core/index.js";

const fixture = async (name: string): Promise<Buffer> => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const request = (rawBody: Uint8Array, headers: Record<string, string>, receivedAt = new Date("2026-10-14T09:00:00.000Z")): WebhookRequest => ({
  tenantId: "tenant-a",
  sourceId: "configured-source",
  rawBody,
  headers,
  receivedAt,
});

describe("SentryAdapter", () => {
  it("normalizes a signed issue lifecycle observation", async () => {
    const rawBody = await fixture("sentry-issue.json");
    const secret = "sentry-client-secret";
    const result = await new SentryAdapter().ingest(request(rawBody, {
      "Sentry-Hook-Signature": createHmac("sha256", secret).update(rawBody).digest("hex"),
      "Sentry-Hook-Resource": "issue",
      "Request-ID": "sentry-delivery-1",
    }), { secrets: [secret] });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.event.providerEventType).toBe("issue.resolved");
    expect(result.event.subject).toMatchObject({ id: "98765", type: "issue" });
    expect(result.event.evidence.providerPayload).toMatchObject({ status: "resolved", shortId: "NEEDL-9" });
  });

  it("rejects a signature made for different bytes", async () => {
    const rawBody = await fixture("sentry-issue.json");
    const result = await new SentryAdapter().ingest(request(rawBody, {
      "Sentry-Hook-Signature": createHmac("sha256", "wrong").update(rawBody).digest("hex"),
      "Sentry-Hook-Resource": "issue",
    }), { secrets: ["right"] });
    expect(result).toMatchObject({ status: "rejected", reason: "unauthenticated" });
  });
});

describe("PostHogAdapter", () => {
  it("verifies built-in Standard Webhooks signing for the documented Needl template", async () => {
    const rawBody = await fixture("posthog-event.json");
    const rawKey = Buffer.from("posthog-standard-key");
    const secret = `whsec_${rawKey.toString("base64")}`;
    const id = "posthog-delivery-1";
    const timestamp = "1791968400";
    const signature = createHmac("sha256", rawKey).update(`${id}.${timestamp}.${rawBody.toString()}`).digest("base64");
    const result = await new PostHogAdapter().ingest(request(rawBody, {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    }), { secrets: [secret], authentication: { mode: "standard-webhooks" } });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.event.providerEventType).toBe("checkout_failed");
    expect(result.event.relationships).toEqual([expect.objectContaining({ type: "customer", id: "customer-7" })]);
  });

  it("supports only explicitly configured shared destination authentication", async () => {
    const rawBody = await fixture("posthog-event.json");
    const result = await new PostHogAdapter().ingest(request(rawBody, {
      Authorization: "Bearer posthog-shared",
    }), {
      secrets: ["posthog-shared"],
      authentication: { mode: "shared-header", headerName: "authorization", prefix: "Bearer " },
    });
    expect(result.status).toBe("accepted");
  });
});

describe("IntercomAdapter", () => {
  it("verifies HMAC-SHA1 and preserves ticket/customer references", async () => {
    const rawBody = await fixture("intercom-ticket.json");
    const secret = "intercom-client-secret";
    const result = await new IntercomAdapter().ingest(request(rawBody, {
      "X-Hub-Signature": `sha1=${createHmac("sha1", secret).update(rawBody).digest("hex")}`,
    }), { secrets: [secret] });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.event.subject).toMatchObject({ type: "ticket", id: "ticket-object-5" });
    expect(result.event.relationships).toContainEqual(expect.objectContaining({ type: "contact", id: "contact-2" }));
  });

  it("marks a valid but unsupported topic as unknown", async () => {
    const rawBody = Buffer.from(JSON.stringify({
      type: "notification_event",
      id: "notif-unknown",
      topic: "company.created",
      app_id: "workspace-1",
      data: { type: "notification_event_data", item: { id: "company-1" } },
    }));
    const secret = "intercom-client-secret";
    const result = await new IntercomAdapter().ingest(request(rawBody, {
      "X-Hub-Signature": `sha1=${createHmac("sha1", secret).update(rawBody).digest("hex")}`,
    }), { secrets: [secret] });
    expect(result).toMatchObject({ status: "ignored", reason: "unknown_event", eventType: "company.created" });
  });
});

describe("StripeAdapter", () => {
  it("verifies the Stripe v1 signature and normalizes a snapshot event", async () => {
    const rawBody = await fixture("stripe-payment.json");
    const secret = "whsec_stripe_test";
    const timestamp = "1791968400";
    const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString()}`).digest("hex");
    const result = await new StripeAdapter().ingest(request(rawBody, {
      "Stripe-Signature": `t=${timestamp},v1=old-signature,v1=${signature}`,
    }), { secrets: [secret] });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.event.deliveryId).toBe("evt_stripe_1");
    expect(result.event.relationships).toContainEqual(expect.objectContaining({ type: "customer", id: "cus_7" }));
  });

  it("rejects stale deliveries before parsing", async () => {
    const rawBody = await fixture("stripe-payment.json");
    const secret = "whsec_stripe_test";
    const timestamp = "1791968400";
    const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString()}`).digest("hex");
    const result = await new StripeAdapter().ingest(request(rawBody, {
      "Stripe-Signature": `t=${timestamp},v1=${signature}`,
    }, new Date("2026-10-14T10:00:00.000Z")), { secrets: [secret] });
    expect(result).toMatchObject({ status: "rejected", reason: "stale" });
  });
});
