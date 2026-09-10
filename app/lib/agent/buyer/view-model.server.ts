import type { AgentConversation, AgentGuardrails, AgentMessage } from "@prisma/client";

import type {
  GuardrailsView,
  LogRowView,
  LogView,
  TestBuyerView,
  TranscriptTurnView,
  TranscriptView,
} from "~/components/agent/types";
import { db } from "~/db.server";
import type { Translate } from "~/i18n/translate";
import { whenLabel } from "~/lib/agent/home-view.server";
import {
  CONVERSATION_RETENTION_DAYS,
  countWords,
  lintInstructions,
  MAX_INSTRUCTION_WORDS,
  TONES,
} from "~/lib/agent/buyer/guardrails.server";
import type { LogPage } from "~/lib/agent/buyer/log.server";
import { MAX_REPLY_CHARS, OUTCOMES } from "~/lib/agent/buyer/log.server";
import type { PublishReadiness } from "~/lib/agent/buyer/publish.server";
import { isToolName } from "~/lib/agent/buyer/tools.server";
import { displayName } from "~/lib/customers/view-model.server";

/**
 * What the three Buyer Agent screens read.
 *
 * Assembled here rather than in a loader, which is the lesson 4.5's cold read
 * left behind: a decision inside a Remix action is a decision this environment
 * cannot test, and every one of these — which chip, which warning, whether the
 * publish button is live — is a decision.
 */

/** How many approved buyers the rehearsal picker lists at once. */
export const TEST_BUYER_PAGE = 50;

/**
 * Approved buyers, for the rehearsal picker.
 *
 * Searchable, because a shop with two hundred approved buyers cannot rehearse
 * as most of them from a list of fifty — and the id the merchant asks for is
 * resolved separately (`approvedBuyer` below) rather than being looked for in
 * this window. Falling back to the first name in a truncated list meant
 * `?buyer=<a genuinely approved id>` answering as somebody else, with somebody
 * else's prices and terms, saying nothing.
 */
