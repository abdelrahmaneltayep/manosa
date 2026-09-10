import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { WizardPage } from "~/components/setup/WizardPage";
import type { WizardPlanView, WizardView } from "~/components/setup/types";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate, type Translate } from "~/i18n/translate";
import { isAiAvailable } from "~/lib/ai/client.server";
import {
  draftSetupPlan,
  readSetupPlan,
  MAX_DESCRIPTION_CHARS,
  type SetupGrounding,
  type SetupPlan,
} from "~/lib/ai/prompts/setup-plan.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { db } from "~/db.server";
import { decodeEnvelope, encodeEnvelope } from "~/lib/setup/envelope.server";
import { RuleValidationError } from "~/lib/pricing/rules.server";
import { shopScope } from "~/lib/tenant/shop-context.server";
import { LimitReachedError } from "~/lib/billing/gate.server";
import { DuplicateGroupHandleError } from "~/lib/customers/groups.server";
import { parseMoney } from "@mannon/pricing-engine";

import { formatCurrency } from "~/lib/money";
import {
  applySetupPlan,
  PartialSetupError,
  setupGrounding,
} from "~/lib/setup/wizard.server";
import { withAdmin } from "~/shopify.server";

/**
 * ✦ Claude Setup Wizard.
 *
 * A few sentences in, a shop out — but only through the front door. The plan
 * travels back in a hidden field and is re-read by `readSetupPlan` before
 * anything is created, so an edited payload gets the same validation the
 * model's own answer got. Applying goes through `createGroup`, `createRule` and
 * `createForm`, which is why a wizard-built rule is published, limit-checked
 * and audited like any other.
 */

/** The rule, as one sentence the merchant can check. */
function ruleSummary(
  plan: SetupPlan,
  t: Translate,
  locale: string,
  currencyCode: string,
): string {
  const rule = plan.rule;
  if (!rule) return "";

  if (rule.kind === "percentage") {
    return t("wizard.rule.percentage", {
      percent: rule.percentage ?? 0,
      tag: rule.audienceTag,
    });
  }
  if (rule.kind === "amount_off") {
    return t("wizard.rule.amount_off", {
      amount: rule.amount
        ? formatCurrency(parseMoney(rule.amount, currencyCode), locale)
        : "",
      tag: rule.audienceTag,
    });
  }
  return t("wizard.rule.volume_tier", {
    count: rule.tiers.length,
    tag: rule.audienceTag,
  });
}

/**
 * How many buyers this rule would price for, today.
 *
 * The preview names a tag; a tag means nothing to a merchant on their first
 * morning. `wholesale` is the obvious tag for a model to propose and is the
 * default `Shop.wholesaleTag`, carried by every buyer the app has ever
 * approved — so "42 customers already carry this tag" is the difference
 * between a starter rule and a store-wide discount nobody asked for.
 */
async function audienceReach(tag: string): Promise<number> {
  return db.customer.count({
    where: { tags: { has: tag }, deletedInShopifyAt: null },
  });
}

async function planView(
  plan: SetupPlan,
  t: Translate,
  locale: string,
  currencyCode: string,
): Promise<WizardPlanView> {
  return {
    summary: plan.summary,
    groups: plan.groups,
    rule: plan.rule
      ? {
          name: plan.rule.name,
          summary: ruleSummary(plan, t, locale, currencyCode),
          audienceTag: plan.rule.audienceTag,
          reaches: await audienceReach(plan.rule.audienceTag),
        }
      : null,
    form: plan.form
      ? {
          name: plan.form.name,
          fields: plan.form.fields.map((key) => t(`wizard.field.${key}`)),
        }
      : null,
    notes: plan.notes,
  };
}

