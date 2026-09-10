import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { RuleBuilderPage } from "~/components/pricing/RuleBuilderPage";
import type { RuleBuilderView } from "~/components/pricing/types";
import { db } from "~/db.server";
import { isPlanGateError } from "~/lib/billing/gate.server";
import { parseRuleForm } from "~/lib/pricing/rule-form.server";
import {
  createRule,
  findDuplicateName,
  RuleValidationError,
} from "~/lib/pricing/rules.server";
import { emptyFormView, previewFor } from "~/lib/pricing/view-model.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { withAdmin } from "~/shopify.server";

async function shopCurrency(): Promise<string> {
  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("currency") },
  });
  return shop?.currencyCode ?? "USD";
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const view: RuleBuilderView = {
      form: emptyFormView(await shopCurrency()),
      issues: [],
      duplicateName: null,
      preview: null,
      conflict: null,
      saving: false,
    };
    return json({ view });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const currencyCode = await shopCurrency();
    const now = new Date();

    const parsed = parseRuleForm(form, { currencyCode });
    const duplicate = await findDuplicateName(parsed.rule.name);

    if (form.get("intent") === "prefill") {
      // ✦ Describe a rule hands its draft to the builder, filled in. Nothing is
      // saved: the merchant lands on the same form, one Save from the same
      // validation and the same audit entry as a rule they typed themselves.
      return json({
        view: {
          form: { ...emptyFormView(currencyCode), ...formEcho(form, currencyCode) },
          issues: parsed.issues,
          duplicateName: duplicate?.name ?? null,
          preview: previewFor(parsed.rule, currencyCode, now),
          conflict: null,
          saving: false,
        } satisfies RuleBuilderView,
      });
    }

    if (parsed.issues.length > 0) {
      // Come back with what they typed, errors beside the fields that caused
      // them. Losing a half-built rule to a validation error is unforgivable.
      return json(
        {
          view: {
            form: { ...emptyFormView(currencyCode), ...formEcho(form, currencyCode) },
            issues: parsed.issues,
            duplicateName: duplicate?.name ?? null,
            preview: previewFor(parsed.rule, currencyCode, now),
            conflict: null,
            saving: false,
          } satisfies RuleBuilderView,
        },
        { status: 422 },
      );
    }

    try {
      const created = await createRule(parsed.rule, {
        admin,
        actor: { type: "STAFF", id: session.id },
      });
      return redirect(`/app/pricing/${created.id}?saved=1`);
    } catch (error) {
      if (error instanceof RuleValidationError) {
        // The whole form back, errors beside the fields. A bare list of codes
        // would render an empty builder and lose what they typed.
        return json(
          {
            view: {
              form: { ...emptyFormView(currencyCode), ...formEcho(form, currencyCode) },
              issues: error.issues,
              duplicateName: duplicate?.name ?? null,
              preview: null,
              conflict: null,
              saving: false,
            } satisfies RuleBuilderView,
          },
          { status: 422 },
        );
      }
      if (isPlanGateError(error)) {
        return redirect("/app/plans?from=pricing");
      }
      throw error;
    }
  });

/** Give the merchant back exactly what they typed. */
function formEcho(form: FormData, currencyCode: string) {
  const get = (key: string) => (form.get(key) ?? "").toString();

  return {
    name: get("name"),
    status: (get("status") || "draft") as "draft" | "active",
    kind: (get("kind") || "percentage") as RuleBuilderView["form"]["kind"],
    priority: Number(get("priority")) || 100,
    combinable: get("combinable") === "on",
    percentage: get("percentage"),
    amount: get("amount"),
    cartMinimum: get("cartMinimum"),
    tiers: form.getAll("tierMin").map((min, index) => ({
      minQuantity: min.toString(),
      maxQuantity: (form.getAll("tierMax")[index] ?? "").toString(),
      kind: ((form.getAll("tierKind")[index] ?? "percentage").toString() ??
        "percentage") as "percentage" | "amount_off" | "fixed_price",
      value: (form.getAll("tierValue")[index] ?? "").toString(),
    })),
    targetMode: get("targetMode") || "all",
    targetCollectionIds: get("targetCollectionIds"),
    targetProductIds: get("targetProductIds"),
    targetVariantIds: get("targetVariantIds"),
    excludeCollectionIds: get("excludeCollectionIds"),
    audienceMode: get("audienceMode") || "tags",
    audienceTags: get("audienceTags"),
    audienceCustomerIds: get("audienceCustomerIds"),
    audienceCompanyIds: get("audienceCompanyIds"),
    startsAt: get("startsAt"),
    endsAt: get("endsAt"),
    currencyCode,
  };
}

export default function NewRule() {
  // The action's view wins. A non-redirect action response re-runs the loader,
  // so reading only the loader's copy throws away everything the action just
  // computed — the validation errors, the report, the draft.
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <RuleBuilderPage view={view as RuleBuilderView} />;
}
