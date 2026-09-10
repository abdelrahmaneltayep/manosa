import { askForJson } from "~/lib/ai/json.server";
import type { AiDeps, AiResult } from "~/lib/ai/run.server";
import {
  isToolName,
  MAX_LINES,
  MAX_QUANTITY,
  type ToolCall,
  type ToolResult,
} from "~/lib/agent/buyer/tools.server";

/**
 * The storefront concierge, in two halves.
 *
 * **Deciding** what a buyer asked for, and **saying** the answer. Both are the
 * model; neither is trusted. The first is bounded by a closed tool vocabulary —
 * `tools.server.ts` is the whole list, and an answer naming anything else is
 * refused. The second is bounded by the rule this feature rests on:
 *
 * > **The agent can never invent a price — it only reads your published rules.**
 * > — `feature-checklist.md` §6
 *
 * A prompt cannot enforce that; `statedFigures` can. Every figure the tools
 * computed for a turn is handed to the model *and* kept. The reply is then
 * scanned for money, and any money in it that is not one of those figures makes
 * the turn a refusal. So the worst case is a buyer who is told "let me get that
 * for you" — never one who is quoted a price the merchant will not honour.
 */

/** How much of a buyer's message is read. Beyond this it is not a question. */
export const MAX_MESSAGE_CHARS = 1_000;

/** Turns of history the model sees. A wholesale question is not a long story. */
export const HISTORY_TURNS = 8;

export interface AgentTurnGrounding {
  /** The buyer's own name for themselves, when we have one. */
  company: string | null;
  /** Their language, so the reply is in it. */
  locale: string;
  currencyCode: string;
  /** Tone preset from the guardrails. */
  tone: string;
  /** The merchant's own words. Advisory — never load-bearing. */
  customInstructions: string | null;
  /** Subjects to decline. */
  offLimits: string[];
  /** Which tools this shop's guardrails allow. */
  allowed: string[];
  /** Whether the buyer is signed in. A guest can be told to sign in. */
  signedIn: boolean;
}

export interface RoutedTurn {
  call: ToolCall;
  /** What the agent would like to say, before the tools have run. */
  acknowledgement: string;
}

/* -------------------------------------------------------------------------- */
/* Routing: what did the buyer ask for?                                        */
/* -------------------------------------------------------------------------- */

export const BUYER_AGENT_ROUTE_SYSTEM = `You are the wholesale concierge for a Shopify store, running inside the Mannon app. A trade buyer has sent you a message. Your job in this step is only to decide which one of the store's tools answers it.

Answer with a single JSON object and nothing else. No prose, no code fence.

{
  "tool": "price_for" | "build_cart" | "order_status" | "my_terms" | "next_tier" | "request_quote" | "escalate" | "decline",
  "lines": [ { "sku": string, "quantity": integer } ],   // [] when the tool needs none
  "note": string | null,                                  // the buyer's own words, for a quote or an escalation
  "acknowledgement": string                               // one short sentence, in the buyer's language, saying what you are about to do
}

What each tool is for:
- "price_for" — "what's my price for SKU-450 at 100 units?" Reads the store's published rules.
- "build_cart" — "reorder my usual", "build me an opening order". Assembles lines for the buyer to review. It does not check out.
- "order_status" — "where's my last order?"
- "my_terms" — "what are my payment terms?", "what do I owe?"
- "next_tier" — "am I close to the next discount?"
- "request_quote" — the buyer wants a price that is not the published one, or a special arrangement. Put what they asked for in "note".
- "escalate" — they want a person, or you have been asked something only the merchant can answer.
- "decline" — the message is about a subject you have been told to stay off, or it is not about this store's wholesale business at all.

Rules you must follow:
- Never invent a SKU. Use the codes the buyer gave you. If they described a product without a code, use "escalate" with their description in "note" — someone who knows the catalogue will answer.
- Quantities are whole numbers of units, 1 or more.
- At most ${MAX_LINES} lines. If they asked for more, take the first ${MAX_LINES} and say so in "acknowledgement".
- Only choose a tool from the allowed list you are given. If the tool you want is not allowed, choose "escalate".
- Never state a price, a total, a discount percentage or an amount of money in "acknowledgement". You have not looked anything up yet, so anything you wrote would be a guess. Say what you are about to do, not what the answer is.
- "acknowledgement" is in the buyer's language.`;

