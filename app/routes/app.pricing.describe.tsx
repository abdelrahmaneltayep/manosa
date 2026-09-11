import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";

import { DescribeRulePage } from "~/components/pricing/DescribeRulePage";
import type { DescribeRuleView } from "~/components/pricing/types";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate, type Translate } from "~/i18n/translate";
import { aiGate, requireAi } from "~/lib/ai/permissions.server";
import { draftRuleFromSentence } from "~/lib/ai/prompts/rule-from-sentence.server";
import { recordAudit } from "~/lib/audit/record.server";
import { loadEntitlements } from "~/lib/billing/entitlements.server";
import { isPlanGateError } from "~/lib/billing/gate.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import {
  clarificationViews,
  describeView,
  draftCard,
  marginView,
} from "~/lib/pricing/describe-view.server";
import {
  decodeDraft,
  envelopeFor,
  loadGrounding,
  prepareDraft,
  shopCurrency,
  type DraftEnvelope,
} from "~/lib/pricing/describe.server";
import { checkMargins } from "~/lib/pricing/margin-guard.server";
import { createRule, RuleValidationError } from "~/lib/pricing/rules.server";
import { db } from "~/db.server";
import { withAdmin } from "~/shopify.server";

/**
 * ✦ Describe a rule.
 *
 * Claude drafts; the merchant approves. Every path through this route respects
 * that: the model's answer becomes a card, the card is re-derived from its own
 * inputs on every round trip, and the only write is `approve` — which goes
 * through `createRule` exactly as the manual builder does, with an audit entry
 * naming the person who pressed it.
 *
 * The margin guard runs before that button does anything, and a rule that
 * sells below cost needs the merchant to say so out loud.
 */

async function atRuleLimit(now: Date): Promise<boolean> {
  const entitlements = await loadEntitlements(now);
  const limit = entitlements.limits.pricingRules;
  if (limit === null) return false;

  const active = await db.pricingRule.count({ where: { archivedAt: null } });
  return active >= limit;
}

export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const t = translate(await getFixedT(detectLocale(request)));

    return json({
      view: describeView({
        aiAvailable: (await aiGate("draft")).allowed,
        sentence: "",
        atRuleLimit: await atRuleLimit(new Date()),
        t,
      }),
    });
  });

