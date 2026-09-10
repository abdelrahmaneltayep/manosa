import { askForJson } from "~/lib/ai/json.server";
import type { AiDeps, AiResult } from "~/lib/ai/run.server";

/**
 * ✦ The Ask Mannon bar.
 *
 * Checklist §1: "destructive intents ('delete all rules') always route to a
 * confirm draft, never execute."
 *
 * That is not a promise made in a prompt. The model's whole job here is to
 * **route**: it maps the merchant's question to one of a closed list of intents
 * and pulls out its parameters. Every intent is then run by our own code, and
 * the only ones that exist are reads. There is no intent that writes, so there
 * is nothing for a jailbreak to reach — the worst a bad routing can do is
 * answer a question the merchant did not ask.
 *
 * Anything that would change something routes to `open_builder`, which is a
 * link to the page where the merchant does it themselves, with the draft
 * confirm that page already has.
 */

export const ASK_INTENTS = [
  /** "how many wholesale buyers do I have" */
  "count_buyers",
  /** "who owes me money" / "what's overdue" */
  "list_overdue",
  /** "which quotes are about to expire" */
  "list_expiring_quotes",
  /** "how many applications are waiting" */
  "count_applications",
  /** "what did I sell to wholesale last week" */
  "wholesale_sales",
  /** "what's my price for SKU-123 at 50" — the pricing engine answers. */
  "explain_price",
  /** "find the rule for gold customers" */
  "find_rule",
  /** "who hasn't ordered in a while" */
  "list_quiet_buyers",
  /**
   * Anything that would change something — creating, editing, deleting.
   * Answered with a link to the page that does it, never by doing it.
   */
  "open_builder",
] as const;

export type AskIntent = (typeof ASK_INTENTS)[number];

/** Where `open_builder` can send them. A closed list of our own pages. */
export const BUILDER_TARGETS = [
  "pricing_rule",
  "segment",
  "form",
  "quote",
  "csv_import",
  "customer_group",
] as const;

export type BuilderTarget = (typeof BUILDER_TARGETS)[number];

export interface AskAnswer {
  intent: AskIntent;
  /** A SKU, for `explain_price`. */
  sku: string | null;
  /** A quantity, for `explain_price`. */
  quantity: number | null;
  /** Free text to match a rule's name against, for `find_rule`. */
  search: string | null;
  /** Days, for the questions that take a window. */
  days: number | null;
  /** Which page, for `open_builder`. */
  target: BuilderTarget | null;
}

export const ASK_SYSTEM = `You route one question from a Shopify merchant using the Mannon wholesale-pricing app. You do not answer it — the app looks the answer up. Your job is to say which question it is.

Answer with a single JSON object and nothing else:

{
  "intent": string,
  "sku": string | null,
  "quantity": number | null,
  "search": string | null,
  "days": number | null,
  "target": string | null
}

"intent" must be exactly one of:

  count_buyers          — how many wholesale buyers / customers they have
  list_overdue          — who owes money, what is overdue, unpaid invoices
  list_expiring_quotes  — quotes about to expire or needing chasing
  count_applications    — registration applications waiting for a decision
  wholesale_sales       — what they sold to wholesale over a period ("days")
  explain_price         — what a buyer pays for something ("sku", "quantity")
  find_rule             — locating a pricing rule by name or description ("search")
  list_quiet_buyers     — buyers who have not ordered lately ("days")
  open_builder          — ANYTHING that would create, change or delete something

Rules:
- If the question asks to make, change, activate, archive or delete anything at all, the intent is "open_builder" and "target" is one of: pricing_rule, segment, form, quote, csv_import, customer_group. Never route a change to a lookup.
- Fill in only the fields that question uses. Everything else is null.
- "days" is a whole number of days. "last week" is 7, "this month" is 30, "last quarter" is 90.
- "quantity" is how many units the buyer is asking about. Default to null, not 1, when they did not say.
- A SKU is what the merchant typed, exactly. Do not clean it up, guess at it, or complete it.
- If the question is not about their wholesale business at all, or you cannot tell which of these it is, say so by refusing rather than guessing at the nearest one.`;

export function askUser(question: string, locale: string): string {
  return [`Merchant's language: ${locale}`, "", "Their question:", question].join("\n");
}

/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const INTENTS: ReadonlySet<string> = new Set(ASK_INTENTS);
const TARGETS: ReadonlySet<string> = new Set(BUILDER_TARGETS);

/** Bounds what a routed parameter can be. A model is not a validator. */
const MAX_DAYS = 365;
const MAX_QUANTITY = 1_000_000;
const MAX_TEXT = 120;

export function readAsk(
  value: unknown,
): { ok: true; value: AskAnswer } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "The answer was not a JSON object." };

  const intent = value.intent;
  if (typeof intent !== "string" || !INTENTS.has(intent)) {
    return { ok: false, error: `"${String(intent)}" is not one of the intents.` };
  }

  const text = (raw: unknown): string | null => {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return trimmed === "" ? null : trimmed.slice(0, MAX_TEXT);
  };

  const whole = (raw: unknown, max: number): number | null => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    const rounded = Math.round(raw);
    return rounded > 0 && rounded <= max ? rounded : null;
  };

  const target =
    typeof value.target === "string" && TARGETS.has(value.target)
      ? (value.target as BuilderTarget)
      : null;

  if (intent === "open_builder" && target === null) {
    return {
      ok: false,
      error: `"open_builder" needs a "target": one of ${[...TARGETS].join(", ")}.`,
    };
  }

  return {
    ok: true,
    value: {
      intent: intent as AskIntent,
      sku: text(value.sku),
      quantity: whole(value.quantity, MAX_QUANTITY),
      search: text(value.search),
      days: whole(value.days, MAX_DAYS),
      target,
    },
  };
}

/** Route one question. Never throws; never writes; never answers. */
export function routeAsk(
  question: string,
  options: { locale: string; actorId?: string | null },
  deps: AiDeps = {},
): Promise<AiResult<AskAnswer>> {
  return askForJson<AskAnswer>(
    {
      feature: "ask_mannon",
      system: ASK_SYSTEM,
      user: askUser(question, options.locale),
      actorId: options.actorId,
      temperature: 0,
      maxTokens: 500,
      validate: readAsk,
    },
    deps,
  );
}