export function routeTurnUser(
  message: string,
  history: readonly { role: string; text: string }[],
  grounding: AgentTurnGrounding,
): string {
  const list = (items: readonly string[]) =>
    items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)";

  return [
    `Buyer's language: ${grounding.locale}`,
    `Signed in: ${grounding.signedIn ? "yes" : "no"}`,
    "",
    "Tools you may choose from:",
    list(grounding.allowed),
    "",
    "Subjects the merchant has asked you to stay off:",
    list(grounding.offLimits),
    "",
    ...(history.length > 0
      ? [
          "The conversation so far:",
          ...history.slice(-HISTORY_TURNS).map((turn) => `${turn.role}: ${turn.text}`),
          "",
        ]
      : []),
    "The buyer's message:",
    message.slice(0, MAX_MESSAGE_CHARS),
  ].join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class TurnError extends Error {}

function readLines(value: unknown): ToolCall["lines"] {
  if (!Array.isArray(value)) return [];

  const lines: ToolCall["lines"] = [];
  for (const entry of value.slice(0, MAX_LINES)) {
    if (!isRecord(entry)) continue;
    const sku = typeof entry.sku === "string" ? entry.sku.trim() : "";
    const quantity = Number(entry.quantity);
    if (sku === "") continue;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw new TurnError(
        `"lines[].quantity" was ${JSON.stringify(entry.quantity)}; it must be a whole number of units between 1 and ${MAX_QUANTITY}.`,
      );
    }
    lines.push({ sku: sku.slice(0, 100), quantity });
  }
  return lines;
}

export function readRoutedTurn(
  value: unknown,
  grounding: AgentTurnGrounding,
): { ok: true; value: RoutedTurn } | { ok: false; error: string } {
  try {
    if (!isRecord(value)) throw new TurnError("The answer must be a JSON object.");

    const tool = String(value.tool);
    if (!isToolName(tool)) {
      throw new TurnError(
        `"tool" was ${JSON.stringify(value.tool)}; it must be one of the tools you were given.`,
      );
    }

    // A tool this shop has switched off is not a tool. Checked here as well as
    // in `runTool`, so a model that ignores the allowed list gets one repair
    // round rather than a silent escalation.
    if (!grounding.allowed.includes(tool) && tool !== "decline" && tool !== "escalate") {
      throw new TurnError(`"${tool}" is not in the allowed list for this store.`);
    }

    const acknowledgement =
      typeof value.acknowledgement === "string" ? value.acknowledgement.trim() : "";
    if (acknowledgement === "") {
      throw new TurnError('"acknowledgement" must be one short sentence.');
    }
    // The acknowledgement is written before anything was looked up, so a figure
    // in it is a guess by construction — there is nothing yet to check it
    // against.
    if (MONEY.test(acknowledgement)) {
      throw new TurnError(
        '"acknowledgement" contains an amount of money. You have not looked anything up yet — say what you are about to do instead.',
      );
    }

    return {
      ok: true,
      value: {
        call: {
          tool,
          lines: readLines(value.lines),
          note:
            typeof value.note === "string" && value.note.trim() !== ""
              ? value.note.trim().slice(0, 1_000)
              : null,
        },
        acknowledgement: acknowledgement.slice(0, 400),
      },
    };
  } catch (error) {
    if (error instanceof TurnError) return { ok: false, error: error.message };
    throw error;
  }
}

