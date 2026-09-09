import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { CustomerListPage } from "~/components/customers/CustomerListPage";
import type { CustomerListView } from "~/components/customers/types";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import {
  AT_RISK_DAYS,
  changeGroup,
  CUSTOMERS_PAGE_SIZE,
  listCustomers,
  shopSettings,
} from "~/lib/customers/customers.server";
import { toCustomerRowView } from "~/lib/customers/view-model.server";
import { withAdmin } from "~/shopify.server";

const flag = (value: string | null) =>
  value === "1" ? true : value === "0" ? false : undefined;

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const t = await getFixedT(detectLocale(request));
    const now = new Date();

    const filters = {
      search: url.searchParams.get("search") ?? undefined,
      groupId: url.searchParams.get("group") ?? undefined,
      terms: (url.searchParams.get("terms") as "net" | "prepaid" | null) ?? undefined,
      taxExempt: flag(url.searchParams.get("taxExempt")),
      atRisk: url.searchParams.get("atRisk") === "1",
      page: Number(url.searchParams.get("page") ?? 1) || 1,
    };

    const [page, groups, settings] = await Promise.all([
      listCustomers(filters, now),
      db.customerGroup.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true },
      }),
      shopSettings(),
    ]);

    // Buyers whose group was deleted still price on their tags alone. Worth a
    // banner: the merchant is the only one who can decide what they should be.
    const orphanedCount = await db.customer.count({
      where: {
        groupId: null,
        deletedInShopifyAt: null,
        tags: { has: settings.wholesaleTag },
      },
    });

    const view: CustomerListView = {
      rows: page.rows.map((row) => toCustomerRowView(row, { now, t: t as never })),
      total: page.total,
      page: page.page,
      pageSize: CUSTOMERS_PAGE_SIZE,
      totalUnfiltered: page.totalUnfiltered,
      search: filters.search ?? "",
      filters: {
        groupId: url.searchParams.get("group") ?? "",
        terms: url.searchParams.get("terms") ?? "",
        taxExempt: url.searchParams.get("taxExempt") ?? "",
        atRisk: filters.atRisk,
      },
      groups,
      syncing: settings.customersBackfilledAt === null,
      syncedSoFar: page.totalUnfiltered,
      staleMinutesAgo: null,
      orphanedCount,
      wholesaleTag: settings.wholesaleTag,
      atRiskDays: AT_RISK_DAYS,
      // ✦ The segment builder needs the AI layer, which lands in phase 4.3.
      aiAvailable: false,
    };

    return json({ view });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const intent = form.get("intent");
    const customerId = (form.get("customerId") ?? "").toString();

    if (intent !== "changeGroup") throw new Response("Unknown intent", { status: 400 });
    if (!customerId) throw new Response("Missing customer", { status: 400 });

    const groupId = (form.get("groupId") ?? "").toString();
    await changeGroup(customerId, groupId || null, {
      admin,
      actor: { type: "STAFF", id: session.id },
    });

    return redirect("/app/customers");
  });

export default function CustomersIndex() {
  const { view } = useLoaderData<typeof loader>();
  return <CustomerListPage view={view as CustomerListView} />;
}
