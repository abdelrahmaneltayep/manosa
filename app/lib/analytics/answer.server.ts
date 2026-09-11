import { money } from "@mannon/pricing-engine";

import type { ChartKey } from "~/lib/analytics/csv.server";
import type { AnalyticsData, Range } from "~/lib/analytics/charts.server";
import type { Translate } from "~/i18n/translate";
import { formatCurrency } from "~/lib/money";

/**
 * The answer to a question about the charts, computed from the charts.
 *
 * Checklist §7 asks for three things, and every one of them comes from the
 * model never computing anything:
 *
 * - **"answers cite the chart they derive from"** — the citation is the chart
 *   this module read, not a claim the model makes about its own working.
 * - **"every claim reproducible via a linked filter state"** — `href` is the
 *   analytics page with the same window, scrolled to the same chart. Following
 *   it re-runs the same query, so the merchant can see the number for
 *   themselves rather than taking it on trust.
 * - **"no-data answer offers what *can* be answered"** — when the chosen chart
 *   is empty, this says which charts are not.
 *
 * Every figure below goes into a **slot**, and the model writes prose around
 * the slot names — the same rule the Buyer Agent rests on, for the same reason.
 */

export interface DataAnswer {
  chart: ChartKey;
  range: Range;
  /** Where the merchant goes to see this for themselves. */
  href: string;
  /** Short statements of fact, for the model to write a sentence around. */
  facts: string[];
  /** Already formatted, in the shop's currency. The model may only use these. */
  slots: Record<string, string>;
  /** True when the chosen chart has nothing in it. */
  empty: boolean;
  /** Charts that do have something, when the chosen one does not. */
  insteadTry: ChartKey[];
}

const ANCHOR: Record<ChartKey, string> = {
  revenue: "revenue",
  orders: "orders",
  groups: "groups",
  buyers: "buyers",
  products: "products",
  rules: "rules",
  funnel: "funnel",
  aging: "aging",
};

/** Which charts have anything in them at all. */
export function chartsWithData(data: AnalyticsData): ChartKey[] {
  const filled: ChartKey[] = [];

  if (data.revenue.wholesale.total.amount > 0 || data.revenue.retail.total.amount > 0) {
    filled.push("revenue");
  }
  if (data.orderCounts.wholesale.total > 0 || data.orderCounts.retail.total > 0) {
    filled.push("orders");
  }
  if (data.byGroup.length > 0) filled.push("groups");
  if (data.topBuyers.length > 0) filled.push("buyers");
  if (data.topProducts.length > 0) filled.push("products");
  if (data.rules.length > 0) filled.push("rules");
  if (data.funnel.some((step) => step.value > 0)) filled.push("funnel");
  if (data.aging.some((row) => row.amount.amount > 0)) filled.push("aging");

  return filled;
}

/**
 * Read the answer off one chart.
 *
 * A `focus` narrows to one named row — a group, a buyer, a product, a rule —
 * matched case-insensitively against what the merchant typed. A focus that
 * matches nothing is *said*, not silently widened to the whole chart: "your
 * top buyer is X" in answer to "how did Acme do" is a wrong answer that reads
 * like a right one.
 */
