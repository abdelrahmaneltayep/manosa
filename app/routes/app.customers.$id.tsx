import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { CustomerDetailPage } from "~/components/customers/CustomerDetailPage";
import { formatMoney, money } from "@mannon/pricing-engine";

import type { CustomerDetailView } from "~/components/customers/types";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import {
  changeGroup,
  existingTags,
  getCustomer,
  setInternalNote,
  setTags,
  setTaxExempt,
  setTerms,
  VatRequiredError,
} from "~/lib/customers/customers.server";
import { toCustomerRowView } from "~/lib/customers/view-model.server";
import { formatCurrency } from "~/lib/money";
import { parseAmount } from "~/lib/terms/ledger.server";
import { ledgerFor, shopCurrency, termsFor } from "~/lib/terms/terms.server";
import { withAdmin } from "~/shopify.server";

/** A typed whole number, or null when left empty or nonsense. */
function wholeNumber(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  // "Net 0" and "Net -5" are not terms; treating them as none is the honest
  // reading of a field somebody cleared badly.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const t = await getFixedT(detectLocale(request));
    const now = new Date();
    const id = params.id!;

    const customer = await getCustomer(id);
    // Another shop's customer id reads as not found — the scoped client never
    // sees it, and that is the answer a stranger's id deserves.
    if (!customer) throw new Response("Customer not found", { status: 404 });

    const locale = detectLocale(request);
    const currencyCode = await shopCurrency();
    const ledger = await ledgerFor(customer, { now, currencyCode });
    const groupTerms = customer.group
      ? termsFor({ ...customer, netTermsDays: null, creditLimit: null }, currencyCode)
      : null;

    const [groups, knownTags] = await Promise.all([
      db.customerGroup.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true },
      }),
      existingTags(),
    ]);

    const view: CustomerDetailView = {
      customer: {
        ...toCustomerRowView(customer, { now, t: translate(t) }),
        firstName: customer.firstName,
        lastName: customer.lastName,
        company: customer.company,
        phone: customer.phone,
        countryCode: customer.countryCode,
        vatNumber: customer.vatNumber,
        vatVerifiedAt: customer.vatVerifiedAt
          ? customer.vatVerifiedAt.toISOString()
          : null,
        internalNote: customer.internalNote,
        currencyCode: customer.currencyCode,
        syncedAt: customer.syncedAt.toISOString(),
        netTermsDays: customer.netTermsDays === null ? "" : String(customer.netTermsDays),
        creditLimit:
          customer.creditLimit === null
            ? ""
            : formatMoney(money(customer.creditLimit, currencyCode)),
      },
      terms: {
        summary: ledger.terms
          ? translate(t)("customers.detail.termsSummary", {
              count: ledger.terms.days,
              limit: ledger.terms.creditLimit
                ? formatCurrency(ledger.terms.creditLimit, locale)
                : translate(t)("customers.detail.termsNoLimit"),
            })
          : translate(t)("customers.detail.termsNone"),
        overridden: ledger.overridden,
        groupSummary:
          ledger.overridden && groupTerms
            ? translate(t)("customers.terms.net", { count: groupTerms.days })
            : null,
        // The same numbers the ledger and the checkout Function quote, because
        // they come from the same module.
        ledgerSummary:
          ledger.summary.invoiceCount > 0
            ? translate(t)("customers.detail.termsLedger", {
                amount: formatCurrency(ledger.summary.outstanding, locale),
                count: ledger.summary.overdueCount,
              })
            : null,
        ledgerHref: "/app/orders/terms",
      },
      groups,
      knownTags,
      vatRequired: url.searchParams.get("error") === "vat",
      saving: false,
    };

    return json({ view });
  });

export const action = ({ request, params }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const intent = form.get("intent");
    const id = params.id!;
    const actor = { type: "STAFF" as const, id: session.id };
    const context = { admin, actor };

    try {
      if (intent === "changeGroup") {
        const groupId = (form.get("groupId") ?? "").toString();
        await changeGroup(id, groupId || null, context);
      } else if (intent === "setTags") {
        const tags = (form.get("tags") ?? "").toString().split(",");
        await setTags(id, tags, context);
      } else if (intent === "setTaxExempt") {
        await setTaxExempt(id, form.get("taxExempt") === "1", context);
      } else if (intent === "setTerms") {
        const currencyCode = await shopCurrency();
        await setTerms(
          id,
          {
            netTermsDays: wholeNumber((form.get("netTermsDays") ?? "").toString()),
            creditLimit: parseAmount(
              (form.get("creditLimit") ?? "").toString(),
              currencyCode,
            ),
          },
          context,
        );
      } else if (intent === "setNote") {
        await setInternalNote(id, (form.get("note") ?? "").toString(), actor);
      } else {
        throw new Response("Unknown intent", { status: 400 });
      }
    } catch (error) {
      if (error instanceof VatRequiredError) {
        return redirect(`/app/customers/${id}?error=vat`);
      }
      throw error;
    }

    return redirect(`/app/customers/${id}`);
  });

export default function CustomerDetail() {
  const { view } = useLoaderData<typeof loader>();
  return <CustomerDetailPage view={view as CustomerDetailView} />;
}