/** Draft → chips or guard → card. Shared by `draft` and `answer`. */
async function cardFor(
  admin: AdminGraphql,
  envelope: DraftEnvelope,
  options: {
    currencyCode: string;
    locale: string;
    now: Date;
    t: Translate;
    aiAvailable: boolean;
    atRuleLimit: boolean;
    approveAnywayMissing?: boolean;
  },
): Promise<DescribeRuleView> {
  const grounding = await loadGrounding(admin, options.currencyCode);
  const prepared = prepareDraft(envelope, grounding, options.now);

  // A rule whose targets are still a question cannot be priced against a
  // catalogue — checking it would report on the wrong products.
  const margin =
    prepared.clarifications.length > 0
      ? null
      : marginView(
          await checkMargins(admin, prepared.rule, {
            currencyCode: options.currencyCode,
            now: options.now,
          }),
          options.locale,
        );

  return describeView({
    aiAvailable: options.aiAvailable,
    sentence: envelope.sentence,
    atRuleLimit: options.atRuleLimit,
    t: options.t,
    draft: draftCard(prepared.envelope, prepared.rule, options.currencyCode, options.t),
    clarifications: clarificationViews(prepared.clarifications),
    margin,
    approveAnywayMissing: options.approveAnywayMissing,
  });
}

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ admin, session }) => {
    const form = await request.formData();
    const intent = (form.get("intent") ?? "").toString();
    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));
    const now = new Date();

    if (intent === "discard") return redirect("/app/pricing");

    const aiAvailable = (await aiGate("draft")).allowed;
    const currencyCode = await shopCurrency();
    const limited = await atRuleLimit(now);
    const common = { aiAvailable, atRuleLimit: limited, t };

    if (intent === "draft") {
      // Enforcement, not the disabled button. This route used to compute
      // `aiAvailable` for the view and call the model regardless.
      await requireAi("draft");
      const sentence = (form.get("sentence") ?? "").toString().trim();

      if (!sentence) {
        return json(
          { view: describeView({ ...common, sentence: "", failure: "empty" }) },
          { status: 422 },
        );
      }

      const grounding = await loadGrounding(admin, currencyCode);
      const result = await draftRuleFromSentence({
        sentence,
        grounding,
        actorId: session.id,
        now,
      });

      if (!result.ok) {
        return json(
          { view: describeView({ ...common, sentence, failure: result.reason }) },
          { status: 200 },
        );
      }

      const envelope = envelopeFor(sentence, result.value, {
        model: result.model,
        promptVersion: result.promptVersion,
        requestId: result.requestId,
      });

      // Logged the moment it exists, with the sentence that made it — checklist
      // §2, "every generated rule logged with the prompt that made it". It
      // changed nothing live, so it carries no approval and is not aiAssisted.
      await recordAudit({
        actor: { type: "STAFF", id: session.id },
        action: "pricing_rule.drafted",
        summary: `Claude drafted the pricing rule “${result.value.rule.name}” from a sentence.`,
        ai: {
          model: result.model,
          promptVersion: result.promptVersion,
          requestId: result.requestId,
        },
        metadata: { sentence, kind: result.value.rule.kind },
      });

      return json({
        view: await cardFor(admin, envelope, {
          currencyCode,
          locale,
          now,
          ...common,
        }),
      });
    }

    const envelope = decodeDraft((form.get("draft") ?? "").toString());
    if (!envelope) {
      return json(
        { view: describeView({ ...common, sentence: "", failure: "invalid_output" }) },
        { status: 422 },
      );
    }

    if (intent === "answer") {
      const term = (form.get("term") ?? "").toString();
      const choice = (form.get("choice") ?? "").toString();
      const answered: DraftEnvelope = {
        ...envelope,
        choices: { ...envelope.choices, ...(term && choice ? { [term]: choice } : {}) },
      };

      return json({
        view: await cardFor(admin, answered, { currencyCode, locale, now, ...common }),
      });
    }

    if (intent !== "approve") throw new Response("Unknown intent", { status: 400 });

    const grounding = await loadGrounding(admin, currencyCode);
    const prepared = prepareDraft(envelope, grounding, now);

    if (prepared.clarifications.length > 0) {
      return json(
        {
          view: await cardFor(admin, envelope, { currencyCode, locale, now, ...common }),
        },
        { status: 422 },
      );
    }

    // Checked again here rather than trusted from the page: the guard's answer
    // is what the "approve anyway" tick refers to, so it has to be this
    // request's answer, not one the browser sent back.
    const guard = await checkMargins(admin, prepared.rule, { currencyCode, now });
    const belowCost = guard.report?.belowCost.length ?? 0;
    const approveAnyway = form.get("approveAnyway") === "1";

    if (belowCost > 0 && !approveAnyway) {
      return json(
        {
          view: describeView({
            ...common,
            sentence: envelope.sentence,
            draft: draftCard(envelope, prepared.rule, currencyCode, t),
            clarifications: [],
            margin: marginView(guard, locale),
            approveAnywayMissing: true,
          }),
        },
        { status: 422 },
      );
    }

    try {
      const created = await createRule(prepared.rule, {
        admin,
        actor: { type: "STAFF", id: session.id },
        provenance: {
          ai: envelope.provenance,
          approvedById: session.id,
          metadata: {
            sentence: envelope.sentence,
            belowCostSkus: belowCost,
            approvedAnyway: belowCost > 0,
            marginGuard: guard.status,
          },
        },
      });

      return redirect(`/app/pricing/${created.id}?saved=1`);
    } catch (error) {
      if (error instanceof RuleValidationError) {
        return json(
          {
            view: describeView({
              ...common,
              sentence: envelope.sentence,
              failure: "invalid_output",
            }),
          },
          { status: 422 },
        );
      }
      if (isPlanGateError(error)) return redirect("/app/plans?from=pricing");
      throw error;
    }
  });

export default function DescribeRule() {
  // The action's view wins. A non-redirect action response re-runs the loader,
  // so reading only the loader's copy throws away everything the action just
  // computed — the validation errors, the report, the draft.
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const { view } = actionData ?? loaderData;
  return <DescribeRulePage view={view as DescribeRuleView} />;
}