export async function testBuyers(
  t: Translate,
  options: { search?: string | null; limit?: number } = {},
): Promise<TestBuyerView[]> {
  const search = options.search?.trim();

  const rows = await db.customer.findMany({
    where: {
      status: "APPROVED",
      deletedInShopifyAt: null,
      ...(search
        ? {
            OR: [
              { company: { contains: search, mode: "insensitive" as const } },
              { email: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { company: "asc" },
    take: options.limit ?? TEST_BUYER_PAGE,
  });

  return rows.map((row) => ({ customerId: row.customerId, name: displayName(row, t) }));
}

/**
 * The buyer the merchant asked to rehearse as, if they may.
 *
 * Resolved by id against this shop's approved buyers rather than against
 * whatever page of them the picker happens to be showing. A customer id in a
 * query string is not proof of anything, and this screen reads a buyer's terms
 * and order history — so it is checked, and a miss is a miss rather than a
 * substitution.
 */
export async function approvedBuyer(
  customerId: string,
  t: Translate,
): Promise<TestBuyerView | null> {
  const row = await db.customer.findFirst({
    where: { customerId, status: "APPROVED", deletedInShopifyAt: null },
  });

  return row ? { customerId: row.customerId, name: displayName(row, t) } : null;
}

export function guardrailsView(
  guardrails: AgentGuardrails,
  readiness: PublishReadiness,
  options: {
    entitled: boolean;
    requiredPlan: string | null;
    saved?: boolean;
    justPublished?: boolean;
    refused?: string[];
    error?: { field: string; code: string } | null;
  },
): GuardrailsView {
  const instructions = guardrails.customInstructions ?? "";

  return {
    entitled: options.entitled,
    requiredPlan: options.requiredPlan,
    publish: {
      items: readiness.items.map((item) => ({ ...item })),
      ready: readiness.ready,
      published: readiness.published,
      embedLive: readiness.embed.live,
      embedAttested: readiness.embed.attested,
      storefrontUrl: readiness.storefrontUrl,
      justPublished: options.justPublished === true,
      refused: options.refused ?? [],
    },
    abilities: [
      { key: "canBuildCart", on: guardrails.canBuildCart },
      { key: "canRequestQuote", on: guardrails.canRequestQuote },
      { key: "canReadOrders", on: guardrails.canReadOrders },
      { key: "canReadTerms", on: guardrails.canReadTerms },
    ],
    guestMode: guardrails.guestMode,
    tone: guardrails.tone,
    tones: [...TONES],
    customInstructions: instructions,
    words: countWords(instructions),
    maxWords: MAX_INSTRUCTION_WORDS,
    // Linted on every read, not only on save: a merchant who switches an
    // ability off after writing their instructions has just created the
    // contradiction, and the warning belongs on the screen that shows both.
    warnings: lintInstructions(guardrails.customInstructions, guardrails),
    offLimits: guardrails.offLimits,
    reviewed: guardrails.reviewedAt !== null,
    saved: options.saved === true,
    error: options.error ?? null,
  };
}

/* -------------------------------------------------------------------------- */

export function logRowView(
  row: AgentConversation & { turns: number },
  options: { now: Date; locale: string; t: Translate },
): LogRowView {
  return {
    id: row.id,
    // The company, if we had one when they spoke. A buyer deleted in Shopify
    // since still reads as themselves, which is why it is denormalised.
    buyer: row.company ?? row.customerId ?? options.t("agent.log.visitor"),
    when: whenLabel(row.lastMessageAt, options.now, options.locale),
    at: row.lastMessageAt.toISOString(),
    outcome: row.outcome,
    turns: row.turns,
    testMode: row.testMode,
    takenOver: row.takenOverAt !== null,
  };
}

export function logView(
  page: LogPage,
  options: {
    now: Date;
    locale: string;
    t: Translate;
    published: boolean;
    entitled: boolean;
    requiredPlan: string | null;
    filters: { outcome: string; search: string };
  },
): LogView {
  return {
    rows: page.rows.map((row) => logRowView(row, options)),
    page: page.page,
    pageCount: page.pageCount,
    total: page.total,
    neverAny: page.neverAny,
    published: options.published,
    filters: options.filters,
    outcomes: [...OUTCOMES],
    entitled: options.entitled,
    requiredPlan: options.requiredPlan,
    retentionDays: CONVERSATION_RETENTION_DAYS,
  };
}

/**
 * What a stored turn was doing, read back for the merchant.
 *
 * `toolCalls` is JSON we wrote ourselves, but it is still JSON read from a
 * column: everything here is checked rather than asserted, so a row written by
 * an older version of this app renders as much as it can instead of throwing
 * on the one screen that exists to be readable.
 */
export function toolFacts(toolCalls: unknown): { tool: string | null; facts: string[] } {
  if (typeof toolCalls !== "object" || toolCalls === null) {
    return { tool: null, facts: [] };
  }

  const record = toolCalls as Record<string, unknown>;
  // Only a tool this version knows: the transcript renders
  // `agent.tool.<tool>`, so a row written by a later version with a new tool
  // name would print a raw catalogue key to the merchant.
  const tool =
    typeof record.tool === "string" && isToolName(record.tool) ? record.tool : null;
  const facts = Array.isArray(record.facts)
    ? record.facts.filter((fact): fact is string => typeof fact === "string")
    : [];

  const unknown = Array.isArray(record.unknownSkus)
    ? record.unknownSkus.filter((sku): sku is string => typeof sku === "string")
    : [];

  return {
    tool,
    facts: [...facts, ...unknown.map((sku) => `unknown_sku: ${sku}`)],
  };
}

/**
 * A refusal code, as a sentence.
 *
 * The column holds a machine's word — `quote_off`, `off_limits: supplier`,
 * `invented_figure` — and a merchant reading their own log should not have to
 * learn our vocabulary. Anything the catalogue does not know is shown as
 * itself rather than as a raw key, because a code we cannot explain is still
 * more use than nothing.
 */
export function refusalLabel(refusal: string | null, t: Translate): string {
  if (!refusal) return "";

  // Some carry a subject: "off_limits: our supplier".
  const [code = "", ...rest] = refusal.split(":");
  const subject = rest.join(":").trim();
  const key = `agent.refusal.${code.trim()}`;
  const sentence = t(key);

  if (sentence === key) return refusal;
  return subject ? `${sentence} (${subject})` : sentence;
}

/** The row `takeOver` writes to record that a person joined. */
const isJoinMarker = (message: Pick<AgentMessage, "role" | "refusal">) =>
  message.role === "AGENT" && message.refusal === "taken_over";

export function transcriptTurnView(
  message: AgentMessage,
  options: { now: Date; locale: string; t: Translate },
): TranscriptTurnView {
  const { tool, facts } = toolFacts(message.toolCalls);

  return {
    id: message.id,
    role: message.role,
    text: message.text,
    when: whenLabel(message.createdAt, options.now, options.locale),
    at: message.createdAt.toISOString(),
    refusal: message.refusal,
    refusalLabel: refusalLabel(message.refusal, options.t),
    joined: isJoinMarker(message),
    tool,
    facts,
  };
}

export function transcriptView(
  transcript: { conversation: AgentConversation; messages: AgentMessage[] },
  options: {
    now: Date;
    locale: string;
    t: Translate;
    entitled: boolean;
    sent?: boolean;
    tooLong?: boolean;
  },
): TranscriptView {
  const { conversation } = transcript;

  return {
    id: conversation.id,
    buyer:
      conversation.company ?? conversation.customerId ?? options.t("agent.log.visitor"),
    startedAt: whenLabel(conversation.startedAt, options.now, options.locale),
    outcome: conversation.outcome,
    testMode: conversation.testMode,
    takenOver: conversation.takenOverAt !== null,
    takenOverWhen: conversation.takenOverAt
      ? whenLabel(conversation.takenOverAt, options.now, options.locale)
      : null,
    turns: transcript.messages.map((message) => transcriptTurnView(message, options)),
    sent: options.sent === true,
    tooLong: options.tooLong === true,
    maxReplyChars: MAX_REPLY_CHARS,
    entitled: options.entitled,
  };
}
