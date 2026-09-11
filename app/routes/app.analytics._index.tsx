import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import { AnalyticsPage } from "~/components/analytics/AnalyticsPage";
import type { AnalyticsView, AskView } from "~/components/analytics/types";
import { aiGate } from "~/lib/ai/permissions.server";
import { askYourData } from "~/lib/analytics/ask.server";
import { ensureMonthlyReviewScheduled } from "~/lib/jobs/handlers/monthly-review.server";
import { hasFeature, loadEntitlements } from "~/lib/billing/entitlements.server";
import { lowestPlanWithFeature } from "~/lib/billing/plans";
import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import { DEFAULT_RANGE, isRange, loadAnalytics } from "~/lib/analytics/charts.server";
import {
  analyticsView,
  exampleView,
  hasAnyData,
} from "~/lib/analytics/view-model.server";
import { withAdmin } from "~/shopify.server";

/**
 * Seven charts, in the shop's own currency and the shop's own day.
 *
 * Not plan-gated: §7 lists these charts under parity, not under a paid tier —
 * a merchant cannot decide whether to pay for wholesale features without
 * seeing what their wholesale is doing. The two ✦ analytics features (6.3)
 * gate on `merchant_agent`.
 *
 * A shop that has never sold wholesale sees a worked example rather than seven
 * empty boxes — labelled twice and washed out, and with its CSV export off, so
 * those numbers can never leave the screen as if they were real.
 */
export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));

    const asked = Number(url.searchParams.get("range") ?? DEFAULT_RANGE);
    const range = isRange(asked) ? asked : DEFAULT_RANGE;

    const data = await loadAnalytics({ range, labels: chartLabels(t) });
    const view = analyticsView(data, { locale, t });

    // A shop that installed before the review shipped starts getting one the
    // first time somebody looks at their numbers, rather than never.
    await ensureMonthlyReviewScheduled();

    const real = await hasAnyData(data);
    return json({
      view: real ? view : exampleView(view, locale),
      ask: await askView({ question: "", reply: null }),
    });
  });

export const chartLabels = (t: ReturnType<typeof translate>) => ({
  rest: t("analytics.rest"),
  retail: t("analytics.revenue.retailLabel"),
  ungrouped: t("analytics.ungrouped"),
  unnamedBuyer: t("customers.list.unnamed"),
});

/** What the ask bar can do here, and why not when it cannot. */
async function askView(
  answered: Partial<AskView> & { question: string; reply: string | null },
): Promise<AskView> {
  const entitlements = await loadEntitlements();
  const entitled = hasFeature(entitlements, "merchant_agent");
  const key = (await aiGate("draft")).allowed;

  return {
    available: entitled && key,
    locked: !entitled ? "plan" : key ? null : "no_key",
    requiredPlan: entitled ? null : lowestPlanWithFeature("merchant_agent"),
    chart: null,
    href: null,
    insteadTry: [],
    nothingToAnswer: false,
    pending: false,
    failure: null,
    ...answered,
  };
}

export const action = ({ request }: ActionFunctionArgs) =>
  withAdmin(request, async ({ session }) => {
    const form = await request.formData();
    if (form.get("intent") !== "ask") {
      throw new Response("Unknown intent", { status: 400 });
    }

    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));
    const question = (form.get("question") ?? "").toString().trim().slice(0, 300);

    const url = new URL(request.url);
    const asked = Number(url.searchParams.get("range") ?? DEFAULT_RANGE);
    const range = isRange(asked) ? asked : DEFAULT_RANGE;

    const data = await loadAnalytics({ range, labels: chartLabels(t) });
    const view = analyticsView(data, { locale, t });
    const real = await hasAnyData(data);

    // Gated server-side, like every other AI surface here. A disabled field is
    // a courtesy; this route is one POST away from anybody with a session.
    const base = await askView({ question, reply: null });
    if (!base.available || question === "") {
      return json({ view: real ? view : exampleView(view, locale), ask: base });
    }

    const answer = await askYourData({
      question,
      locale,
      t,
      labels: chartLabels(t),
      actorId: session.id,
      loaded: { range, data },
    });

    return json({
      view: real ? view : exampleView(view, locale),
      ask: {
        ...base,
        reply: answer.reply,
        chart: answer.chart,
        href: answer.href,
        insteadTry: answer.insteadTry,
        nothingToAnswer: answer.nothingToAnswer,
        failure: answer.failure,
      },
    });
  });

export default function Analytics() {
  // A non-redirect action re-runs the loader, so the action's view is the
  // fresher of the two whenever there is one.
  const answered = useActionData<typeof action>();
  const loaded = useLoaderData<typeof loader>();
  const { view, ask } = answered ?? loaded;
  // The range picker does a full navigation against a loader that runs seven
  // queries, so there is a real moment with nothing on screen. `useNavigation`
  // is how Remix says "that moment is now".
  const navigation = useNavigation();
  const loading = navigation.state === "loading";
  // A question is a POST, so the state is "submitting", not "loading" — and a
  // question is two model calls, up to about eighty seconds with nothing on
  // screen to say so unless this is threaded through.
  const asking =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "ask";

  return (
    <AnalyticsPage
      view={{ ...(view as AnalyticsView), loading }}
      ask={{ ...(ask as AskView), pending: asking }}
    />
  );
}
