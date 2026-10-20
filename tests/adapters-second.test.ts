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

  it("normalizes a documented event alert: event_id subject, Unix-seconds time, tags, and tagged environment", async () => {
    const rawBody = await fixture("sentry-event-alert.json");
    const secret = "sentry-client-secret";
    const result = await new SentryAdapter().ingest(request(rawBody, {
      "Sentry-Hook-Signature": createHmac("sha256", secret).update(rawBody).digest("hex"),
      "Sentry-Hook-Resource": "event_alert",
      "Request-ID": "sentry-delivery-2",
    }), { secrets: [secret] });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.event.providerEventType).toBe("event_alert.triggered");
    expect(result.event.subject).toMatchObject({ type: "error_event", id: "e4874d664c3540c1a32eab185f12c5ab", name: "CheckoutError: retry loop" });
    expect(result.event.occurredAt).toBe("2026-10-14T09:00:00.677Z");
    expect(result.event.relationships).toEqual(expect.arrayContaining([
      { type: "project", id: "12", evidencePath: "/data/event/project" },
      { type: "tag.linear_issue", id: "NDL-42", evidencePath: "/data/event/tags/1" },
      { type: "tag.browser.name", id: "Chrome", evidencePath: "/data/event/tags/2" },
      { type: "environment", id: "production", evidencePath: "/data/event/tags/0" },
    ]));
  });

  it("rejects a signature made for different bytes", async () => {
    const rawBody = await fixture("sentry-issue.json");
    const result = await new SentryAdapter().ingest(request(rawBody, {
      "Sentry-Hook-Signature": createHmac("sha256", "wrong").update(rawBody).digest("hex"),
      "Sentry-Hook-Resource": "issue",
    }), { secrets: ["right"] });
    expect(result).toMatchObject({ status: "rejected", reason: "unauthenticated" });
  });

  it("rejects a missing signature without parsing", async () => {
    const rawBody = await fixture("sentry-issue.json");
    const result = await new SentryAdapter().ingest(request(rawBody, {
      "Sentry-Hook-Resource": "issue",
    }), { secrets: ["sentry-client-secret"] });
    expect(result).toMatchObject({ status: "rejected", reason: "unauthenticated" });
  });

  it("classifies signed invalid schema as malformed", async () => {
    const rawBody = Buffer.from("{}");
    const secret = "sentry-client-secret";
    const result = await new SentryAdapter().ingest(request(rawBody, {
      "Sentry-Hook-Signature": createHmac("sha256", secret).update(rawBody).digest("hex"),
      "Sentry-Hook-Resource": "issue",
    }), { secrets: [secret] });
    expect(result).toMatchObject({ status: "rejected", reason: "malformed" });
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

  it("reads invoice links from API versions that moved them (invoice_payment.paid, invoice.parent)", async () => {
    const secret = "whsec_stripe_test";
    const timestamp = "1791968400";
    const ingest = (body: unknown) => {
      const rawBody = Buffer.from(JSON.stringify(body));
      const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString()}`).digest("hex");
      return new StripeAdapter().ingest(request(rawBody, { "Stripe-Signature": `t=${timestamp},v1=${signature}` }), { secrets: [secret] });
    };
    const paid = await ingest({ id: "evt_ip", object: "event", type: "invoice_payment.paid", created: 1791968400, livemode: false, data: { object: {
      id: "inpay_1", object: "invoice_payment", invoice: "in_9", status: "paid", amount_paid: 1500, currency: "sgd",
      payment: { type: "payment_intent", payment_intent: "pi_123" },
    } } });
    expect(paid.status).toBe("accepted");
    if (paid.status !== "accepted") return;
    expect(paid.event.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "invoice", id: "in_9" }), expect.objectContaining({ type: "payment_intent", id: "pi_123" }),
    ]));
    expect(paid.event.evidence.providerPayload).toMatchObject({ amount: 1500 });
    const failed = await ingest({ id: "evt_if", object: "event", type: "invoice.payment_failed", created: 1791968400, livemode: false, data: { object: {
      id: "in_9", object: "invoice", customer: "cus_7", status: "open",
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_4" } },
    } } });
    expect(failed.status === "accepted" && failed.event.relationships).toContainEqual(expect.objectContaining({ type: "subscription", id: "sub_4" }));
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
