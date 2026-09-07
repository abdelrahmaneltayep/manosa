import { createHmac } from "node:crypto";

const API_VERSION = "2025-07";

/**
 * Build a webhook request signed the way Shopify signs one, so the tests
 * exercise the real HMAC verification instead of stubbing past it.
 */
export function signedWebhookRequest({
  topic,
  shop,
  webhookId,
  payload = {},
  secret = process.env.SHOPIFY_API_SECRET ?? "",
  tamper = false,
}: {
  topic: string;
  shop: string;
  webhookId: string;
  payload?: Record<string, unknown>;
  secret?: string;
  /** Sign a different body than the one sent — a forged delivery. */
  tamper?: boolean;
}): Request {
  const body = JSON.stringify(payload);
  const signedBody = tamper ? JSON.stringify({ ...payload, injected: true }) : body;
  const hmac = createHmac("sha256", secret).update(signedBody, "utf8").digest("base64");

  return new Request(`https://mannon.test/webhooks/${topic}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": topic,
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-API-Version": API_VERSION,
      "X-Shopify-Webhook-Id": webhookId,
    },
    body,
  });
}