async function baseView(): Promise<{
  view: WizardView;
  grounding: SetupGrounding;
  currencyCode: string;
}> {
  const entitlements = await loadEntitlements();
  const entitled = hasFeature(entitlements, "merchant_agent");
  const keyed = isAiAvailable();
  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("setup wizard") },
  });

  return {
    grounding: await setupGrounding(),
    currencyCode: shop?.currencyCode ?? "USD",
    view: {
      available: entitled && keyed,
      locked: !entitled ? "plan" : !keyed ? "no_key" : null,
      description: "",
      plan: null,
      payload: "",
      failure: null,
      applied: null,
      partial: null,
    },
  };
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => json({ view: (await baseView()).view }));

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const intent = (form.get("intent") ?? "").toString();
    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));
    const { view: base, grounding, currencyCode } = await baseView();

    // Gated server-side: a shop without the plan or the key cannot reach the
    // model by posting to this route directly.
    if (!base.available) return json({ view: base }, { status: 402 });

    if (intent === "describe") {
      const description = (form.get("description") ?? "")
        .toString()
        .trim()
        .slice(0, MAX_DESCRIPTION_CHARS);

      if (!description) {
        return json({ view: { ...base, failure: "empty" as const } }, { status: 422 });
      }

      const drafted = await draftSetupPlan(
        { description, grounding, actorId: session.id },
        {},
      );

      if (!drafted.ok) {
        return json({ view: { ...base, description, failure: drafted.reason } });
      }

      return json({
        view: {
          ...base,
          description,
          plan: await planView(drafted.value, t, locale, currencyCode),
          // Signed, because the provenance in it becomes an audit entry saying
          // a model was involved — and an audit entry the client dictates is
          // not one. See app/lib/setup/envelope.server.ts.
          payload: encodeEnvelope({
            plan: drafted.value,
            model: drafted.model,
            promptVersion: drafted.promptVersion,
            requestId: drafted.requestId,
          }),
        },
      });
    }

    if (intent !== "apply") throw new Response("Unknown intent", { status: 400 });

    const payload = (form.get("payload") ?? "").toString();
    const envelope = decodeEnvelope(payload);
    if (!envelope) {
      return json(
        { view: { ...base, failure: "invalid_output" as const } },
        { status: 422 },
      );
    }

    // Read again, against this shop as it is now. A group created in another
    // tab — or by the first half of a run that failed — is a group this plan no
    // longer proposes, and its tag is still one the rule may be aimed at.
    const reread = readSetupPlan(envelope.plan, grounding);
    if (!reread.ok) {
      return json(
        { view: { ...base, failure: "invalid_output" as const } },
        { status: 422 },
      );
    }

    /** The preview, kept, so a failure leaves the merchant somewhere to stand. */
    const withPlan = async () => ({
      ...base,
      plan: await planView(reread.value, t, locale, currencyCode),
      payload,
    });

    try {
      const applied = await applySetupPlan(reread.value, {
        admin,
        approvedById: session.id,
        t,
        currencyCode,
        ai: {
          model: envelope.model,
          promptVersion: envelope.promptVersion,
          requestId: envelope.requestId,
        },
      });

      return json({
        view: {
          ...base,
          applied: {
            links: [
              { label: t("wizard.link.groups"), href: "/app/customers/groups" },
              ...(applied.ruleId
                ? [
                    {
                      label: t("wizard.link.rule"),
                      href: `/app/pricing/${applied.ruleId}`,
                    },
                  ]
                : []),
              ...(applied.formId
                ? [{ label: t("wizard.link.form"), href: `/app/forms/${applied.formId}` }]
                : []),
            ],
            formDraft: applied.formId !== null,
          },
        },
      });
    } catch (error) {
      // A run that stopped part way still changed the shop. The merchant is
      // told what exists and keeps the preview, so pressing the button again
      // picks up where it stopped rather than starting from nothing.
      const partial =
        error instanceof PartialSetupError
          ? {
              groups: error.applied.groups.length,
              rule: error.applied.ruleId !== null,
              form: error.applied.formId !== null,
            }
          : null;
      const cause = error instanceof PartialSetupError ? error.reason : error;

      // Each of these is the merchant's own shop telling us something true —
      // a plan limit, a group that already exists, a rule the engine will not
      // accept. None of them is an error page.
      const failure =
        cause instanceof LimitReachedError
          ? ("limit" as const)
          : cause instanceof DuplicateGroupHandleError
            ? ("duplicate" as const)
            : cause instanceof RuleValidationError
              ? ("invalid_rule" as const)
              : null;

      if (!failure) throw error;
      return json({ view: { ...(await withPlan()), failure, partial } }, { status: 422 });
    }
  });

export default function Setup() {
  // The action's view wins: a plan lives only in its reply.
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <WizardPage view={view as WizardView} />;
}
