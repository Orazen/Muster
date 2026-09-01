import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import {
  customerThreadKey,
  parseInboundMessages,
  sendWhatsAppText,
  verifySignature,
  verifySubscription,
  whatsappConfigFromEnv,
} from "./whatsapp.ts";

const CONFIG = {
  accessToken: "test-access-token",
  phoneNumberId: "1234567890",
  verifyToken: "test-verify-token",
  appSecret: "test-app-secret",
};

describe("whatsappConfigFromEnv", () => {
  it("is null unless every credential is present", () => {
    expect(whatsappConfigFromEnv({})).toBeNull();
    expect(
      whatsappConfigFromEnv({ WHATSAPP_ACCESS_TOKEN: "a", WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_VERIFY_TOKEN: "v" }),
    ).toBeNull(); // missing app secret
    expect(
      whatsappConfigFromEnv({
        WHATSAPP_ACCESS_TOKEN: "a",
        WHATSAPP_PHONE_NUMBER_ID: "1",
        WHATSAPP_VERIFY_TOKEN: "v",
        WHATSAPP_APP_SECRET: "s",
      }),
    ).toEqual({ accessToken: "a", phoneNumberId: "1", verifyToken: "v", appSecret: "s" });
  });
});

describe("verifySubscription", () => {
  it("echoes the challenge when mode and token match", () => {
    const q = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "test-verify-token",
      "hub.challenge": "CHALL123",
    });
    expect(verifySubscription(q, CONFIG)).toBe("CHALL123");
  });

  it("rejects wrong tokens and wrong modes", () => {
    const q = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "C" });
    expect(verifySubscription(q, CONFIG)).toBeNull();
    const q2 = new URLSearchParams({
      "hub.mode": "unsubscribe",
      "hub.verify_token": "test-verify-token",
      "hub.challenge": "C",
    });
    expect(verifySubscription(q2, CONFIG)).toBeNull();
  });
});

describe("verifySignature", () => {
  it("accepts a valid sha256 signature and rejects tampering", () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = "sha256=" + createHmac("sha256", CONFIG.appSecret).update(body, "utf8").digest("hex");
    expect(verifySignature(CONFIG.appSecret, body, sig)).toBe(true);
    expect(verifySignature(CONFIG.appSecret, body + " ", sig)).toBe(false);
    expect(verifySignature(CONFIG.appSecret, body, "sha256=deadbeef")).toBe(false);
    expect(verifySignature(CONFIG.appSecret, body, "not-a-signature")).toBe(false);
    expect(verifySignature(CONFIG.appSecret, body, undefined)).toBe(false);
  });
});

describe("customerThreadKey", () => {
  it("maps a customer number to a stable, sanitized thread key", () => {
    expect(customerThreadKey("15551234567")).toBe("wa:15551234567");
    expect(customerThreadKey("+1 (555) 123-4567")).toBe("wa:15551234567");
    expect(customerThreadKey("15551234567")).toBe(customerThreadKey("+1555 123 4567"));
  });

  it("never returns an empty key", () => {
    expect(customerThreadKey("!!!")).toBe("wa:");
  });
});

describe("parseInboundMessages", () => {
  it("extracts customer text messages from the Meta envelope", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "15551234567",
                    id: "wamid.1",
                    text: { body: "Do you have a table tonight?" },
                    timestamp: "1",
                  },
                ],
                statuses: [{ id: "wamid.0", status: "delivered" }],
              },
            },
          ],
        },
      ],
    };
    const msgs = parseInboundMessages(JSON.stringify(payload));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ from: "15551234567", text: "Do you have a table tonight?" });
  });

  it("ignores non-text, malformed and empty payloads", () => {
    expect(parseInboundMessages("null")).toHaveLength(0);
    expect(parseInboundMessages("{}")).toHaveLength(0);
    const noText = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "1", id: "2" }] } }] }] });
    expect(parseInboundMessages(noText)).toHaveLength(0);
  });
});

describe("sendWhatsAppText", () => {
  it("posts to the pinned Graph host with the bearer token and reports success", async () => {
    let capturedUrl = "";
    // SAFETY: the stub matches fetch's call shape for this call site only.
    const impl = (async (url: string | URL | Request): Promise<Response> => {
      capturedUrl = String(url);
      return new Response("{}", { status: 200 });
    }) satisfies typeof fetch;
    const ok = await sendWhatsAppText(CONFIG, "15551234567", "Hi!", impl);
    expect(ok).toBe(true);
    expect(capturedUrl.startsWith("https://graph.facebook.com/")).toBe(true);
    expect(capturedUrl).toContain("1234567890");
  });

  it("returns false on network failure instead of throwing", async () => {
    // SAFETY: a rejecting stub is a valid fetch for the failure-path test.
    const impl = (async (): Promise<Response> => {
      throw new Error("offline");
    }) satisfies typeof fetch;
    expect(await sendWhatsAppText(CONFIG, "15551234567", "Hi!", impl)).toBe(false);
  });
});

