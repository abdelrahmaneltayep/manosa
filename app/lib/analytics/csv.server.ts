import type { AnalyticsView, ChartKey } from "~/components/analytics/types";
import type { Translate } from "~/i18n/translate";

/**
 * A chart, as a file.
 *
 * Two rules, both learned the hard way elsewhere in this app. Every cell is
 * quoted and a leading `=`, `+`, `-` or `@` is defused, because a buyer's
 * company name is untrusted text and a spreadsheet reads such a cell as a
 * formula. And the **formatted** figure goes in beside the raw minor units, so
 * a merchant opening this in Excel sees the same number the screen showed them
 * and a script still has something to add up.
 */

// The keys live with the page's types: `AskView.chart` is one of them, and a
// component cannot import from a `.server` module.
export { CHART_KEYS, isChartKey } from "~/components/analytics/types";
export type { ChartKey } from "~/components/analytics/types";

export function csvCell(value: string | number): string {
  const text = String(value);
  const risky = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${risky.replace(/"/g, '""')}"`;
}

const table = (header: readonly string[], body: readonly (string | number)[][]): string =>
  [header, ...body].map((row) => row.map(csvCell).join(",")).join("\n");

/**
 * One chart's rows.
 *
 * `view` is null for a shop with no data at all: the screen shows a worked
 * example there, and a CSV cannot be watermarked — so the file is its header
 * row and nothing else, which is the truth.
 */
export function chartCsv(
  chart: ChartKey,
  view: AnalyticsView | null,
  t: Translate,
): string {
  switch (chart) {
    case "revenue": {
      // The same shape as every other chart's file: raw minor units for a
      // script, the formatted figure beside it for a person. This one shipped
      // with bare minor units under a column headed "Wholesale", so a $120.00
      // day read as 12000.
      const header = [
        t("analytics.csv.day"),
        `${t("analytics.csv.wholesale")} (${t("analytics.csv.minorUnits")})`,
        t("analytics.csv.wholesale"),
        `${t("analytics.csv.retail")} (${t("analytics.csv.minorUnits")})`,
        t("analytics.csv.retail"),
        t("analytics.csv.currency"),
      ];
      if (!view) return table(header, []);

      return table(
        header,
        view.revenue.wholesale.points.map((point, index) => [
          point.day,
          point.value,
          point.money,
          view.revenue.retail.points[index]?.value ?? 0,
          view.revenue.retail.points[index]?.money ?? "",
          view.currencyCode,
        ]),
      );
    }

    case "orders": {
      // Counts, with no currency column: this file has no money in it, and a
      // "Currency" heading over a column of order counts would invite exactly
      // the reading it should prevent.
      const header = [
        t("analytics.csv.day"),
        t("analytics.csv.wholesaleOrders"),
        t("analytics.csv.retailOrders"),
      ];
      if (!view) return table(header, []);

      return table(
        header,
        view.orderCounts.wholesale.points.map((point, index) => [
          point.day,
          point.value,
          view.orderCounts.retail.points[index]?.value ?? 0,
        ]),
      );
    }

    case "groups":
    case "buyers":
    case "products": {
      const header = [
        t("analytics.colName"),
        t("analytics.csv.amount"),
        t("analytics.csv.formatted"),
        t("analytics.csv.currency"),
      ];
      if (!view) return table(header, []);

      const rows =
        chart === "groups"
          ? view.byGroup
          : chart === "buyers"
            ? view.topBuyers
            : view.topProducts;

      return table(
        header,
        rows.map((row) => [row.label, row.value, row.money, view.currencyCode]),
      );
    }

    case "rules": {
      const header = [
        t("analytics.rules.colRule"),
        t("analytics.rules.colLines"),
        t("analytics.csv.discounted"),
        t("analytics.csv.amount"),
        t("analytics.csv.stillExists"),
        t("analytics.csv.currency"),
      ];
      if (!view) return table(header, []);

      return table(
        header,
        view.rules.map((row) => [
          row.label,
          row.lines,
          row.discounted,
          row.value,
          // Said in the file too: a rule renamed since the order was placed
          // keeps its old name here, and a merchant grepping for the new one
          // would otherwise find nothing and assume it earned nothing.
          row.stillExists ? "yes" : "no",
          view.currencyCode,
        ]),
      );
    }

    case "funnel": {
      const header = [
        t("analytics.funnel.colStep"),
        t("analytics.funnel.colCount"),
        t("analytics.funnel.colOfPrevious"),
      ];
      if (!view) return table(header, []);

      return table(
        header,
        view.funnel.map((step) => [
          t(`analytics.funnel.${step.key}`),
          step.value,
          // Blank, not "0%": a rate computed from nothing is not a rate.
          step.ofPrevious ?? "",
        ]),
      );
    }

    case "aging": {
      const header = [
        t("analytics.aging.colBucket"),
        t("analytics.csv.amount"),
        t("analytics.csv.formatted"),
        t("analytics.aging.colInvoices"),
        t("analytics.csv.currency"),
      ];
      if (!view) return table(header, []);

      return table(
        header,
        view.aging.map((row) => [
          t(`terms.bucket.${row.key}`),
          row.value,
          row.amount,
          row.count,
          view.currencyCode,
        ]),
      );
    }
  }
}
