import { money, parseMoney } from "@mannon/pricing-engine";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { QuoteDetailPage } from "~/components/orders/QuoteDetailPage";
import type { QuoteDetailView } from "~/components/orders/types";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { lowestPlanWithFeature } from "~/lib/billing/plans";
import { activeEngineRules } from "~/lib/pricing/rules.server";
import { searchVariants } from "~/lib/quotes/admin-graphql.server";
import { quoteUrl } from "~/lib/quotes/email.server";
import type { QuoteLineRequest } from "~/lib/quotes/pricing.server";
import {
  acceptQuote,
  declineQuote,
  draftQuote,
  getQuote,
  QuoteValidationError,
  reopenQuote,
  sendQuote,
  type QuoteWithLines,
} from "~/lib/quotes/quotes.server";
import { QuoteTransitionError } from "~/lib/quotes/state";
import { toQuoteDetailView } from "~/lib/quotes/view-model.server";
import { withAdmin } from "~/shopify.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";

const asString = (form: FormData, key: string) => (form.get(key) ?? "").toString().trim();

/**
 * The collection ids the search result carried, as the form sends them.
 *
 * One hidden field with one id per line rather than JSON: a form field is a
 * string, and a malformed JSON blob posted by hand would throw inside an
 * action rather than simply price a line with fewer collections.
 */
const readCollectionIds = (form: FormData): string[] =>
  asString(form, "collectionIds")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

/** The lines a quote already has, in the shape the pricing path takes. */
function existingLines(quote: QuoteWithLines): QuoteLineRequest[] {
  return quote.lines.map((line) => ({
    variantId: line.variantId,
    productId: line.productId,
    title: line.title,
    sku: line.sku,
    quantity: line.quantity,
    listPrice: money(line.listPrice, quote.currencyCode),
    collectionIds: line.collectionIds,
  }));
}

async function buildView(
  request: Request,
  id: string,
  shop: string,
  admin: AdminGraphql,
  error: string | null = null,
): Promise<QuoteDetailView> {
  const quote = await getQuote(id);
  // Another shop's quote id reads as not found — the scoped client never sees
  // it, and that is the answer a stranger's id deserves.
  if (!quote) throw new Response("Quote not found", { status: 404 });

  const url = new URL(request.url);
  const locale = detectLocale(request);
  const t = translate(await getFixedT(locale));
  const now = new Date();
  const query = url.searchParams.get("q") ?? "";

  const buyer = quote.customerId
    ? await db.customer.findFirst({
        where: { customerId: quote.customerId },
        include: { group: true },
      })
    : null;

  const [{ rules }, entitlements, results] = await Promise.all([
    // Only for the locked-price comparison. A quote nobody has priced has
    // nothing to compare, so the rules are not fetched for one.
    quote.lines.length > 0 ? activeEngineRules() : Promise.resolve({ rules: [] }),
    loadEntitlements(),
    query ? searchVariants(admin, query) : Promise.resolve([]),
  ]);

  return toQuoteDetailView(quote, {
    now,
    t,
    locale,
    shop,
    buyer,
    buyerRowId: buyer?.id ?? null,
    publicUrl: quoteUrl(quote.publicId, request),
    rules,
    entitled: hasFeature(entitlements, "draft_orders"),
    requiredPlan: lowestPlanWithFeature("draft_orders"),
    error,
    search: {
      query,
      results: results.map((result) => ({
        variantId: result.id,
        productId: result.productId,
        collectionIds: result.collectionIds,
        title: result.title,
        sku: result.sku,
        price: result.price,
      })),
      searched: query.length > 0,
    },
  });
}

export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) =>
    json({ view: await buildView(request, params.id!, session.shop, admin) }),
  );

export const action = ({ request, params }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const intent = asString(form, "intent");
    const id = params.id!;
    const actor = { type: "STAFF" as const, id: session.id };

    const refuse = async (message: string) =>
      json(
        { view: await buildView(request, id, session.shop, admin, message) },
        {
          status: 422,
        },
      );

    try {
      if (intent === "addLine") {
        const quote = await getQuote(id);
        if (!quote) throw new Response("Quote not found", { status: 404 });

        const quantity = Number(asString(form, "quantity") || "1");
        const listPrice = parseMoney(
          asString(form, "listPrice") || "0",
          quote.currencyCode,
        );
        const variantId = asString(form, "variantId");

        // Adding the same variant twice adds to its quantity rather than
        // making a second line — a quote with the same SKU on two rows is one
        // a buyer will query.
        const lines = existingLines(quote);
        const existing = lines.find((line) => line.variantId === variantId);
        if (existing) {
          existing.quantity += Math.max(1, Math.trunc(quantity));
        } else {
          lines.push({
            variantId,
            // Both come back from the search result's own hidden fields. They
            // were `null` and `[]` here, so a line added by hand was priced
            // without the product- and collection-scoped rules that apply to
            // it at checkout.
            productId: asString(form, "productId") || null,
            title: asString(form, "title"),
            sku: asString(form, "sku") || null,
            quantity: Math.max(1, Math.trunc(quantity)),
            listPrice,
            collectionIds: readCollectionIds(form),
          });
        }

        await draftQuote(id, { lines }, { actor });
      } else if (intent === "removeLine") {
        const quote = await getQuote(id);
        if (!quote) throw new Response("Quote not found", { status: 404 });

        const lineId = asString(form, "lineId");
        const lines = quote.lines
          .filter((line) => line.id !== lineId)
          .map((line) => ({
            variantId: line.variantId,
            productId: line.productId,
            title: line.title,
            sku: line.sku,
            quantity: line.quantity,
            listPrice: money(line.listPrice, quote.currencyCode),
            collectionIds: line.collectionIds,
          }));

        if (lines.length === 0) {
          // The last line goes by clearing the quote, not by refusing: a
          // merchant emptying a quote means to start again.
          await db.quoteLine.deleteMany({ where: { quoteId: id } });
          await db.quote.update({ where: { id }, data: { subtotal: 0, lockedAt: null } });
        } else {
          await draftQuote(id, { lines }, { actor });
        }
      } else if (intent === "draft") {
        const quote = await getQuote(id);
        if (!quote) throw new Response("Quote not found", { status: 404 });

        await draftQuote(
          id,
          {
            lines: existingLines(quote),
            message: asString(form, "message") || null,
            internalNote: asString(form, "internalNote") || null,
          },
          { actor },
        );
      } else if (intent === "send") {
        await sendQuote(id, { actor });
      } else if (intent === "withdraw") {
        await declineQuote(id, "withdraw", { actor });
      } else if (intent === "reopen") {
        await reopenQuote(id, { actor });
      } else if (intent === "accept") {
        // The merchant accepting on a buyer's behalf — a phone order.
        await acceptQuote(id, { admin, actor });
      } else {
        throw new Response("Unknown intent", { status: 400 });
      }
    } catch (error) {
      // Said next to the button that caused it, rather than as a crash.
      if (
        error instanceof QuoteValidationError ||
        error instanceof QuoteTransitionError
      ) {
        return refuse(error.message);
      }
      throw error;
    }

    return redirect(`/app/orders/quotes/${id}`);
  });

export default function QuoteDetail() {
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <QuoteDetailPage view={view as QuoteDetailView} />;
}
