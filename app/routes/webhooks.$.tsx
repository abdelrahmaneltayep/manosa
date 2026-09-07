import type { ActionFunctionArgs } from "@remix-run/node";

import { dispatchWebhook } from "~/lib/webhooks/dispatch.server";
import type { WebhookPayload } from "~/lib/webhooks/registry";
import { authenticate } from "~/shopify.server";

/**
 * The single webhook endpoint. Every subscription in the registry posts here
 * under its own path; dispatch keys off the verified topic header, not the URL,
 * so a mismatched path cannot route a payload to the wrong handler.
 *
 * `authenticate.webhook` verifies the HMAC and throws a 401 Response if it does
 * not match, so nothing below runs on an unverified request.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);

  try {
    const outcome = await dispatchWebhook({
      shop,
      topic,
      webhookId,
      payload: (payload ?? {}) as WebhookPayload,
    });

    // 200 for handled, replayed, and unrecognised alike: none of them get
    // better by being retried for the next 48 hours.
    return new Response(null, {
      status: 200,
      headers: { "X-Mannon-Webhook": outcome.status },
    });
  } catch (error) {
    // A real failure. 500 tells Shopify to retry, and the delivery row already
    // carries the reason.
    console.error(`[webhooks] ${topic} failed for ${shop}`, error);
    return new Response(null, { status: 500 });
  }
};

/**
 * Webhooks are POST-only. A GET here is a misconfigured subscription or a
 * probe; say so rather than rendering the app shell.
 */
export const loader = async () => new Response("Method not allowed", { status: 405 });
