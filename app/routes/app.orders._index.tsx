import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { OrderListPage } from "~/components/orders/OrderListPage";
import type { OrderListView } from "~/components/orders/types";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import {
  countNeedingResync,
  listOrders,
  ORDERS_PAGE_SIZE,
} from "~/lib/orders/orders.server";
import { toOrderRowView } from "~/lib/orders/view-model.server";
import { withAdmin } from "~/shopify.server";

/** How far back `read_orders` reaches without `read_all_orders`. */
export const ORDER_HISTORY_DAYS = 60;

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const url = new URL(request.url);
    const locale = detectLocale(request);
    const t = await getFixedT(locale);
    const now = new Date();

    const filters = {
      search: url.searchParams.get("search") ?? "",
      source: url.searchParams.get("source") ?? "",
      payment: url.searchParams.get("payment") ?? "",
    };
    const page = Number(url.searchParams.get("page") ?? 1) || 1;

    const [result, record, resyncCount] = await Promise.all([
      listOrders(filters, { page, now }),
      db.shop.findUnique({ where: { shop: session.shop } }),
      countNeedingResync(),
    ]);

    // The buyer link needs our own row id, not Shopify's customer id, and the
    // list is one page — a lookup per row would be twenty-five queries.
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

    const view: OrderListView = {
      rows: result.rows.map((row) =>
        toOrderRowView(
          {
            ...row,
            buyerRowId: row.customerId ? (buyerRowIds.get(row.customerId) ?? null) : null,
          },
          { shop: session.shop, now, t: translate(t), locale },
        ),
      ),
      total: result.total,
      totalUnfiltered: result.totalUnfiltered,
      page: result.page,
      pageSize: ORDERS_PAGE_SIZE,
      pageCount: Math.max(1, Math.ceil(result.total / ORDERS_PAGE_SIZE)),
      filters,
      syncing: record?.ordersBackfilledAt == null,
      resyncCount,
      historyDays: ORDER_HISTORY_DAYS,
    };

    return json({ view });
  });

export default function OrdersIndex() {
  const { view } = useLoaderData<typeof loader>();
  return <OrderListPage view={view as OrderListView} />;
}
