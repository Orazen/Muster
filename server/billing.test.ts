import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";

/**
 * The parts of billing worth pinning are the ones that are silent when wrong:
 * the Stripe form encoder (a bad nesting produces a 400 from Stripe, not a
 * type error) and the webhook signature check (a bad check accepts forged
 * events, which nothing else would catch).
 *
 * Network calls are not exercised here — those need a Stripe test key and
 * belong in an integration run, not the unit suite.
 */

describe("IS_CLOUD", () => {
  it("is false unless explicitly switched on", async () => {
    const { IS_CLOUD } = await import("./billing.ts");
    // The suite runs without MUSTER_CLOUD, i.e. the self-host default.
    expect(IS_CLOUD).toBe(false);
  });

  it("leaves billing unconfigured when self-hosting", async () => {
    const { isBillingConfigured } = await import("./billing.ts");
    expect(isBillingConfigured()).toBe(false);
  });

  it("reports no subscription rather than throwing when self-hosting", async () => {
    const { getSubscription } = await import("./billing.ts");
    // null is the "billing does not apply here" signal, i.e. free + unlimited.
    await expect(getSubscription("user_1", "a@example.com")).resolves.toBeNull();
  });

  it("returns no checkout or portal URL when self-hosting", async () => {
    const { createCheckoutSession, createPortalSession } = await import("./billing.ts");
    await expect(
      createCheckoutSession({
        userId: "user_1",
        email: "a@example.com",
        interval: "month",
        quantity: 1,
        returnUrl: "http://127.0.0.1:8799/app",
      }),
    ).resolves.toBeNull();
    await expect(
      createPortalSession({
        userId: "user_1",
        email: "a@example.com",
        returnUrl: "http://127.0.0.1:8799/app",
      }),
    ).resolves.toBeNull();
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test_secret";

  const sign = (body: string, timestamp: number, withSecret = secret) =>
    `t=${timestamp},v1=${createHmac("sha256", withSecret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;

  const load = async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    const mod = await import(`./billing.ts?sig=${Math.random()}`);
    process.env.STRIPE_WEBHOOK_SECRET = saved;
    return mod as typeof import("./billing.ts");
  };

  it("accepts a correctly signed, recent payload", async () => {
    const { verifyWebhookSignature } = await load();
    const body = JSON.stringify({ type: "invoice.payment_succeeded" });
    const now = Math.floor(Date.now() / 1000);
    expect(verifyWebhookSignature(body, sign(body, now))).toBe(true);
  });

  it("rejects a payload signed with the wrong secret", async () => {
    const { verifyWebhookSignature } = await load();
    const body = JSON.stringify({ type: "invoice.payment_succeeded" });
    const now = Math.floor(Date.now() / 1000);
    expect(verifyWebhookSignature(body, sign(body, now, "whsec_wrong"))).toBe(false);
  });

  it("rejects a body that was altered after signing", async () => {
    const { verifyWebhookSignature } = await load();
    const now = Math.floor(Date.now() / 1000);
    const header = sign(JSON.stringify({ type: "invoice.payment_succeeded" }), now);
    expect(verifyWebhookSignature(JSON.stringify({ type: "customer.subscription.deleted" }), header)).toBe(false);
  });

  it("rejects a replayed payload outside the five-minute window", async () => {
    const { verifyWebhookSignature } = await load();
    const body = JSON.stringify({ type: "invoice.payment_succeeded" });
    const stale = Math.floor(Date.now() / 1000) - 600;
    expect(verifyWebhookSignature(body, sign(body, stale))).toBe(false);
  });

  it("rejects missing or malformed headers", async () => {
    const { verifyWebhookSignature } = await load();
    const body = "{}";
    expect(verifyWebhookSignature(body, undefined)).toBe(false);
    expect(verifyWebhookSignature(body, "")).toBe(false);
    expect(verifyWebhookSignature(body, "garbage")).toBe(false);
    expect(verifyWebhookSignature(body, "t=123")).toBe(false);
    expect(verifyWebhookSignature(body, "v1=abc")).toBe(false);
  });

  it("rejects everything when no webhook secret is configured", async () => {
    const { verifyWebhookSignature } = await import("./billing.ts");
    const body = "{}";
    const now = Math.floor(Date.now() / 1000);
    expect(verifyWebhookSignature(body, sign(body, now))).toBe(false);
  });
});
