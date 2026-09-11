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
  /**
   * The buyer's own message.
   *
   * Only so the acknowledgement may repeat a code or a quantity they typed.
   * Repeating what somebody said is not a claim about a price.
   */
  buyerSaid?: string;
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
    // The acknowledgement is written before anything has been looked up, so a
    // figure in it is a guess by construction. It may still repeat what the
    // buyer typed — "checking SKU-450 at 100 units" invents nothing, and the
    // two flows the spec leads with are exactly that shape.
    const invented = inventedNumbers(acknowledgement, grounding.buyerSaid ?? "");
    if (invented.length > 0) {
      throw new TurnError(
        `"acknowledgement" states ${invented.join(", ")}, which the buyer did not say and you have not looked up. Say what you are about to do, not what the answer is.`,
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

**You may not write a number.** Not a price, not a percentage, not a quantity, not a product code, not a date. Every one of those is given to you as a slot, and you write the slot instead:

  "Your price is {{f1}} each, so {{f2}} for {{q1}}."

Rules you must follow, and the first one is absolute:
- Write \`{{name}}\` exactly as it appears in the slot list. Do not change it, do not write the value it stands for, and do not invent a slot that is not in the list. A reply containing any digit outside a slot is thrown away and the buyer is told something went wrong — which is worse for them than a shorter answer.
- Do not write the name of a currency or the word "percent" (or their equivalents in any language). A slot already carries its own symbol.
- Do not add up, convert, round or estimate. If the number you want is not a slot, it is not a number you have.
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

  const slots = Object.entries(result.slots).map(
    ([name, value]) => `{{${name}}} = ${value}`,
  );

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
    "Slots you may use. Write the name in braces; never the value:",
    list(slots),
    "",
    "Facts:",
    list(result.facts),
    ...(result.unknownSkus.length > 0
      ? ["", "Codes this store does not have — say so:", list(result.unknownSkus)]
      : []),
    "",
    "The buyer's message:",
    message.slice(0, MAX_MESSAGE_CHARS),
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* The guard                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The rule the whole feature rests on, and why it is shaped like this.
 *
 * The first version of this scanned the model's reply for anything that looked
 * like money and compared it with a list of figures the tools had computed.
 * That cannot be made to work. `\d` is ASCII-only, so an Arabic reply reading
 * "٩٫٠٠" was invisible to it; a currency can be swapped for another and the
 * number left alone; "1 200,50" and "120 050" collapse to the same digits;
 * "900 dollars" contains no symbol at all; and it refused the two examples the
 * spec leads with, because "NET 30" and "SKU 450" look like money to a regex.
 *
 * So the model does not write numbers. It writes **slots** — \`{{f1}}\`, \`{{q1}}\`
 * — and this module substitutes the values the tools computed, formatted in the
 * buyer's own locale. The check is then a thing that can actually be right: a
 * reply may contain no digit, in any script, outside a slot; no currency word;
 * and no slot we did not supply.
 */

/** `{{f1}}`, with whatever spacing a model feels like using. */
const SLOT = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu;

/** Any decimal digit, in any script. `\p{Nd}` covers Arabic-Indic and the rest. */
const DIGIT = /\p{Nd}/u;

/**
 * Words that make a bare number a price.
 *
 * A formatted figure carries its own symbol, so the model never needs one of
 * these — and "nine hundred dollars" is a quote in every way that matters even
 * though it holds no digit. English and Arabic, because those are the two
 * languages this ships in; a third language means a third row here, and the
 * test that reads this list will say so.
 */
const CURRENCY_WORDS =
  /\b(?:dollars?|usd|pounds?|gbp|euros?|eur|yen|jpy|riyals?|sar|dirhams?|aed|dinars?|kwd|bhd|cents?|percent|per\s?cent)\b|[$£€¥₹﷼%]|٪|ريال|ريالات|درهم|دراهم|دينار|دولار|دولارات|جنيه|يورو|بالمئة|بالمائة|في\s?المئة/iu;

/**
 * Numbers written as words, and comparisons that are numbers in disguise.
 *
 * `DIGIT` catches every script's digits and nothing else, so "you took nine
 * hundred and fifty this month", "revenue doubled", "up by a third" and
 * "Café Aroma came second" all passed a check the ADR presents as the thing
 * that stops a model stating a figure this app did not compute. The monthly
 * review is where it matters most: it is the one prompt that asks a model to
 * *compare two months in prose*, which is the shape that invites exactly these
 * words — and what it writes is kept forever.
 *
 * Bare "one" is deliberately absent: "one of your rules priced nothing" is
 * ordinary prose, and refusing it would fail reviews for no gain. "One
 * hundred" is still caught, by "hundred".
 *
 * English and Arabic, the two languages this ships in. A third language means
 * a third row here, and `tests/unit/agent-guardrails.test.ts` says so.
 */
const NUMBER_WORDS =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|dozens?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|half|halves|halved|quarters?|double[ds]?|doubling|triple[ds]?|tripled|quadruple[ds]?|twice|thrice|fold)\b|واحدة|اثنان|اثنين|ثلاثة|ثلاث|أربعة|اربعة|خمسة|ستة|سبعة|ثمانية|تسعة|عشرة|عشرين|ثلاثين|مئة|مائة|ألف|الف|مليون|ضعف|ضعفين|أضعاف|اضعاف|نصف|ثلث|ربع|الأول|الثاني|الثالث/iu;

/**
 * Runs of digits in `text` that do not appear in `source`.
 *
 * Used on the acknowledgement, which has no slots because nothing has been
 * looked up yet. Digits the buyer themselves wrote are theirs to hear back;
 * anything else at that stage is invented.
 */
export function inventedNumbers(text: string, source: string): string[] {
  const runs = [...text.matchAll(/\p{Nd}[\p{Nd}.,\u066B\u066C]*/gu)].map(
    (match) => match[0],
  );
  const said = source.replace(/[\s\u00A0\u202F]/gu, "");
  const flat = (value: string) => value.replace(/[\s\u00A0\u202F]/gu, "");

  return [...new Set(runs.filter((run) => !said.includes(flat(run))))];
}

export interface ReplyCheck {
  ok: boolean;
  /** Why it was refused. Null when it was not. */
  error: string | null;
}

/** Every slot name a reply used. */
export function slotsUsed(reply: string): string[] {
  return [...reply.matchAll(new RegExp(SLOT.source, "gu"))].map((match) => match[1]!);
}

/** The reply with every slot taken out, which is what the check reads. */
export function withoutSlots(reply: string): string {
  return reply.replace(new RegExp(SLOT.source, "gu"), " ");
}

/**
 * May this reply be shown to the buyer?
 *
 * Returns the reason rather than a boolean, because the repair round is handed
 * that reason and "you wrote a number" is the one correction a model reliably
 * acts on.
 */
export function checkReply(
  reply: string,
  slots: Readonly<Record<string, string>>,
): ReplyCheck {
  for (const name of slotsUsed(reply)) {
    if (!(name in slots)) {
      return {
        ok: false,
        error: `You used {{${name}}}, which is not one of the slots you were given. Use only the slots in the list, or none.`,
      };
    }
  }

  const bare = withoutSlots(reply);

  if (DIGIT.test(bare)) {
    return {
      ok: false,
      error:
        "Your reply contains a number written out. Every number, price, quantity, code and date has to be a slot from the list — write {{f1}} rather than the figure it stands for.",
    };
  }

  const currency = bare.match(CURRENCY_WORDS);
  if (currency) {
    return {
      ok: false,
      error: `Your reply says "${currency[0]}". Do not name a currency or a percentage — the slot you were given already carries its own symbol.`,
    };
  }

  const inWords = bare.match(NUMBER_WORDS);
  if (inWords) {
    return {
      ok: false,
      error: `Your reply says "${inWords[0]}", which is a number written as a word. Every number, rank and comparison has to be a slot from the list — write {{q1}} rather than "three", and say which figures moved rather than "doubled".`,
    };
  }

  return { ok: true, error: null };
}

/** Put the tools' own figures into the sentence the model wrote. */
export function fillSlots(
  reply: string,
  slots: Readonly<Record<string, string>>,
): string {
  return reply.replace(new RegExp(SLOT.source, "gu"), (_, name: string) =>
    Object.prototype.hasOwnProperty.call(slots, name) ? slots[name]! : "",
  );
}

export interface AgentReply {
  /** The sentence, with the tools' figures already in it. */
  reply: string;
  /** As the model wrote it, slots and all — for the transcript. */
  template: string;
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

        const template = value.reply.trim().slice(0, 2_000);
        const checked = checkReply(template, options.result.slots);
        if (!checked.ok) {
          return { ok: false as const, error: checked.error ?? "Refused." };
        }

        return {
          ok: true as const,
          value: { reply: fillSlots(template, options.result.slots), template },
        };
      },
    },
    deps,
  );
}