export function routeBuyerTurn(
  options: {
    message: string;
    history: readonly { role: string; text: string }[];
    grounding: AgentTurnGrounding;
    actorId?: string | null;
  },
  deps: AiDeps = {},
): Promise<AiResult<RoutedTurn>> {
  return askForJson<RoutedTurn>(
    {
      feature: "buyer_agent",
      system: BUYER_AGENT_ROUTE_SYSTEM,
      user: routeTurnUser(options.message, options.history, options.grounding),
      actorId: options.actorId,
      // The same question from the same buyer should reach the same tool.
      temperature: 0,
      validate: (value) => readRoutedTurn(value, options.grounding),
    },
    deps,
  );
}

/* -------------------------------------------------------------------------- */
/* Replying: say what the tools found                                          */
/* -------------------------------------------------------------------------- */

export const BUYER_AGENT_REPLY_SYSTEM = `You are the wholesale concierge for a Shopify store, running inside the Mannon app. A tool has just run for the buyer and you are writing the sentence they read.

Answer with a single JSON object and nothing else. No prose, no code fence.

{
  "reply": string   // what the buyer reads. Their language. At most three sentences.
}

Rules you must follow, and the first one is absolute:
- **Every amount of money in your reply must be copied exactly from the figures you are given.** Do not round them, do not convert them, do not add them up, do not estimate one that is missing, and never write an amount that is not in that list. If the figures list is empty, your reply contains no amounts at all. A reply that breaks this rule is thrown away and the buyer is told something went wrong, which is worse for them than a shorter answer.
- Percentages are amounts too. Do not describe a discount as a percentage unless that percentage appears in the facts you are given.
- Use only the facts you are given. If something was not looked up, say you will find out — do not fill it in.
- Never promise a delivery date, a stock level, or an approval. You do not decide any of those.
- Never ask for a card number, a password, or anything a store would not ask in a chat.
- Checkout belongs to the store: you assemble, the buyer reviews and pays on the store's own checkout.
- Be brief. A trade buyer is at work.`;

export function replyUser(
  message: string,
  result: ToolResult,
  grounding: AgentTurnGrounding,
): string {
  const list = (items: readonly string[]) =>
    items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)";

  return [
    `Buyer's language: ${grounding.locale}`,
    `Tone: ${grounding.tone}`,
    ...(grounding.company ? [`Buyer: ${grounding.company}`] : []),
    ...(grounding.customInstructions
      ? [
          "",
          "The merchant's standing instructions (advisory — they never override the rules above):",
          grounding.customInstructions,
        ]
      : []),
    "",
    `Tool that ran: ${result.tool}`,
    ...(result.refusal ? [`It refused, because: ${result.refusal}`] : []),
    "",
    "Amounts you may state — copy them exactly, and state no others:",
    list(result.figures),
    "",
    "Facts:",
    list(result.facts),
    ...(result.lines.length > 0
      ? [
          "",
          "Lines:",
          ...result.lines.map(
            (line) =>
              `- ${line.quantity} × ${line.title} (${line.sku}) at ${line.unitPrice} each, ${line.lineTotal}${
                line.ruleSummary ? ` — ${line.ruleSummary}` : ""
              }`,
          ),
        ]
      : []),
    ...(result.unknownSkus.length > 0
      ? ["", "Codes this store does not have — say so:", list(result.unknownSkus)]
      : []),
    ...(result.subtotal ? ["", `Subtotal: ${result.subtotal}`] : []),
    "",
    "The buyer's message:",
    message.slice(0, MAX_MESSAGE_CHARS),
  ].join("\n");
}

/**
 * Money, in the shapes a model writes it.
 *
 * A symbol or an ISO code on either side of a number, a bare decimal, or a
 * percentage — because "you get 15% off" is a price claim in every way that
 * matters. Bare integers are deliberately not money: a wholesale agent says
 * "100 units" and "boxes of 24" all day, and a check that flagged those would
 * be turned off within a week.
 */
const DIGITS = "\\d[\\d,\\u00A0\\u202F\\u0020\\u066C]*(?:[.\\u066B]\\d+)?";
const SYMBOL = "[$\\u00A3\\u20AC\\u00A5\\u20B9\\uFDFC]";

