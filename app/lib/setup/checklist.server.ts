import { db } from "~/db.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * The six things a merchant does before Mannon is doing anything for them.
 *
 * Each one is answered by a query, not by a flag we set when they visited a
 * page: a checklist that ticks itself off when you look at a screen is a
 * checklist that lies. The one exception is the app embed, which cannot be
 * read without the `themes` protected scope — see `embedDone` below.
 */

export const SETUP_STEPS = ["embed", "rule", "form", "buyer", "order", "plan"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupItem {
  step: SetupStep;
  done: boolean;
  /** Where the merchant goes to do it. */
  href: string;
  /**
   * True when the answer is the merchant's word rather than something we
   * observed. Only the embed step can be this.
   */
  attested?: boolean;
}

export interface SetupView {
  items: SetupItem[];
  done: number;
  total: number;
  /** All six, so the card can collapse to a pill. */
  complete: boolean;
  /** The merchant collapsed it themselves. */
  dismissed: boolean;
}

const HREF: Record<SetupStep, string> = {
  embed: "/app/settings",
  rule: "/app/pricing/new",
  form: "/app/forms",
  buyer: "/app/customers/applications",
  order: "/app/orders",
  plan: "/app/plans",
};

/**
 * Is the app embed live?
 *
 * Reading the theme would need the `themes` protected scope, which this app
 * does not ask for and would not be granted for a checklist. What it has
 * instead is the App Proxy: a storefront request can only come from a theme
 * that is rendering our blocks, so `storefrontSeenAt` is proof when it is set.
 * Absence proves nothing — a store with no traffic today is not a store with
 * the embed off — so the merchant can also say they turned it on, and the card
 * shows which of the two it is going on.
 */
function embedDone(shop: {
  storefrontSeenAt: Date | null;
  embedConfirmedAt: Date | null;
}) {
  if (shop.storefrontSeenAt) return { done: true, attested: false };
  if (shop.embedConfirmedAt) return { done: true, attested: true };
  return { done: false, attested: false };
}

export async function loadSetup(): Promise<SetupView> {
  const name = shopScope.require("setup checklist");
  const shop = await db.shop.findUnique({ where: { shop: name } });

  const [rules, forms, buyers, orders] = await Promise.all([
    db.pricingRule.count({ where: { archivedAt: null } }),
    db.registrationForm.count({ where: { status: "LIVE", archivedAt: null } }),
    db.customer.count({ where: { status: "APPROVED", deletedInShopifyAt: null } }),
    db.order.count({ where: { isWholesale: true } }),
  ]);

  const embed = shop ? embedDone(shop) : { done: false, attested: false };

  // A shop on the free plan has not chosen anything yet; picking a paid plan or
  // starting a trial is a step, and staying free is a decision the merchant is
  // allowed to make — so the plans page is where it links, not a nag.
  const planChosen = Boolean(shop && shop.planKey !== "free");

  const items: SetupItem[] = [
    { step: "embed", done: embed.done, attested: embed.attested, href: HREF.embed },
    { step: "rule", done: rules > 0, href: HREF.rule },
    { step: "form", done: forms > 0, href: HREF.form },
    { step: "buyer", done: buyers > 0, href: HREF.buyer },
    { step: "order", done: orders > 0, href: HREF.order },
    { step: "plan", done: planChosen, href: HREF.plan },
  ];

  const done = items.filter((item) => item.done).length;

  return {
    items,
    done,
    total: items.length,
    complete: done === items.length,
    // Re-opens on its own if a step stops being true — the checklist asks for
    // exactly that about the embed, and it costs nothing to apply to all six.
    dismissed: Boolean(shop?.setupDismissedAt) && done === items.length,
  };
}

/** The merchant collapsing a finished checklist. */
export async function dismissSetup(): Promise<void> {
  await db.shop.updateMany({
    where: { shop: shopScope.require("dismiss setup") },
    data: { setupDismissedAt: new Date() },
  });
}

/** The merchant re-opening it. */
export async function reopenSetup(): Promise<void> {
  await db.shop.updateMany({
    where: { shop: shopScope.require("reopen setup") },
    data: { setupDismissedAt: null },
  });
}

/**
 * "I've turned the embed on."
 *
 * Recorded as the merchant's word, and superseded the moment their storefront
 * actually calls us. Never used to claim we saw anything.
 */
export async function confirmEmbed(): Promise<void> {
  await db.shop.updateMany({
    where: { shop: shopScope.require("confirm embed") },
    data: { embedConfirmedAt: new Date() },
  });
}
