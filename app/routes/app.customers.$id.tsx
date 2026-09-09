import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { CustomerDetailPage } from "~/components/customers/CustomerDetailPage";
import type { CustomerDetailView } from "~/components/customers/types";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import {
  changeGroup,
  existingTags,
  getCustomer,
  setInternalNote,
  setTags,
  setTaxExempt,
  VatRequiredError,
} from "~/lib/customers/customers.server";
import { toCustomerRowView } from "~/lib/customers/view-model.server";
import { withAdmin } from "~/shopify.server";

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

    const [groups, knownTags] = await Promise.all([
      db.customerGroup.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true },
      }),
      existingTags(),
    ]);

    const view: CustomerDetailView = {
      customer: {
        ...toCustomerRowView(customer, { now, t: t as never }),
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