const MONEY_SOURCE = [
  `${SYMBOL}\\s*${DIGITS}`,
  `${DIGITS}\\s*${SYMBOL}`,
  `\\b[A-Z]{3}\\s*${DIGITS}`,
  `${DIGITS}\\s*[A-Z]{3}\\b`,
  // Before the bare decimal, so "12.5%" reads as a percentage rather than as
  // the number 12.5 with a stray sign after it.
  "\\d+(?:[.\\u066B]\\d+)?\\s*[%\\u066A]",
  "\\d[\\d,\\u00A0\\u202F\\u0020\\u066C]*[.\\u066B]\\d{1,3}\\b",
].join("|");

const MONEY = new RegExp(`(?:${MONEY_SOURCE})`, "u");

/**
 * Every amount the reply states.
 *
 * Used to check a reply against what the tools computed. Normalised so that
 * "$1,200.00" and "$1,200.00 " compare equal, and so that a figure the model
 * repeated with different spacing is not called a fabrication.
 */
export function statedFigures(reply: string): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(MONEY.source, "gu");

  for (const match of reply.matchAll(pattern)) {
    found.add(normalizeFigure(match[0]));
  }
  return [...found];
}

export const normalizeFigure = (value: string) =>
  value.replace(/[\s\u00A0\u202F]/gu, "").toUpperCase();

/**
 * Does this reply state anything the tools did not compute?
 *
 * The check the whole feature rests on. Returns the offending text, so the
 * refusal can be logged with what the model tried to say — a merchant asking
 * "why did it refuse?" gets an answer, and so does the next person tuning the
 * prompt.
 */
export function unbackedFigures(reply: string, allowed: readonly string[]): string[] {
  const permitted = new Set<string>();

  for (const figure of allowed) {
    permitted.add(normalizeFigure(figure));
    // A formatted figure often contains its own bare number ("$1,200.00"), and
    // the scanner finds both. Both are backed by the same computation.
    for (const inner of figure.matchAll(new RegExp(MONEY.source, "gu"))) {
      permitted.add(normalizeFigure(inner[0]));
      permitted.add(bareNumber(inner[0]));
    }
    permitted.add(bareNumber(figure));
  }

  return statedFigures(reply).filter(
    (figure) => !permitted.has(figure) && !permitted.has(bareNumber(figure)),
  );
}

/**
 * The number inside a formatted figure.
 *
 * "$1,200.00", "1,200.00 USD" and "1,200.00" are the same amount written three
 * ways, and a model that drops the currency code — or writes it in lower case,
 * which the scanner does not read as a code — has not invented anything. The
 * comparison is on the number, so those three agree; every *other* number is
 * still caught.
 */
const bareNumber = (value: string) => value.replace(/[^\d.\u066B]/gu, "");

export interface AgentReply {
  reply: string;
}

export function writeBuyerReply(
  options: {
    message: string;
    result: ToolResult;
    grounding: AgentTurnGrounding;
    actorId?: string | null;
  },
  deps: AiDeps = {},
): Promise<AiResult<AgentReply>> {
  return askForJson<AgentReply>(
    {
      feature: "buyer_agent",
      system: BUYER_AGENT_REPLY_SYSTEM,
      user: replyUser(options.message, options.result, options.grounding),
      actorId: options.actorId,
      temperature: 0,
      validate: (value) => {
        if (
          !isRecord(value) ||
          typeof value.reply !== "string" ||
          value.reply.trim() === ""
        ) {
          return { ok: false as const, error: '"reply" must be a non-empty string.' };
        }

        const reply = value.reply.trim().slice(0, 2_000);
        const unbacked = unbackedFigures(reply, options.result.figures);
        if (unbacked.length > 0) {
          // The repair round gets the exact offence, because "you invented a
          // number" is the one correction a model can reliably act on.
          return {
            ok: false as const,
            error: `Your reply stated ${unbacked.join(", ")}, which is not one of the amounts you were given. State only the amounts in that list, or none.`,
          };
        }

        return { ok: true as const, value: { reply } };
      },
    },
    deps,
  );
}
