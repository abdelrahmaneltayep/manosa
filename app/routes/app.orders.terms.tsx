import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { LedgerPage } from "~/components/orders/LedgerPage";
import type { LedgerView } from "~/components/orders/types";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { lowestPlanWithFeature } from "~/lib/billing/plans";
import { toBucketViews, toLedgerRowView } from "~/lib/orders/view-model.server";
import { ledgerPage, LEDGER_PAGE_SIZE } from "~/lib/terms/ledger-query.server";
import {
  parseAmount,
  publishBuyerTerms,
  recordPayment,
  PaymentError,
} from "~/lib/terms/ledger.server";
import { canRemind, ReminderError, sendReminder } from "~/lib/terms/reminders.server";
import { saveTermsSettings } from "~/lib/terms/settings.server";
import { formatCurrency } from "~/lib/money";
import { withAdmin } from "~/shopify.server";

const asString = (form: FormData, key: string) => (form.get(key) ?? "").toString().trim();

/**
 * What the pay-later button will say, built the way the Function builds it.
 *
 * The days come from a real term this store uses rather than a stock "Net 30":
 * a merchant whose buyers are all on Net 60 would otherwise be shown a preview
 * of a button none of them will ever see.
 */
function previewName(methodName: string, showDays: boolean, days: number): string {
  return showDays ? `Pay later (Net ${days})` : methodName;
}

/** The terms a buyer in this store is most likely to have. */
async function representativeDays(): Promise<number> {
  const group = await db.customerGroup.findFirst({
    where: { netTermsDays: { not: null } },
    orderBy: { sortOrder: "asc" },
    select: { netTermsDays: true },
  });
  if (group?.netTermsDays) return group.netTermsDays;

  const buyer = await db.customer.findFirst({
    where: { netTermsDays: { not: null } },
    select: { netTermsDays: true },
  });
  return buyer?.netTermsDays ?? 30;
}

async function buildView(
  request: Request,
  shop: string,
  errors: { payment?: { orderId: string; message: string }; settings?: boolean } = {},
): Promise<LedgerView> {
  const url = new URL(request.url);
  const locale = detectLocale(request);
  const t = translate(await getFixedT(locale));
  const now = new Date();
  const page = Number(url.searchParams.get("page") ?? 1) || 1;

  const record = await db.shop.findUnique({ where: { shop } });
  const currencyCode = record?.currencyCode ?? "USD";

  const [ledger, entitlements, previewDays] = await Promise.all([
    ledgerPage({ page, pageSize: LEDGER_PAGE_SIZE, now, currencyCode }),
    loadEntitlements(),
    representativeDays(),
  ]);

  // One lookup for the page, not one per row.
  const customerIds = ledger.rows
    .map((row) => row.customerId)
    .filter((id): id is string => id !== null);
  const buyers = customerIds.length
    ? await db.customer.findMany({
        where: { customerId: { in: customerIds } },
        select: { id: true, customerId: true },
      })
    : [];
  const buyerRowIds = new Map(buyers.map((buyer) => [buyer.customerId, buyer.id]));

  return {
    rows: ledger.rows.map((row) =>
      toLedgerRowView(
        {
          ...row,
          buyerRowId: row.customerId ? (buyerRowIds.get(row.customerId) ?? null) : null,
          error: errors.payment?.orderId === row.id ? errors.payment.message : null,
        },
        { shop, now, t, locale, canRemind: canRemind(row, now) },
      ),
    ),
    buckets: toBucketViews(ledger.summary, { locale }),
    outstanding: formatCurrency(ledger.summary.outstanding, locale),
    page: ledger.page,
    pageCount: ledger.pageCount,
    anyBuyerHasTerms: ledger.anyBuyerHasTerms,
    entitled: hasFeature(entitlements, "net_terms"),
    requiredPlan: lowestPlanWithFeature("net_terms"),
    publishedAt: record?.termsPublishedAt?.toISOString() ?? null,
    settings: {
      methodName: record?.termsMethodName ?? "Net terms",
      showDaysInName: record?.termsShowDays ?? true,
      overdueBlocks: record?.termsOverdueBlocks ?? true,
      preview: previewName(
        record?.termsMethodName ?? "Net terms",
        record?.termsShowDays ?? true,
        previewDays,
      ),
    },
    settingsError: errors.settings === true,
  };
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async ({ session }) =>
    json({ view: await buildView(request, session.shop) }),
  );

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const intent = asString(form, "intent");
    const actor = { type: "STAFF" as const, id: session.id };

    if (intent === "settings") {
      try {
        await saveTermsSettings(
          {
            methodName: asString(form, "methodName"),
            showDaysInName: form.get("showDaysInName") !== null,
            overdueBlocks: form.get("overdueBlocks") !== null,
          },
          { admin, actor },
        );
      } catch (error) {
        if (error instanceof Response && error.status === 400) {
          return json(
            { view: await buildView(request, session.shop, { settings: true }) },
            { status: 422 },
          );
        }
        throw error;
      }
      return redirect("/app/orders/terms");
    }

    const orderId = asString(form, "orderId");
    if (!orderId) throw new Response("Missing order", { status: 400 });

    if (intent === "remind") {
      try {
        await sendReminder(orderId, { actor });
      } catch (error) {
        if (error instanceof ReminderError) {
          return json(
            {
              view: await buildView(request, session.shop, {
                payment: { orderId, message: error.message },
              }),
            },
            { status: 422 },
          );
        }
        throw error;
      }
      return redirect("/app/orders/terms");
    }

    if (intent !== "recordPayment") throw new Response("Unknown intent", { status: 400 });

    const record = await db.shop.findUnique({ where: { shop: session.shop } });
    const currencyCode = record?.currencyCode ?? "USD";
    const amount = parseAmount(asString(form, "amount"), currencyCode);

    if (amount === null) {
      return json(
        {
          view: await buildView(request, session.shop, {
            payment: { orderId, message: "Enter the amount received." },
          }),
        },
        { status: 422 },
      );
    }

    try {
      const { order } = await recordPayment(
        orderId,
        {
          amount,
          receivedAt: new Date(),
          reference: asString(form, "reference") || null,
        },
        { actor },
      );

      // Their balance changed, so what checkout would decide changed with it.
      if (order.customerId) {
        const buyer = await db.customer.findFirst({
          where: { customerId: order.customerId },
          include: { group: true },
        });
        if (buyer) await publishBuyerTerms(admin, buyer);
      }
    } catch (error) {
      if (error instanceof PaymentError) {
        return json(
          {
            view: await buildView(request, session.shop, {
              payment: { orderId, message: error.message },
            }),
          },
          { status: 422 },
        );
      }
      throw error;
    }

    return redirect("/app/orders/terms");
  });

export default function OrderTermsRoute() {
  // The action's view wins: a no-JS document POST re-runs the loader, and
  // reading only the loader's copy throws away the failed entry.
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <LedgerPage view={view as LedgerView} />;
}
