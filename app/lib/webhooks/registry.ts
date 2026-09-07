import { handleAppSubscriptionsUpdate } from "~/lib/webhooks/handlers/app-subscriptions-update.server";
import { handleAppUninstalled } from "~/lib/webhooks/handlers/app-uninstalled.server";

/**
 * Payloads are Shopify's, not ours — handlers narrow what they actually read
 * rather than trusting a hand-written interface to stay accurate.
 */
export type WebhookPayload = Record<string, unknown>;

export interface WebhookContext {
  shop: string;
  topic: string;
  webhookId: string;
  payload: WebhookPayload;
}

export interface WebhookSubscription {
  /** Shopify's topic as it appears in shopify.app.toml, e.g. "app/uninstalled". */
  readonly topic: string;
  /** The path the subscription posts to. One URI per topic, for readability
   *  in logs — the dispatcher keys off the topic header, not the path. */
  readonly uri: string;
  readonly description: string;
  readonly handler: (ctx: WebhookContext) => Promise<void>;
}

/**
 * The single source of truth for webhooks.
 *
 * `shopify.app.toml` must declare exactly these topics at exactly these URIs;
 * `tests/unit/webhook-registry.test.ts` fails the build if they drift. That
 * catches both halves of the classic bug: a handler with no subscription
 * (silently never runs) and a subscription with no handler (404s, and Shopify
 * retries it for two days).
 */
export const WEBHOOK_SUBSCRIPTIONS: readonly WebhookSubscription[] = [
  {
    topic: "app/uninstalled",
    uri: "/webhooks/app/uninstalled",
    description: "Revoke access tokens immediately and schedule the GDPR PII purge.",
    handler: handleAppUninstalled,
  },
  {
    topic: "app_subscriptions/update",
    uri: "/webhooks/app-subscriptions/update",
    description:
      "Keep the cached plan correct the moment a subscription is approved, " +
      "cancelled, or frozen by a failed charge.",
    handler: handleAppSubscriptionsUpdate,
  },
] as const;

const BY_TOPIC = new Map(
  // Shopify sends the topic header uppercased and underscored.
  WEBHOOK_SUBSCRIPTIONS.map((sub) => [normalizeTopic(sub.topic), sub]),
);

export function normalizeTopic(topic: string): string {
  return topic.toUpperCase().replace(/[/-]/g, "_");
}

export function subscriptionForTopic(topic: string): WebhookSubscription | undefined {
  return BY_TOPIC.get(normalizeTopic(topic));
}
