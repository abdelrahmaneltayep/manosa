import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { QuoteListPage } from "~/components/orders/QuoteListPage";
import type { QuoteListView } from "~/components/orders/types";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { lowestPlanWithFeature } from "~/lib/billing/plans";
import { createQuote, listQuotes, QUOTES_PAGE_SIZE } from "~/lib/quotes/quotes.server";
import { toQuoteRowView } from "~/lib/quotes/view-model.server";
import { withAdmin } from "~/shopify.server";

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));
    const now = new Date();

    const filters = {
      search: url.searchParams.get("search") ?? "",
      status: url.searchParams.get("status") ?? "",
    };
    const page = Number(url.searchParams.get("page") ?? 1) || 1;

    const [result, entitlements] = await Promise.all([
      listQuotes(filters, { page }),
      loadEntitlements(),
    ]);

    const customerIds = result.rows
      .map((row) => row.customerId)
      .filter((id): id is string => id !== null);
    const buyers = customerIds.length
      ? await db.customer.findMany({
          where: { customerId: { in: customerIds } },
          select: { id: true, customerId: true },
        })
      : [];
    const buyerRowIds = new Map(buyers.map((buyer) => [buyer.customerId, buyer.id]));

    const view: QuoteListView = {
      rows: result.rows.map((row) =>
        toQuoteRowView(
          {
            ...row,
            buyerRowId: row.customerId ? (buyerRowIds.get(row.customerId) ?? null) : null,
          },
          { now, t, locale },
        ),
      ),
      total: result.total,
      totalUnfiltered: result.totalUnfiltered,
      page: result.page,
      pageCount: Math.max(1, Math.ceil(result.total / QUOTES_PAGE_SIZE)),
      filters,
      entitled: hasFeature(entitlements, "draft_orders"),
      requiredPlan: lowestPlanWithFeature("draft_orders"),
    };

    return json({ view });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const form = await request.formData();
    if (form.get("intent") !== "create") {
      throw new Response("Unknown intent", { status: 400 });
    }

    // An empty quote, ready for the merchant to price. Everything about the
    // buyer is filled in on the detail page, where they can see it.
    const quote = await createQuote(
      { customerId: null, email: null, company: null, requestNote: null },
      { actor: { type: "STAFF", id: session.id } },
    );

    return redirect(`/app/orders/quotes/${quote.id}`);
  });

export default function QuotesIndex() {
  const { view } = useLoaderData<typeof loader>();
  return <QuoteListPage view={view as QuoteListView} />;
}
