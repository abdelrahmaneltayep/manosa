import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { GroupDetailPage } from "~/components/customers/GroupDetailPage";
import { formatMoney, money } from "@mannon/pricing-engine";

import type { GroupDetailView } from "~/components/customers/types";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import { CUSTOMERS_PAGE_SIZE } from "~/lib/customers/customers.server";
import {
  DuplicateGroupHandleError,
  getGroup,
  updateGroup,
} from "~/lib/customers/groups.server";
import { pricingRuleCountsByTag } from "~/lib/customers/pricing-links.server";
import {
  bundleSections,
  toCustomerRowView,
  toGroupRowView,
} from "~/lib/customers/view-model.server";
import { parseAmount } from "~/lib/terms/ledger.server";
import { shopCurrency } from "~/lib/terms/terms.server";
import { withAdmin } from "~/shopify.server";

export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const t = await getFixedT(detectLocale(request));
    const now = new Date();
    const id = params.id!;

    const group = await getGroup(id);
    // Scoped lookup: a group id from another shop reads as not found, which is
    // the only correct answer — confirming it exists would leak that it does.
    if (!group) throw new Response("Group not found", { status: 404 });

    const currencyCode = await shopCurrency();
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
    const ruleCounts = await pricingRuleCountsByTag();
    const pricingRuleCount = ruleCounts.get(group.tag.toLowerCase()) ?? 0;

    const members = await db.customer.findMany({
      where: { groupId: id },
      include: { group: true },
      orderBy: [{ lastOrderAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (page - 1) * CUSTOMERS_PAGE_SIZE,
      take: CUSTOMERS_PAGE_SIZE,
    });

    const view: GroupDetailView = {
      group: {
        ...toGroupRowView(group, { t: translate(t), pricingRuleCount }),
        description: group.description,
        netTermsDays: group.netTermsDays === null ? "" : String(group.netTermsDays),
        creditLimit:
          group.creditLimit === null
            ? ""
            : formatMoney(money(group.creditLimit, currencyCode)),
      },
      currencyCode,
      sections: bundleSections(group, { t: translate(t), pricingRuleCount }),
      members: members.map((member) =>
        toCustomerRowView(member, { now, t: translate(t) }),
      ),
      memberTotal: group.memberCount,
      page,
      pageSize: CUSTOMERS_PAGE_SIZE,
      saving: false,
      error: url.searchParams.get("error") === "duplicate" ? "duplicate_handle" : null,
    };

    return json({ view });
  });

/** A typed whole number, or null when the field was left empty or is nonsense. */
function wholeNumber(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  // A group with "Net -5" or "Net 0" has no terms rather than strange ones.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export const action = ({ request, params }: ActionFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const form = await request.formData();
    const id = params.id!;

    if (form.get("intent") !== "save")
      throw new Response("Unknown intent", { status: 400 });

    const name = (form.get("name") ?? "").toString().trim();
    if (!name) throw new Response("Missing name", { status: 400 });

    const currencyCode = await shopCurrency();
    const days = wholeNumber((form.get("netTermsDays") ?? "").toString());
    const limit = parseAmount((form.get("creditLimit") ?? "").toString(), currencyCode);

    try {
      await updateGroup(
        id,
        {
          name,
          tag: (form.get("tag") ?? "").toString().trim() || name,
          description: (form.get("description") ?? "").toString().trim() || null,
          netTermsDays: days,
          creditLimit: limit,
        },
        { type: "STAFF", id: session.id },
      );
    } catch (error) {
      if (error instanceof DuplicateGroupHandleError) {
        return redirect(`/app/customers/groups/${id}?error=duplicate`);
      }
      throw error;
    }

    return redirect(`/app/customers/groups/${id}`);
  });

export default function CustomerGroupDetail() {
  const { view } = useLoaderData<typeof loader>();
  return <GroupDetailPage view={view as GroupDetailView} />;
}
