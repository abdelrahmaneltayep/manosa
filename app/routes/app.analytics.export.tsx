import type { LoaderFunctionArgs } from "@remix-run/node";

import { detectLocale, getFixedT } from "~/i18n.server";
import { translate } from "~/i18n/translate";
import { DEFAULT_RANGE, isRange, loadAnalytics } from "~/lib/analytics/charts.server";
import { chartCsv, CHART_KEYS, isChartKey } from "~/lib/analytics/csv.server";
import { analyticsView, hasAnyData } from "~/lib/analytics/view-model.server";
import { withAdmin } from "~/shopify.server";

/**
 * One chart, as a CSV.
 *
 * Per chart rather than one file of everything, because the checklist asks for
 * it that way and because a merchant exporting "top products" wants top
 * products. The window travels with the link, so the file matches the screen
 * it was taken from.
 *
 * A shop with no data at all gets an empty file with its header row — never the
 * worked example the screen shows. Those figures are somebody else's, and a CSV
 * has no watermark.
 */
export const loader = ({ request }: LoaderFunctionArgs) =>
  withAdmin(request, async () => {
    const url = new URL(request.url);
    const locale = detectLocale(request);
    const t = translate(await getFixedT(locale));

    const chart = (url.searchParams.get("chart") ?? "").trim();
    if (!isChartKey(chart)) {
      throw new Response(`Unknown chart. Try one of: ${CHART_KEYS.join(", ")}`, {
        status: 400,
      });
    }

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
    const csv = chartCsv(chart, (await hasAnyData(data)) ? view : null, t);

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="mannon-${chart}-${range}d.csv"`,
        "Cache-Control": "no-store",
      },
    });
  });
