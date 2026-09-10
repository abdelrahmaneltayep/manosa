import {
  evaluateLimits,
  renderMessage,
  type CartFacts,
  type MessageKey,
} from "@mannon/order-limits";
import { formatMoney, money, parseMoney } from "@mannon/pricing-engine";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { LimitsPage } from "~/components/orders/LimitsPage";
import type { LimitFormView, LimitsView } from "~/components/orders/types";
import { db } from "~/db.server";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate, type Translate } from "~/i18n/translate";
import { isPlanGateError } from "~/lib/billing/gate.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { lowestPlanWithFeature } from "~/lib/billing/plans";
import { formatCurrency } from "~/lib/money";
import {
  deleteLimit,
  issuesFor,
  LimitValidationError,
  listLimits,
  messageTemplates,
  saveLimit,
  toEngineLimit,
  type LimitInput,
} from "~/lib/orders/limits.server";
import { toLimitRowView } from "~/lib/orders/view-model.server";
import { withAdmin } from "~/shopify.server";

/** The example the empty state uses, in minor units: 200.00. */
const EXAMPLE_MINIMUM = 20_000;

const asString = (form: FormData, key: string) => (form.get(key) ?? "").toString().trim();

/**
 * A typed amount as minor units.
 *
 * Empty means "no bound", which is not the same as zero: a minimum of zero is a
 * limit that always passes, and storing one where the merchant meant "none"
 * would show them a limit they did not write.
 */
function toMinorUnits(value: string, currencyCode: string): number | null {
  const text = value.trim();
  if (!text) return null;
  try {
    return parseMoney(text, currencyCode).amount;
  } catch {
    // An unparseable amount is not silently dropped — `issuesFor` sees the
    // negative and refuses the save.
    return -1;
  }
}

function toWholeNumber(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : -1;
}

function inputFromForm(form: FormData, currencyCode: string): LimitInput {
  return {
    groupId: asString(form, "groupId") || null,
    enabled: form.get("enabled") !== null,
    minSubtotal: toMinorUnits(asString(form, "minSubtotal"), currencyCode),
    maxSubtotal: toMinorUnits(asString(form, "maxSubtotal"), currencyCode),
    minQuantity: toWholeNumber(asString(form, "minQuantity")),
    maxQuantity: toWholeNumber(asString(form, "maxQuantity")),
    quantityIncrement: toWholeNumber(asString(form, "quantityIncrement")),
    countries: asString(form, "countries")
      .split(/[,\s]+/)
      .filter(Boolean),
  };
}

function formFromInput(
  input: LimitInput,
  id: string | null,
  currencyCode: string,
): LimitFormView {
  const asDecimal = (value: number | null) =>
    value === null || value < 0 ? "" : formatMoney(money(value, currencyCode));

  return {
    id,
    groupId: input.groupId ?? "",
    enabled: input.enabled ?? true,
    minSubtotal: asDecimal(input.minSubtotal),
    maxSubtotal: asDecimal(input.maxSubtotal),
    minQuantity: input.minQuantity === null ? "" : String(input.minQuantity),
    maxQuantity: input.maxQuantity === null ? "" : String(input.maxQuantity),
    quantityIncrement:
      input.quantityIncrement === null ? "" : String(input.quantityIncrement),
    countries: input.countries.join(", "),
  };
}

/**
 * What a buyer would be told, from the same module the checkout runs.
 *
 * The merchant is checking that the number in the message is the number they
 * set. Composing the sentence here from a second copy of the rules would defeat
 * the point of the preview entirely.
 */
async function previewFor(
  rows: Awaited<ReturnType<typeof listLimits>>,
  currencyCode: string,
  t: Translate,
  locale: string,
) {
  const active = rows.find((row) => row.enabled && row.minSubtotal !== null);
  if (!active || active.minSubtotal === null) return null;

  // A cart at half the minimum: enough to show a real gap rather than a zero.
  const half = Math.floor(active.minSubtotal / 2);
  const facts: CartFacts = {
    subtotal: money(half, currencyCode),
    totalQuantity: 1,
    groupIds: active.groupId ? [active.groupId] : [],
    tags: [],
    countryCode: active.countries[0] ?? null,
    isPos: false,
    isAuthenticated: true,
  };

  const verdict = evaluateLimits([toEngineLimit(active, currencyCode)], facts);
  const violation = verdict.violations[0];
  if (!violation) return null;

  const templates = await messageTemplates();
  const asText = (value: { amount: number; currencyCode: string } | number) =>
    typeof value === "number"
      ? String(value)
      : formatCurrency(money(value.amount, value.currencyCode), locale);

  return {
    heading: t("limits.previewCart", {
      amount: formatCurrency(money(half, currencyCode), locale),
    }),
    message: renderMessage(templates[violation.code as MessageKey], {
      gap: asText(violation.gap),
      required: asText(violation.required),
      actual: asText(violation.actual),
    }),
  };
}

