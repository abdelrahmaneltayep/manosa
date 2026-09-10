import { db } from "~/db.server";
import { knownTimezone } from "~/lib/shop/domains.server";
import type { WebhookContext } from "~/lib/webhooks/registry";

/**
 * The merchant changed something about their store.
 *
 * We care about three fields, and only because every money figure in this app
 * is formatted with the shop's currency and every chart is bucketed in the
 * shop's timezone. A merchant who switches from USD to EUR and then reads
 * their own revenue in dollars for a day has been told something untrue.
 *
 * Read from the payload rather than by calling back: the webhook already
 * carries what we need, and a store that changes its currency is not a store
 * we should spend an Admin API call on to find out.
 */
export async function handleShopUpdate({ shop, payload }: WebhookContext) {
  const body = payload as {
    name?: string | null;
    email?: string | null;
    currency?: string | null;
    iana_timezone?: string | null;
    country_code?: string | null;
    domain?: string | null;
  };

  const text = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };

  const currencyCode = text(body.currency)?.toUpperCase() ?? null;
  // Validated, not trusted: this value goes into `Intl.DateTimeFormat`, which
  // throws on a zone it does not know, and a chart that throws is worse than a
  // chart in UTC.
  const ianaTimezone = knownTimezone(text(body.iana_timezone));

  // Only what actually arrived. A partial payload must not blank a currency we
  // already know — that would put every figure back on the fallback.
  const data = {
    ...(text(body.name) ? { name: text(body.name) } : {}),
    ...(text(body.email) ? { email: text(body.email) } : {}),
    ...(currencyCode ? { currencyCode } : {}),
    ...(ianaTimezone ? { ianaTimezone } : {}),
    ...(text(body.country_code)
      ? { countryCode: text(body.country_code)!.toUpperCase() }
      : {}),
    ...(text(body.domain) ? { primaryDomain: text(body.domain) } : {}),
  };

  if (Object.keys(data).length === 0) {
    console.info(`[mannon] shop/update for ${shop} carried nothing we read`);
    return;
  }

  await db.shop.updateMany({
    where: { shop },
    data: { ...data, shopFactsSyncedAt: new Date() },
  });
}