export function answerFrom(
  data: AnalyticsData,
  question: { chart: ChartKey; range: Range; focus: string | null },
  options: { locale: string; t: Translate },
): DataAnswer {
  const { locale } = options;
  const currencyCode = data.window.currencyCode;
  const cash = (amount: number) => formatCurrency(money(amount, currencyCode), locale);

  const href = `/app/analytics?range=${question.range}#${ANCHOR[question.chart]}`;
  const filled = chartsWithData(data);
  const empty = !filled.includes(question.chart);

  const base = {
    chart: question.chart,
    range: question.range,
    href,
    empty,
    insteadTry: empty ? filled : [],
  };

  if (empty) {
    return { ...base, facts: ["the chart is empty for this window"], slots: {} };
  }

  const ranked = (
    rows: { label: string; value: number; isRest?: boolean }[],
  ): { facts: string[]; slots: Record<string, string> } => {
    // The "everyone else" row is a total, not an entity — naming it as the top
    // anything would be nonsense.
    const real = rows.filter((row) => row.isRest !== true);

    if (question.focus) {
      const needle = question.focus.toLowerCase();
      const hit = real.find((row) => row.label.toLowerCase().includes(needle));

      if (!hit) {
        return {
          facts: [`nothing named "${question.focus}" is in this chart for this window`],
          slots: { n1: question.focus },
        };
      }

      const rank = real.indexOf(hit) + 1;
      return {
        facts: [`{{n1}} is ranked {{q1}} in this chart`, `it accounts for {{f1}}`],
        slots: { n1: hit.label, q1: String(rank), f1: cash(hit.value) },
      };
    }

    const total = real.reduce((sum, row) => sum + row.value, 0);
    const top = real.slice(0, 3);

    return {
      facts: [
        `the top of this chart is {{n1}} at {{f1}}`,
        ...(top[1] ? [`then {{n2}} at {{f2}}`] : []),
        ...(top[2] ? [`then {{n3}} at {{f3}}`] : []),
        `everything in this chart adds up to {{total}}`,
      ],
      slots: {
        n1: top[0]?.label ?? "",
        f1: cash(top[0]?.value ?? 0),
        ...(top[1] ? { n2: top[1].label, f2: cash(top[1].value) } : {}),
        ...(top[2] ? { n3: top[2].label, f3: cash(top[2].value) } : {}),
        total: cash(total),
      },
    };
  };

  switch (question.chart) {
    case "revenue": {
      const wholesale = data.revenue.wholesale;
      const retail = data.revenue.retail;
      const best = [...wholesale.points].sort((a, b) => b.value - a.value)[0];

      return {
        ...base,
        facts: [
          `wholesale took {{f1}} over the window`,
          `retail took {{f2}}`,
          ...(best && best.value > 0
            ? [`the best single day was {{d1}}, at {{f3}}`]
            : []),
        ],
        slots: {
          f1: cash(wholesale.total.amount),
          f2: cash(retail.total.amount),
          ...(best && best.value > 0 ? { d1: best.day, f3: cash(best.value) } : {}),
        },
      };
    }

    case "orders": {
      const wholesale = data.orderCounts.wholesale;
      const retail = data.orderCounts.retail;
      const best = [...wholesale.points].sort((a, b) => b.value - a.value)[0];

      // Counts, never `cash()`: this chart has no currency, and an answer that
      // said "you took $14.00 in orders" would be a number that is not money.
      return {
        ...base,
        facts: [
          `wholesale placed {{q1}} orders over the window`,
          `retail placed {{q2}}`,
          ...(best && best.value > 0
            ? [`the busiest single day was {{d1}}, with {{q3}}`]
            : []),
        ],
        slots: {
          q1: String(wholesale.total),
          q2: String(retail.total),
          ...(best && best.value > 0 ? { d1: best.day, q3: String(best.value) } : {}),
        },
      };
    }

    case "groups":
      return { ...base, ...ranked(data.byGroup) };
    case "buyers":
      return { ...base, ...ranked(data.topBuyers) };
    case "products":
      return { ...base, ...ranked(data.topProducts) };

    case "rules": {
      const answer = ranked(data.rules);
      const focused = question.focus
        ? data.rules.find((row) =>
            row.label.toLowerCase().includes(question.focus!.toLowerCase()),
          )
        : data.rules[0];

      if (!focused) return { ...base, ...answer };

      return {
        ...base,
        facts: [
          `{{n1}} priced {{q1}} order lines`,
          `those lines brought in {{f1}}`,
          `and the rule took {{f2}} off them`,
          ...(focused.stillExists
            ? []
            : [
                "no rule by that name exists in this shop now — it was renamed or removed",
              ]),
        ],
        slots: {
          n1: focused.label,
          q1: String(focused.lines),
          f1: cash(focused.value),
          f2: cash(focused.discounted),
        },
      };
    }

    case "funnel": {
      const [submitted, approved, ordered] = data.funnel;
      return {
        ...base,
        facts: [
          `{{q1}} people applied`,
          `{{q2}} were approved`,
          `{{q3}} went on to place a wholesale order`,
        ],
        slots: {
          q1: String(submitted?.value ?? 0),
          q2: String(approved?.value ?? 0),
          q3: String(ordered?.value ?? 0),
        },
      };
    }

    case "aging": {
      const owed = data.aging.reduce((sum, row) => sum + row.amount.amount, 0);
      const late = data.aging
        .filter((row) => row.bucket !== "current")
        .reduce((sum, row) => sum + row.amount.amount, 0);

      return {
        ...base,
        facts: [`{{f1}} is owed on terms`, `{{f2}} of that is past its due date`],
        slots: { f1: cash(owed), f2: cash(late) },
      };
    }
  }
}
