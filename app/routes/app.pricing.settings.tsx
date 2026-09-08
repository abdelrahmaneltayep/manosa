import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { PricingSettingsPage } from "~/components/pricing/PricingSettingsPage";
import type { PricingSettingsView } from "~/components/pricing/types";
import { db } from "~/db.server";
import { activeEngineRules, listRules, reorderRules } from "~/lib/pricing/rules.server";
import { kindFromDb } from "~/lib/pricing/rule-mapper.server";
import { explainFor } from "~/lib/pricing/view-model.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { withAdmin } from "~/shopify.server";

async function shopCurrency(): Promise<string> {
  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("currency") },
  });
  return shop?.currencyCode ?? "USD";
}

async function buildView(options: {
  orderSaved?: boolean;
  explain?: PricingSettingsView["explain"];
  explainInput?: PricingSettingsView["explainInput"];
}): Promise<PricingSettingsView> {
  const page = await listRules({ pageSize: 250, sort: "priority" });

  return {
    order: page.rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: kindFromDb(row.kind),
      combinable: row.combinable,
    })),
    anyCombinable: page.rows.some((row) => row.combinable),
    explain: options.explain ?? null,
    explainInput: options.explainInput ?? {
      variantId: "",
      tags: "wholesale",
      quantity: "10",
      price: "100.00",
    },
    orderSaved: options.orderSaved ?? false,
  };
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    return json({
      view: await buildView({ orderSaved: url.searchParams.get("saved") === "1" }),
    });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const intent = (form.get("intent") ?? "").toString();

    if (intent === "reorder") {
      const order = form.getAll("order").map((value) => value.toString());
      await reorderRules(order, { admin, actor: { type: "STAFF", id: session.id } });
      return redirect("/app/pricing/settings?saved=1");
    }

    if (intent === "explain") {
      const input = {
        variantId: (form.get("variantId") ?? "").toString().trim(),
        tags: (form.get("tags") ?? "")
          .toString()
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        quantity: Number(form.get("quantity") ?? 1) || 1,
        price: (form.get("price") ?? "0").toString().trim(),
      };

      const { rules } = await activeEngineRules();
      const currencyCode = await shopCurrency();

      // The real engine over the real rules: this answer is the checkout answer.
      const explain = explainFor(rules, input, currencyCode, new Date());

      return json({
        view: await buildView({
          explain,
          explainInput: {
            variantId: input.variantId,
            tags: input.tags.join(", "),
            quantity: String(input.quantity),
            price: input.price,
          },
        }),
      });
    }

    throw new Response("Unknown intent", { status: 400 });
  });

export default function PricingSettings() {
  const { view } = useLoaderData<typeof loader>();
  return <PricingSettingsPage view={view as PricingSettingsView} />;
}
