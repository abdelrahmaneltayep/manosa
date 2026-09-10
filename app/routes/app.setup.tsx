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
import { LimitReachedError } from "~/lib/billing/gate.server";
import { DuplicateGroupHandleError } from "~/lib/customers/groups.server";
import { formatCurrency } from "~/lib/money";
import { applySetupPlan, setupGrounding } from "~/lib/setup/wizard.server";
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

/** What the plan carries between requests, with its provenance. */
interface WizardEnvelope {
  plan: unknown;
  model: string;
  promptVersion: string;
  requestId: string | null;
}

const encode = (envelope: WizardEnvelope) => JSON.stringify(envelope);

function decode(raw: string): WizardEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const envelope = parsed as Partial<WizardEnvelope>;
    // No provenance, no apply: the audit entry has to name what read this.
    if (typeof envelope.model !== "string" || envelope.model === "") return null;
    return {
      plan: envelope.plan,
      model: envelope.model,
      promptVersion: String(envelope.promptVersion ?? ""),
      requestId: typeof envelope.requestId === "string" ? envelope.requestId : null,
    };
  } catch {
    return null;
  }
}

/** The rule, as one sentence the merchant can check. */
function ruleSummary(plan: SetupPlan, t: Translate, locale: string): string {
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
      amount: rule.amount ? formatCurrency(rule.amount, locale) : "",
      tag: rule.audienceTag,
    });
  }
  return t("wizard.rule.volume_tier", {
    count: rule.tiers.length,
    tag: rule.audienceTag,
  });
}

function planView(plan: SetupPlan, t: Translate, locale: string): WizardPlanView {
  return {
    summary: plan.summary,
    groups: plan.groups,
    rule: plan.rule
      ? { name: plan.rule.name, summary: ruleSummary(plan, t, locale) }
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

async function baseView(): Promise<{ view: WizardView; grounding: SetupGrounding }> {
  const entitlements = await loadEntitlements();
  const entitled = hasFeature(entitlements, "merchant_agent");
  const keyed = isAiAvailable();

  return {
    grounding: await setupGrounding(),
    view: {
      available: entitled && keyed,
      locked: !entitled ? "plan" : !keyed ? "no_key" : null,
      description: "",
      plan: null,
      payload: "",
      failure: null,
      applied: null,
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
    const { view: base, grounding } = await baseView();

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
          plan: planView(drafted.value, t, locale),
          payload: encode({
            plan: drafted.value,
            model: drafted.model,
            promptVersion: drafted.promptVersion,
            requestId: drafted.requestId,
          }),
        },
      });
    }

    if (intent !== "apply") throw new Response("Unknown intent", { status: 400 });

    const envelope = decode((form.get("payload") ?? "").toString());
    if (!envelope) {
      return json(
        { view: { ...base, failure: "invalid_output" as const } },
        { status: 422 },
      );
    }

    // Read again, against this shop as it is now. A group created in another
    // tab between the preview and the click is a group this plan no longer
    // proposes.
    const reread = readSetupPlan(envelope.plan, grounding);
    if (!reread.ok) {
      return json(
        { view: { ...base, failure: "invalid_output" as const } },
        { status: 422 },
      );
    }

    try {
      const applied = await applySetupPlan(reread.value, {
        admin,
        approvedById: session.id,
        t,
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
      // Both of these are the merchant's shop telling us something true: a
      // plan limit, or a group that already exists under that handle. Neither
      // is an error page.
      if (error instanceof LimitReachedError) {
        return json({ view: { ...base, failure: "limit" as const } }, { status: 422 });
      }
      if (error instanceof DuplicateGroupHandleError) {
        return json(
          { view: { ...base, failure: "duplicate" as const } },
          { status: 422 },
        );
      }
      throw error;
    }
  });

export default function Setup() {
  // The action's view wins: a plan lives only in its reply.
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <WizardPage view={view as WizardView} />;
}