async function buildView(
  request: Request,
  overrides: { form?: LimitFormView | null; issues?: LimitsView["issues"] } = {},
): Promise<LimitsView> {
  const url = new URL(request.url);
  const locale = detectLocale(request);
  const t = translate(await getFixedT(locale));
  const shopName = url.searchParams.get("__never") ?? "";
  void shopName;

  const [rows, groups, record, entitlements] = await Promise.all([
    listLimits(),
    db.customerGroup.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
    db.shop.findFirst(),
    loadEntitlements(),
  ]);

  const currencyCode = record?.currencyCode ?? "USD";
  const groupNames = new Map(groups.map((group) => [group.id, group.name]));

  const editId = url.searchParams.get("edit");
  const editing = editId ? rows.find((row) => row.id === editId) : undefined;

  const form =
    overrides.form !== undefined
      ? overrides.form
      : editing
        ? formFromInput(
            {
              groupId: editing.groupId,
              enabled: editing.enabled,
              minSubtotal: editing.minSubtotal,
              maxSubtotal: editing.maxSubtotal,
              minQuantity: editing.minQuantity,
              maxQuantity: editing.maxQuantity,
              quantityIncrement: editing.quantityIncrement,
              countries: editing.countries,
            },
            editing.id,
            currencyCode,
          )
        : null;

  return {
    rows: rows.map((row) =>
      toLimitRowView(row, {
        t,
        currencyCode,
        locale,
        groupName: row.groupId ? (groupNames.get(row.groupId) ?? null) : null,
      }),
    ),
    groups,
    form,
    issues: overrides.issues ?? [],
    currencyCode,
    exampleMinimum: formatCurrency(money(EXAMPLE_MINIMUM, currencyCode), locale),
    posBypassesLimits: record?.posBypassesLimits ?? true,
    entitled: hasFeature(entitlements, "order_limits"),
    requiredPlan: lowestPlanWithFeature("order_limits"),
    publishedAt: record?.limitsPublishedAt?.toISOString() ?? null,
    preview: await previewFor(rows, currencyCode, t, locale),
  };
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => json({ view: await buildView(request) }));

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const intent = asString(form, "intent");
    const actor = { type: "STAFF" as const, id: session.id };

    if (intent === "posBypass") {
      await db.shop.update({
        where: { shop: session.shop },
        data: { posBypassesLimits: form.get("posBypassesLimits") !== null },
      });
      return redirect("/app/orders/limits");
    }

    if (intent === "delete") {
      await deleteLimit(asString(form, "id"), { admin, actor });
      return redirect("/app/orders/limits");
    }

    if (intent !== "save") throw new Response("Unknown intent", { status: 400 });

    const record = await db.shop.findUnique({ where: { shop: session.shop } });
    const currencyCode = record?.currencyCode ?? "USD";
    const id = asString(form, "id") || null;
    const input = inputFromForm(form, currencyCode);

    try {
      await saveLimit(input, { admin, actor });
    } catch (error) {
      if (error instanceof LimitValidationError) {
        // Straight back to the page with what was typed still in it — a form
        // that empties itself on a validation error loses the merchant's work.
        return json(
          {
            view: await buildView(request, {
              form: formFromInput(input, id, currencyCode),
              issues: error.issues,
            }),
          },
          { status: 422 },
        );
      }
      if (isPlanGateError(error)) {
        return json(
          {
            view: await buildView(request, {
              form: formFromInput(input, id, currencyCode),
              issues: issuesFor(input, currencyCode),
            }),
          },
          { status: 402 },
        );
      }
      throw error;
    }

    return redirect("/app/orders/limits");
  });

export default function OrderLimitsRoute() {
  // The action's view wins when there is one: a no-JS document POST re-runs the
  // loader, and reading only the loader's copy throws away the failed form.
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <LimitsPage view={view as LimitsView} />;
}
