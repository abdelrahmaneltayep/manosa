import { Prisma } from "@prisma/client";

import { db } from "~/db.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";
import { subscriptionForTopic, type WebhookContext } from "~/lib/webhooks/registry";

export type DispatchOutcome =
  | { status: "handled" }
  | { status: "duplicate" }
  | { status: "unhandled-topic"; topic: string };

const UNIQUE_VIOLATION = "P2002";

/**
 * Run the handler for one verified webhook delivery, exactly once.
 *
 * Shopify delivers at least once and retries for up to 48 hours, so a replay
 * of an already-handled delivery must be a no-op — otherwise an uninstall
 * retry would queue a second purge, and a future orders/create retry would
 * double-count revenue. A delivery whose handler previously *failed* is
 * re-run, because that is what the retry is for.
 *
 * Errors propagate: the route turns them into a 500 so Shopify tries again.
 */
export async function dispatchWebhook(ctx: WebhookContext): Promise<DispatchOutcome> {
  const subscription = subscriptionForTopic(ctx.topic);

  if (!subscription) {
    // Shopify is delivering something nothing here handles. Returning 200 stops
    // two days of pointless retries; the registry test is what prevents this
    // from happening silently in the first place.
    console.warn(`[webhooks] no handler for topic "${ctx.topic}" (${ctx.shop})`);
    return { status: "unhandled-topic", topic: ctx.topic };
  }

  return shopScope.run(ctx.shop, async () => {
    let deliveryId: string;

    try {
      const created = await db.webhookDelivery.create({
        data: { ...tenant(), webhookId: ctx.webhookId, topic: ctx.topic, attempts: 1 },
      });
      deliveryId = created.id;
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== UNIQUE_VIOLATION
      ) {
        throw error;
      }

      const existing = await db.webhookDelivery.findFirst({
        where: { webhookId: ctx.webhookId },
      });

      if (existing?.handledAt) return { status: "duplicate" };

      // A previous attempt did not finish. This retry is exactly what should
      // pick it up.
      const resumed = await db.webhookDelivery.update({
        where: { id: existing!.id },
        data: { attempts: { increment: 1 } },
      });
      deliveryId = resumed.id;
    }

    try {
      await subscription.handler(ctx);
    } catch (error) {
      await db.webhookDelivery.update({
        where: { id: deliveryId },
        data: { lastError: String(error) },
      });
      throw error;
    }

    await db.webhookDelivery.update({
      where: { id: deliveryId },
      data: { handledAt: new Date(), lastError: null },
    });

    return { status: "handled" };
  });
}
