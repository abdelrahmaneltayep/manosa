import { askForJson } from "~/lib/ai/json.server";
import type { AiDeps, AiResult } from "~/lib/ai/run.server";
import { CHART_KEYS, type ChartKey } from "~/lib/analytics/csv.server";
import { RANGES, type Range } from "~/lib/analytics/charts.server";

/**
 * ✦ Ask your data.
 *
 * Checklist §7: "answers cite the chart they derive from ('from: Revenue by
 * group'); no-data answer offers what *can* be answered; every claim
 * reproducible via a linked filter state."
 *
 * All three fall out of one decision: **the model does not answer the
 * question.** It routes — a chart and a window, both from closed lists — and
 * this app computes the answer from the same module that draws the chart. So
 * the citation is not a claim the model makes about its own reasoning, it is
 * the chart the number actually came from; and the link is the filter state
 * that produced it, which is reproducible because it is the same query.
 *
 * The same shape as the Buyer Agent, for the same reason: a model that never
 * writes a figure cannot write a wrong one.
 */

export interface DataQuestion {
  chart: ChartKey;
  range: Range;
  /**
   * A name to look for within the chosen chart — a group, a buyer, a product,
   * a rule. Null when the question is about the chart as a whole.
   */
  focus: string | null;
}

const MAX_FOCUS = 80;

export const ASK_DATA_SYSTEM = `You route one question about a Shopify merchant's wholesale analytics. You do NOT answer it: the app computes every figure from the chart you name. Your only job is to say which chart answers this question, and over what window.

Answer with a single JSON object and nothing else:

{ "chart": string, "range": number, "focus": string | null }

"chart" must be exactly one of:

  revenue   — money over time; wholesale against retail; growth, trend, "how much did I sell"
  groups    — revenue split by customer group or tier
  buyers    — which customers spend the most
  products  — which products sell the most
  rules     — how a pricing rule performed: what it earned, what it gave away
  funnel    — registrations: applied, approved, went on to order
  aging     — money owed on net terms, and how late it is

"range" is the window in days and must be 7, 30 or 90. "last week" is 7, "this month" is 30, "this quarter" is 90. Use 30 when they did not say.

"focus" is the name of one group, buyer, product or rule the question is about, copied exactly as the merchant typed it. Null when the question is about the whole chart.

Rules:
- Pick the chart that ALREADY holds the answer. Never pick one because it is close.
- If no chart here can answer the question, refuse rather than picking the nearest.
- Never state a figure, a total or a percentage. You have not seen any data.`;

export function askDataUser(question: string, locale: string): string {
  return [`Merchant's language: ${locale}`, "", "Their question:", question].join("\n");
}

/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CHARTS: ReadonlySet<string> = new Set(CHART_KEYS);

export function readDataQuestion(
  value: unknown,
): { ok: true; value: DataQuestion } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "The answer was not a JSON object." };

  const chart = value.chart;
  if (typeof chart !== "string" || !CHARTS.has(chart)) {
    return {
      ok: false,
      error: `"${String(chart)}" is not one of the charts: ${CHART_KEYS.join(", ")}.`,
    };
  }

  // A model is not a validator. An out-of-range window becomes the default
  // rather than a query nobody sized.
  const asked = Number(value.range);
  const range = (RANGES as readonly number[]).includes(asked) ? (asked as Range) : 30;

  const focusRaw = value.focus;
  const focus =
    typeof focusRaw === "string" && focusRaw.trim() !== ""
      ? focusRaw.trim().slice(0, MAX_FOCUS)
      : null;

  return { ok: true, value: { chart: chart as ChartKey, range, focus } };
}

export function routeDataQuestion(
  input: { question: string; locale: string; actorId: string | null },
  deps: AiDeps = {},
): Promise<AiResult<DataQuestion>> {
  return askForJson<DataQuestion>(
    {
      feature: "ask_data",
      system: ASK_DATA_SYSTEM,
      user: askDataUser(input.question, input.locale),
      actorId: input.actorId,
      validate: readDataQuestion,
    },
    deps,
  );
}
