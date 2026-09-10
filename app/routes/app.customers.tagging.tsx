import { parseMoney } from "@mannon/pricing-engine";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { TagRulesPage } from "~/components/customers/TagRulesPage";
import type { TagRuleListView } from "~/components/customers/types";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import { loadEntitlements } from "~/lib/billing/entitlements.server";
import { hasFeature } from "~/lib/billing/entitlements.server";
import { isPlanGateError } from "~/lib/billing/gate.server";
import { lowestPlanWithFeature } from "~/lib/billing/plans";
import { shopSettings } from "~/lib/customers/customers.server";
import {
  createTagRule,
  deleteTagRule,
  listTagRules,
  previewTagRules,
  runTagSweep,
  TagRuleValidationError,
} from "~/lib/customers/tag-rules.server";
import type { TagCondition } from "~/lib/customers/tagging";
import { displayName, toTagRuleRowView } from "~/lib/customers/view-model.server";
import { withAdmin } from "~/shopify.server";

/** How many examples the preview shows. Enough to check, not a second list. */
const PREVIEW_SAMPLES = 5;

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const t = await getFixedT(detectLocale(request));
    const now = new Date();

    const [rules, entitlements] = await Promise.all([
      listTagRules(),
      loadEntitlements(now),
    ]);
    const locked = !hasFeature(entitlements, "auto_tagging");

    const wantsPreview = url.searchParams.get("preview") === "1";
    const preview = wantsPreview && !locked ? await previewTagRules(now) : null;

    const view: TagRuleListView = {
      rows: rules.map((rule) => toTagRuleRowView(rule, translate(t))),
      locked,
      requiredPlan: locked ? lowestPlanWithFeature("auto_tagging") : null,
      preview: preview
        ? {
            examined: preview.result.examined,
            changed: preview.result.changed,
            samples: preview.decisions.slice(0, PREVIEW_SAMPLES).map((entry) => ({
              name: displayName(entry.customer, translate(t)),
              add: entry.decision.add,
              remove: entry.decision.remove,
            })),
          }
        : null,
      lastRun: url.searchParams.has("changed")
        ? {
            changed: Number(url.searchParams.get("changed") ?? 0),
            failed: Number(url.searchParams.get("failed") ?? 0),
            examined: Number(url.searchParams.get("examined") ?? 0),
          }
        : null,
      issues: url.searchParams.get("error") === "invalid" ? [{ code: "no_tags" }] : [],
    };

    return json({ view });
  });

/** One condition from the simple builder. The full editor lands with 4.3. */
function conditionFrom(form: FormData, currencyCode: string): TagCondition | null {
  const field = (form.get("field") ?? "").toString();
  const op = (form.get("op") ?? "gte").toString() === "lte" ? "lte" : "gte";
  const value = (form.get("value") ?? "").toString().trim();

  if (!value) return null;

  switch (field) {
    case "lifetime_spend":
      try {
        return { field, op, amount: parseMoney(value, currencyCode) };
      } catch {
        return null;
      }
    case "order_count":
    case "days_since_last_order": {
      const count = Number(value);
      return Number.isFinite(count) ? { field, op, value: count } : null;
    }
    case "country":
      return {
        field: "country",
        op: op === "lte" ? "not_in" : "in",
        values: value
          .split(",")
          .map((code) => code.trim().toUpperCase())
          .filter(Boolean),
      };
    default:
      return null;
  }
}

const tagList = (value: FormDataEntryValue | null) =>
  (value ?? "")
    .toString()
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const intent = form.get("intent");
    const actor = { type: "STAFF" as const, id: session.id };

    try {
      if (intent === "preview") return redirect("/app/customers/tagging?preview=1");

      if (intent === "run") {
        const result = await runTagSweep(admin, actor);
        return redirect(
          `/app/customers/tagging?changed=${result.changed}&failed=${result.failed}&examined=${result.examined}`,
        );
      }

      if (intent === "create") {
        const { currencyCode } = await shopSettings();
        const condition = conditionFrom(form, currencyCode);

        await createTagRule(
          {
            name: (form.get("name") ?? "").toString(),
            // A rule with no readable condition is created with none, which
            // makes it match nobody — the engine refuses to treat "I could not
            // read this" as "everyone".
            conditions: condition ? [condition] : [],
            addTags: tagList(form.get("addTags")),
            removeTags: tagList(form.get("removeTags")),
          },
          actor,
        );
        return redirect("/app/customers/tagging");
      }

      if (intent === "delete") {
        const ruleId = (form.get("ruleId") ?? "").toString();
        if (!ruleId) throw new Response("Missing rule", { status: 400 });
        await deleteTagRule(ruleId, actor);
        return redirect("/app/customers/tagging");
      }
    } catch (error) {
      if (error instanceof TagRuleValidationError) {
        return redirect("/app/customers/tagging?error=invalid");
      }
      // The plan gate is the enforcement, and this is what a merchant who
      // reached the action without the plan sees.
      if (isPlanGateError(error)) return redirect("/app/customers/tagging");
      throw error;
    }

    throw new Response("Unknown intent", { status: 400 });
  });

export default function CustomerTagging() {
  const { view } = useLoaderData<typeof loader>();
  return <TagRulesPage view={view as TagRuleListView} />;
}
