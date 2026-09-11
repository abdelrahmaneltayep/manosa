import { db } from "~/db.server";
import { getFixedT } from "~/i18n.server";
import type { Locale } from "~/i18n/config";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * What the widget says before a buyer has said anything.
 *
 * Checklist §6: *"greeting (personalized: name, tier, last order)"*. 5.2
 * shipped the name only — the theme block reads `customer.first_name` from
 * Liquid, which is all Liquid knows — and the other two were left open in
 * `PROGRESS.md`. Both live in this app's own tables, so they need a request.
 *
 * Composed here rather than in the block: pluralising "3 days ago" in six
 * Arabic categories inside a Liquid template is how a storefront ends up
 * reading `agent.scripted.lastOrder_few`, and these strings are ones a
 * merchant may rewrite (`agent.scripted` is buyer-facing), so they have to go
 * through the same `t` every other buyer-facing string does.
 *
 * Never blocks the widget. The block prints its own greeting immediately and
 * replaces it if and when this answers — a panel that waits on a request to
 * say hello is a panel that is broken whenever the request is.
 */

const DAY = 86_400_000;

export interface Greeting {
  /** One or two sentences, already translated and already substituted. */
  text: string;
}

export async function greetingFor(
  customerId: string,
  locale: Locale,
  now: Date = new Date(),
): Promise<Greeting | null> {
  shopScope.require("greetingFor");

  const buyer = await db.customer.findFirst({
    where: { customerId },
    select: {
      firstName: true,
      company: true,
      lastOrderAt: true,
      orderCount: true,
      group: { select: { name: true } },
    },
  });
  if (!buyer) return null;

  const t = await getFixedT(locale);
  const name = buyer.firstName?.trim() || buyer.company?.trim() || null;

  const lines = [
    name ? t("agent.scripted.greetingNamed", { name }) : t("agent.scripted.greeting"),
  ];

  // Their tier, if they are in one. A buyer priced by tags alone has no tier
  // to be told about, and inventing "Standard" would be naming a group the
  // merchant never made.
  if (buyer.group?.name) {
    lines.push(t("agent.scripted.greetingTier", { tier: buyer.group.name }));
  }

  if (buyer.lastOrderAt) {
    const days = Math.max(
      0,
      Math.floor((now.getTime() - buyer.lastOrderAt.getTime()) / DAY),
    );
    lines.push(t("agent.scripted.greetingLastOrder", { count: days }));
  } else if (buyer.orderCount === 0) {
    lines.push(t("agent.scripted.greetingFirstOrder"));
  }

  return { text: lines.join(" ") };
}
