import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { AnalyticsPage } from "~/components/analytics/AnalyticsPage";
import type { AnalyticsView } from "~/components/analytics/types";
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

    const data = await loadAnalytics({
      range,
      labels: {
        rest: t("analytics.rest"),
        retail: t("analytics.revenue.retailLabel"),
        ungrouped: t("analytics.ungrouped"),
        unnamedBuyer: t("customers.list.unnamed"),
      },
    });

    const view = analyticsView(data, { locale, t });

    return json({ view: hasAnyData(data) ? view : exampleView(view, locale) });
  });

export default function Analytics() {
  const { view } = useLoaderData<typeof loader>();
  return <AnalyticsPage view={view as AnalyticsView} />;
}
