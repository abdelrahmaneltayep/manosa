import { db } from "~/db.server";
import { recordAudit } from "~/lib/audit/record.server";
import { loadGuardrails } from "~/lib/agent/buyer/guardrails.server";
import { rehearsalCompleted } from "~/lib/agent/buyer/rehearsal.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * What has to be true before this thing talks to anybody's customers.
 *
 * The checklist §6 names four conditions, and every one of them is answered by
 * a query rather than by a flag we set when the merchant looked at a screen —
 * the same rule the setup checklist follows, for the same reason. Three are
 * facts about the shop; the fourth, "guardrails reviewed", is the merchant's
 * own word, recorded as their word with a timestamp, because there is no query
 * that can tell whether somebody read a page.
 *
 * The gate is real: `publishAgent` re-checks it. A merchant who reaches the
 * action with an item outstanding does not publish.
 */

export const PUBLISH_STEPS = ["rule", "buyer", "reviewed", "test"] as const;
export type PublishStep = (typeof PUBLISH_STEPS)[number];

export interface PublishItem {
  step: PublishStep;
  done: boolean;
  /** Where the merchant goes to do it. */
  href: string;
}

export interface PublishReadiness {
  items: PublishItem[];
  ready: boolean;
  published: boolean;
  publishedAt: string | null;
  /** Where a buyer would meet it. Null until we know the shop's domain. */
  storefrontUrl: string | null;
  /**
   * Whether the theme app embed is actually on.
   *
   * "Published" is our own switch; the block is an app embed the merchant
   * turns on in the theme editor, and this app has no scope to read a theme.
   * What it has is the App Proxy: a storefront request can only come from a
   * theme that is rendering our blocks. So `seen` is proof, the merchant's own
   * word is an attestation, and neither being set proves nothing — which is
   * exactly what the screen then says, rather than "the agent is live".
   */
  embed: { live: boolean; attested: boolean };
}

const HREF: Record<PublishStep, string> = {
  rule: "/app/pricing/new",
  buyer: "/app/customers/applications",
  reviewed: "/app/storefront-agent",
  test: "/app/storefront-agent/test",
};

export class NotReadyError extends Error {
  constructor(readonly outstanding: PublishStep[]) {
    super(`Not ready to publish: ${outstanding.join(", ")}.`);
    this.name = "NotReadyError";
  }
}

export async function publishReadiness(): Promise<PublishReadiness> {
  const name = shopScope.require("buyer agent publish readiness");

  const [guardrails, shop, rules, buyers, tested] = await Promise.all([
    loadGuardrails(),
    db.shop.findUnique({ where: { shop: name } }),
    db.pricingRule.count({ where: { status: "ACTIVE", archivedAt: null } }),
    db.customer.count({ where: { status: "APPROVED", deletedInShopifyAt: null } }),
    // "Test conversation completed" means one the agent actually answered.
    // A rehearsal that only ever failed proves the opposite of what this item
    // is asking, so it does not tick. One definition, shared with the screen
    // that runs the rehearsal.
    rehearsalCompleted(),
  ]);

  const items: PublishItem[] = [
    { step: "rule", done: rules > 0, href: HREF.rule },
    { step: "buyer", done: buyers > 0, href: HREF.buyer },
    { step: "reviewed", done: guardrails.reviewedAt !== null, href: HREF.reviewed },
    { step: "test", done: tested, href: HREF.test },
  ];

  return {
    items,
    ready: items.every((item) => item.done),
    published: guardrails.published,
    publishedAt: guardrails.publishedAt?.toISOString() ?? null,
    storefrontUrl: storefrontUrl(shop?.primaryDomain ?? null, name),
    // The same two columns Home's setup checklist reads, for the same reason.
    embed: {
      live: shop?.storefrontSeenAt !== null && shop?.storefrontSeenAt !== undefined,
      attested: shop?.embedConfirmedAt !== null && shop?.embedConfirmedAt !== undefined,
    },
  };
}

/**
 * Where the merchant goes to see it.
 *
 * The buyer's own account page: the widget is an app embed, so it is on every
 * page of the storefront, and this is the one a signed-in wholesale buyer is
 * most likely to be on when they try it.
 */
export function storefrontUrl(primaryDomain: string | null, shop: string): string | null {
  const host = primaryDomain ?? shop;
  return host ? `https://${host}/account` : null;
}

export function outstanding(readiness: PublishReadiness): PublishStep[] {
  return readiness.items.filter((item) => !item.done).map((item) => item.step);
}

/**
 * Publish, if everything the checklist asks for is true.
 *
 * Re-checked here rather than trusted from the screen, because the screen is
 * one POST away from anybody with a session and a `curl`.
 */
export async function publishAgent(actorId: string | null): Promise<PublishReadiness> {
  const shop = shopScope.require("publish buyer agent");
  const readiness = await publishReadiness();

  const missing = outstanding(readiness);
  if (missing.length > 0) throw new NotReadyError(missing);
  if (readiness.published) return readiness;

  await db.agentGuardrails.update({
    where: { shop },
    data: { published: true, publishedAt: new Date(), updatedBy: actorId },
  });

  await recordAudit({
    actor: { type: "STAFF", id: actorId },
    action: "agent.published",
    summary: "Published the Buyer Agent to the storefront.",
    // Invariant 5, on the decision that puts this in front of customers: what
    // was true at the moment it went live, not just that it did.
    metadata: {
      checklist: Object.fromEntries(
        readiness.items.map((item) => [item.step, item.done]),
      ),
      embedSeen: readiness.embed.live,
      embedAttested: readiness.embed.attested,
    },
  });

  return publishReadiness();
}

/**
 * Unpublish.
 *
 * One click, instantly, with nothing asked in return — the checklist says "no
 * confirm-shaming" and it is right: a merchant switching this off is usually
 * doing it because something is wrong, and a dialog between them and the
 * switch is a dialog they read while it is still talking to their customers.
 */
export async function unpublishAgent(actorId: string | null): Promise<PublishReadiness> {
  const shop = shopScope.require("unpublish buyer agent");

  await db.agentGuardrails.update({
    where: { shop },
    data: { published: false, publishedAt: null, updatedBy: actorId },
  });

  await recordAudit({
    actor: { type: "STAFF", id: actorId },
    action: "agent.unpublished",
    summary: "Took the Buyer Agent off the storefront.",
  });

  return publishReadiness();
}

/** The merchant saying they have read the guardrails. */
export async function markGuardrailsReviewed(actorId: string | null): Promise<void> {
  const shop = shopScope.require("review buyer agent guardrails");
  await loadGuardrails();

  await db.agentGuardrails.update({
    where: { shop },
    data: { reviewedAt: new Date(), updatedBy: actorId },
  });

  // `updatedBy` is overwritten by the next Save, so without this "who said
  // they had read the guardrails before this thing talked to customers" is
  // recorded nowhere durable.
  await recordAudit({
    actor: { type: "STAFF", id: actorId },
    action: "agent.guardrails_reviewed",
    summary: "Reviewed the Buyer Agent's guardrails before publishing.",
  });
}
