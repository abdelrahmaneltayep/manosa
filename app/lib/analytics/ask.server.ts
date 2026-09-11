import type { DataAnswer } from "~/lib/analytics/answer.server";
import { answerFrom, chartsWithData } from "~/lib/analytics/answer.server";
import { askForJson } from "~/lib/ai/json.server";
import { checkReply, fillSlots } from "~/lib/ai/prompts/buyer-agent.server";
import { routeDataQuestion } from "~/lib/ai/prompts/ask-data.server";
import type { AiDeps, AiFailure } from "~/lib/ai/run.server";
import {
  DEFAULT_RANGE,
  loadAnalytics,
  type ChartLabels,
} from "~/lib/analytics/charts.server";
import type { Translate } from "~/i18n/translate";

/**
 * ✦ One question about the charts, answered.
 *
 * Route → read the chart → write a sentence → check it → substitute. The same
 * order as a Buyer Agent turn, and for the same reason: the figures a sentence
 * may contain have to exist before the sentence is written, or checking it
 * afterwards is checking a claim against nothing.
 */

export interface AskResult {
  /** What the merchant reads. Null when the turn failed. */
  reply: string | null;
  /** The chart it came from, so the answer can cite it. */
  chart: string | null;
  /** The filter state that reproduces it. */
  href: string | null;
  /** Charts that do have something, when the chosen one was empty. */
  insteadTry: string[];
  failure: AiFailure | null;
}

const WRITE_SYSTEM = `You answer one question about a Shopify merchant's wholesale analytics, in two sentences at most.

You are given facts that this app has already computed. Reply with a single JSON object and nothing else:

{ "reply": string }

**Numbers.** Every figure is a slot: write {{f1}}, {{q1}}, {{n1}} — the names in the facts you were given — and the app puts the value in. Never write a digit, a percentage, a currency symbol, or a number in words. A sentence with a number you typed yourself is thrown away and the merchant sees nothing.

Rules:
- Answer the question that was asked. Do not summarise the whole chart.
- Say only what the facts say. If they do not answer the question, say plainly that this chart cannot answer it.
- No preamble, no "based on the data". Write in the merchant's language.`;

const writeUser = (question: string, answer: DataAnswer, locale: string) =>
  [
    `Merchant's language: ${locale}`,
    "",
    "Their question:",
    question,
    "",
    `Facts, from the chart "${answer.chart}":`,
    ...answer.facts.map((fact) => `- ${fact}`),
    "",
    "Slots you may write, and nothing else:",
    ...Object.keys(answer.slots).map((name) => `- {{${name}}}`),
  ].join("\n");

export async function askYourData(
  input: {
    question: string;
    locale: string;
    t: Translate;
    labels: ChartLabels;
    actorId: string | null;
    now?: Date;
  },
  deps: AiDeps = {},
): Promise<AskResult> {
  const empty: AskResult = {
    reply: null,
    chart: null,
    href: null,
    insteadTry: [],
    failure: null,
  };

  const routed = await routeDataQuestion(
    { question: input.question, locale: input.locale, actorId: input.actorId },
    deps,
  );
  if (!routed.ok) return { ...empty, failure: routed.reason };

  // The window the *question* asked for, not the one the page happens to be
  // showing — "how did last quarter go" means ninety days whatever the range
  // picker says, and the link this answer carries takes the merchant there.
  const data = await loadAnalytics({
    range: routed.value.range ?? DEFAULT_RANGE,
    now: input.now,
    labels: input.labels,
  });

  const answer = answerFrom(data, routed.value, { locale: input.locale, t: input.t });

  if (answer.empty) {
    return {
      reply: null,
      chart: answer.chart,
      href: answer.href,
      // "No-data answer offers what *can* be answered" — the checklist's own
      // words. An empty chart with nothing beside it is a dead end.
      insteadTry: chartsWithData(data),
      failure: null,
    };
  }

  const written = await askForJson<{ reply: string }>(
    {
      feature: "ask_data",
      system: WRITE_SYSTEM,
      user: writeUser(input.question, answer, input.locale),
      actorId: input.actorId,
      validate: (value) => {
        if (typeof value !== "object" || value === null) {
          return { ok: false as const, error: "The answer was not a JSON object." };
        }
        const reply = (value as { reply?: unknown }).reply;
        if (typeof reply !== "string" || reply.trim() === "") {
          return { ok: false as const, error: '"reply" must be a sentence.' };
        }
        const checked = checkReply(reply, answer.slots);
        if (!checked.ok) {
          return { ok: false as const, error: checked.error ?? "A figure was invented." };
        }
        return { ok: true as const, value: { reply: reply.trim() } };
      },
    },
    deps,
  );

  if (!written.ok) {
    return { ...empty, chart: answer.chart, href: answer.href, failure: written.reason };
  }

  return {
    reply: fillSlots(written.value.reply, answer.slots),
    chart: answer.chart,
    href: answer.href,
    insteadTry: [],
    failure: null,
  };
}
