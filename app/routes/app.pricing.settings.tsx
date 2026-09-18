import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { PricingSettingsPage } from "~/components/pricing/PricingSettingsPage";
import type { PricingSettingsView } from "~/components/pricing/types";
import { db } from "~/db.server";
import { activeEngineRules, listRules, reorderRules } from "~/lib/pricing/rules.server";
import { kindFromDb } from "~/lib/pricing/rule-mapper.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { explainFor } from "~/lib/pricing/view-model.server";
import { variantById } from "~/lib/quotes/admin-graphql.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { withAdmin } from "~/shopify.server";

/**
 * The buyer, as checkout knows them.
 *
 * Their groups and their company decide four of the six audience modes, and
 * this tool answered `audience_mismatch` for all of them because it invented a
 * customer with neither. Typed tags still work — a merchant may be asking
 * about a buyer they have not created yet — and are merged with the real ones
 * so the answer is about a person, not a guess.
 */
async function resolveBuyer(
  email: string,
  typedTags: string[],
): Promise<{
  found: boolean;
  label: string;
  tags: string[];
  groupIds: string[];
  companyId: string | null;
}> {
  if (!email) {
    return {
      found: false,
      label: "",
      tags: typedTags,
      groupIds: [],
      companyId: null,
    };
  }

  const customer = await db.customer.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
  });

  if (!customer) {
    return { found: false, label: email, tags: typedTags, groupIds: [], companyId: null };
  }

  return {
    found: true,
    label: customer.email ?? email,
    tags: [...new Set([...customer.tags, ...typedTags])],
    groupIds: customer.groupId ? [customer.groupId] : [],
    // Shopify's B2B purchasing-company GID is not mirrored — it arrives at
    // checkout on `cart.buyerIdentity.purchasingCompany` and nowhere else. So
    // a company-targeted rule genuinely cannot be answered here, and the view
    // says that instead of reporting `audience_mismatch`, which would be a
    // claim rather than an answer.
    companyId: null,
  };
}

/**
 * The product behind a variant, and the collections checkout sees it in.
 *
 * Read from the `$app:mannon.collections` metafield rather than from Shopify
 * directly, for the reason in ADR 0029: agreeing with the thing that charges
 * the buyer beats being right sooner.
 */
async function resolveProduct(
  admin: AdminGraphql,
  variantId: string,
): Promise<{
  found: boolean;
  variantId: string;
  productId: string;
  collectionIds: string[];
}> {
  const empty = { found: false, variantId, productId: variantId, collectionIds: [] };
  if (!variantId) return empty;

  const match = await variantById(admin, variantId);
  if (!match) return empty;

  return {
    found: true,
    variantId: match.id,
    productId: match.productId,
    collectionIds: match.collectionIds,
  };
}

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
  explainContext?: PricingSettingsView["explainContext"];
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
    explainContext: options.explainContext ?? null,
    explainInput: options.explainInput ?? {
      variantId: "",
      buyerEmail: "",
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
      const variantId = (form.get("variantId") ?? "").toString().trim();
      const buyerEmail = (form.get("buyerEmail") ?? "").toString().trim();
      const typedTags = (form.get("tags") ?? "")
        .toString()
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      const quantity = Number(form.get("quantity") ?? 1) || 1;
      const price = (form.get("price") ?? "0").toString().trim();

      const { rules } = await activeEngineRules();
      const currencyCode = await shopCurrency();

      // Resolved from the same places checkout reads, which is what makes the
      // sentence below true. It was not: the context was built with no groups,
      // no company, no collections, the variant id standing in for the product
      // id, and the *unit* price as the cart subtotal — so four of six audience
      // modes and two of four targeting modes answered wrongly, every time.
      const [buyer, product] = await Promise.all([
        resolveBuyer(buyerEmail, typedTags),
        resolveProduct(admin, variantId),
      ]);

      // The real engine over the real rules, with the context checkout has:
      // this answer is the checkout answer.
      const explain = explainFor(
        rules,
        {
          variantId: product.variantId || variantId,
          productId: product.productId,
          collectionIds: product.collectionIds,
          tags: buyer.tags,
          groupIds: buyer.groupIds,
          companyId: buyer.companyId,
          quantity,
          price,
        },
        currencyCode,
        new Date(),
      );

      return json({
        view: await buildView({
          explain,
          explainInput: {
            variantId,
            buyerEmail,
            tags: buyer.tags.join(", "),
            quantity: String(quantity),
            price,
          },
          explainContext: {
            buyerFound: buyer.found,
            buyerLabel: buyer.label,
            productFound: product.found,
            collectionCount: product.collectionIds.length,
            companyRules: rules.filter((rule) => rule.audience.mode === "companies")
              .length,
          },
        }),
      });
    }

    throw new Response("Unknown intent", { status: 400 });
  });

export default function PricingSettings() {
  // The action's view wins. A non-redirect action response re-runs the loader,
  // so reading only the loader's copy throws away everything the action just
  // computed — the validation errors, the report, the draft.
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <PricingSettingsPage view={view as PricingSettingsView} />;
}
