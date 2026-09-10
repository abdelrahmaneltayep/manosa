import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { createHash } from "node:crypto";

import { db } from "~/db.server";
import { overTurnLimit } from "~/lib/agent/buyer/conversation.server";
import { answerBuyerTurn } from "~/lib/agent/buyer/turn.server";
import { MAX_MESSAGE_CHARS } from "~/lib/ai/prompts/buyer-agent.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { withProxy } from "~/lib/storefront/proxy.server";
import { unauthenticated } from "~/shopify.server";

/**
 * One turn of the Buyer Agent, from the storefront.
 *
 * Reached at `/apps/mannon/agent` on the merchant's own domain, through
 * Shopify's App Proxy. The same three things make it safe to answer as the
 * quick-order endpoint:
 *
 * - the request is signed, so `logged_in_customer_id` is Shopify's word rather
 *   than the browser's — which matters more here than anywhere else in the
 *   app, because it is the only thing standing between a stranger and another
 *   buyer's order history;
 * - the tenant scope is opened from the signed shop before any query runs;
 * - every price the agent states comes from the engine, and a reply that
 *   states one that did not is refused rather than sent.
 */

export const action = ({ request }: ActionFunctionArgs) =>
  withProxy(request, async (context) => {
    if (request.method !== "POST") {
      throw new Response("Method not allowed", { status: 405 });
    }

    const entitlements = await loadEntitlements();
    if (!hasFeature(entitlements, "buyer_agent")) {
      // The block is on the merchant's theme; the plan says whether it answers.
      // The widget shows the quick-order link rather than an error.
      return json({ ok: false as const, failure: "not_available" }, { status: 402 });
    }

    const form = await request.formData();
    const message = (form.get("message") ?? "").toString().slice(0, MAX_MESSAGE_CHARS);

    // Costed per turn, so the ceiling is per buyer rather than per shop: one
    // buyer cannot spend the merchant's whole budget, and a runaway script
    // cannot either. A signed-out visitor is counted by a key derived here —
    // guest mode used to have no ceiling at all, which is the one mode where
    // an attacker needs no account.
    const guestKey = context.customerId ? null : guestKeyFor(request, context.shop);
    if (await overTurnLimit({ customerId: context.customerId, guestKey })) {
      return json({ ok: false as const, failure: "rate_limited" }, { status: 429 });
    }

    const record = await db.shop.findUnique({ where: { shop: context.shop } });
    const { admin } = await unauthenticated.admin(context.shop);

    const turn = await answerBuyerTurn({
      message,
      customerId: context.customerId,
      guestKey,
      locale: context.locale ?? record?.primaryLocale ?? "en",
      admin,
    });

    if (turn.failure) {
      return json({
        ok: false as const,
        failure: turn.failure,
        conversationId: turn.conversationId,
      });
    }

    return json({
      ok: true as const,
      conversationId: turn.conversationId,
      reply: turn.reply,
      cart: turn.cart,
      quote: turn.quote,
      refusal: turn.refusal,
    });
  });

/**
 * Who a signed-out visitor is, for the purpose of counting their turns.
 *
 * The forwarded address and the user agent, hashed with the shop so the value
 * is meaningless outside it and is not itself a piece of personal data sitting
 * in a column. Derived here rather than taken from the request body: a key the
 * caller chooses is a ceiling the caller can step over.
 */
function guestKeyFor(request: Request, shop: string): string {
  const address =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("cf-connecting-ip") ??
    "";
  const agent = request.headers.get("user-agent") ?? "";
  return createHash("sha256").update(`${shop}|${address}|${agent}`).digest("hex");
}

/** A GET here is a mistake, not a question. Said plainly. */
export const loader = () => {
  throw new Response("Post a message to this address", { status: 405 });
};
