import { handleAppSubscriptionsUpdate } from "~/lib/webhooks/handlers/app-subscriptions-update.server";
import { handleCollectionsUpdate } from "~/lib/webhooks/handlers/collections-update.server";
import { handleCustomersDelete } from "~/lib/webhooks/handlers/customers-delete.server";
import { handleCustomersUpsert } from "~/lib/webhooks/handlers/customers-upsert.server";
import { handleOrdersCancelled } from "~/lib/webhooks/handlers/orders-cancelled.server";
import { handleOrdersEdited } from "~/lib/webhooks/handlers/orders-edited.server";
import { handleOrdersUpsert } from "~/lib/webhooks/handlers/orders-upsert.server";
import { handleProductsUpdate } from "~/lib/webhooks/handlers/products-update.server";
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
  {
    topic: "customers/create",
    uri: "/webhooks/customers/create",
    description:
      "Mirror a new customer and publish their tags so checkout can price for them.",
    handler: handleCustomersUpsert,
  },
  {
    topic: "customers/update",
    uri: "/webhooks/customers/update",
    description:
      "Republish a buyer's tags when they change — this is how approving " +
      "someone for wholesale reaches checkout.",
    handler: handleCustomersUpsert,
  },
  {
    topic: "customers/delete",
    uri: "/webhooks/customers/delete",
    description: "Flag a deleted buyer so the list says so, rather than losing the row.",
    handler: handleCustomersDelete,
  },
  {
    topic: "orders/create",
    uri: "/webhooks/orders/create",
    description:
      "Mirror a new order so the wholesale list has it, and tag it in Shopify " +
      "when a wholesale buyer placed it.",
    handler: handleOrdersUpsert,
  },
  {
    topic: "orders/updated",
    uri: "/webhooks/orders/updated",
    description:
      "Keep totals, payment status and refunds current — this is how a refund " +
      "or an edit made in Shopify's admin reaches the list.",
    handler: handleOrdersUpsert,
  },
  {
    topic: "orders/edited",
    uri: "/webhooks/orders/edited",
    description:
      "An edit carries only the line-item deltas, so flag the order as stale " +
      "rather than rewriting its total from a partial payload.",
    handler: handleOrdersEdited,
  },
  {
    topic: "orders/cancelled",
    uri: "/webhooks/orders/cancelled",
    description: "Record a cancellation against the order rather than losing the row.",
    handler: handleOrdersCancelled,
  },
  {
    topic: "products/update",
    uri: "/webhooks/products/update",
    description:
      "Republish a product's collection membership so collection-targeted " +
      "rules apply at checkout.",
    handler: handleProductsUpdate,
  },
  {
    topic: "collections/update",
    uri: "/webhooks/collections/update",
    description:
      "Refresh membership for the products in a collection whose rules changed.",
    handler: handleCollectionsUpdate,
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
