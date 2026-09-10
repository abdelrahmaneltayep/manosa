import { db } from "~/db.server";
import type { AiDeps, AiFailure } from "~/lib/ai/run.server";
import {
  routeBuyerTurn,
  unbackedFigures,
  writeBuyerReply,
  MAX_MESSAGE_CHARS,
  type AgentTurnGrounding,
} from "~/lib/ai/prompts/buyer-agent.server";
import {
  appendTurn,
  historyFor,
  openConversation,
  outcomeFor,
  recordOutcome,
} from "~/lib/agent/buyer/conversation.server";
import { loadGuardrails } from "~/lib/agent/buyer/guardrails.server";
import {
  runTool,
  type PricedToolLine,
  type ToolContext,
  type ToolName,
  type ToolResult,
} from "~/lib/agent/buyer/tools.server";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { buyerFacts } from "~/lib/storefront/quick-order.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * One turn of a buyer's conversation, end to end.
 *
 * Route → run one tool → write the reply → check the reply against what the
 * tool computed → store both halves. Every step can fail without the buyer
 * seeing an error page: a turn that cannot be completed comes back as a
 * `failure`, and the widget says so and points at the quick-order form.
 *
 * The order matters. The tool runs **before** the reply is written, so the
 * figures the model may state are figures that already exist. Asking a model
 * for an answer and then trying to verify it after the fact is the version of
 * this that does not work.
 */

/**
 * Why a turn could not be answered.
 *
 * Every `AiFailure` is one of these, so a model failure passes straight
 * through with no cast and the widget has a sentence for each.
 */
export type TurnFailure =
  AiFailure | "not_published" | "guest" | "taken_over" | "empty" | "unbacked_figure";

export interface TurnCart {
  lines: PricedToolLine[];
  subtotal: string;
}

export interface TurnResult {
  conversationId: string;
  /** What the buyer reads. Null when the turn failed. */
  reply: string | null;
  /** The cart card, when one was assembled. */
  cart: TurnCart | null;
  /** The quote number, when one was filed. */
  quote: string | null;
  /** Which tool ran, for the transcript. */
  tool: ToolName | null;
  /** Why the agent could not answer. Null on success. */
  failure: TurnFailure | null;
  /** Why a tool refused, when the answer is a scripted decline. */
  refusal: string | null;
}

export interface TurnInput {
  message: string;
  customerId: string | null;
  locale: string;
  admin: AdminGraphql;
  now?: Date;
}

const failed = (
  conversationId: string,
  failure: TurnFailure,
  tool: ToolName | null = null,
): TurnResult => ({
  conversationId,
  reply: null,
  cart: null,
  quote: null,
  tool,
  failure,
  refusal: null,
});

/**
 * Answer one message.
 *
 * Assumes the caller has already proved which shop and which buyer this is —
 * on the storefront that is the App Proxy's signature, and nothing else is
 * accepted as proof of a customer id.
 */
export async function answerBuyerTurn(
  input: TurnInput,
  deps: AiDeps = {},
): Promise<TurnResult> {
  const now = input.now ?? new Date();
  const shop = shopScope.require("buyer agent turn");

  const guardrails = await loadGuardrails();
  const message = input.message.trim().slice(0, MAX_MESSAGE_CHARS);

  const buyer = input.customerId
    ? await db.customer.findFirst({
        where: { customerId: input.customerId },
        select: { company: true, email: true, status: true },
      })
    : null;

  const conversation = await openConversation({
    customerId: input.customerId,
    company: buyer?.company ?? null,
    locale: input.locale,
    now,
  });

  if (!guardrails.published) return failed(conversation.id, "not_published");

  // A signed-out visitor, or one whose application has not been approved, is
  // not a wholesale buyer — and this agent knows nothing else.
  const approved = buyer?.status === "APPROVED";
  if (!approved && !guardrails.guestMode) return failed(conversation.id, "guest");

  // A merchant is in this conversation. The agent stops talking mid-thread
  // rather than talking over them.
  if (conversation.takenOverAt) return failed(conversation.id, "taken_over");

  if (message === "") return failed(conversation.id, "empty");

  await appendTurn(conversation.id, { role: "BUYER", text: message }, { now });

  const shopRow = await db.shop.findUnique({ where: { shop } });
  const currencyCode = shopRow?.currencyCode ?? "USD";

  const grounding: AgentTurnGrounding = {
    company: buyer?.company ?? null,
    locale: input.locale,
    currencyCode,
    tone: guardrails.tone,
    customInstructions: guardrails.customInstructions,
    offLimits: guardrails.offLimits,
    allowed: allowedTools(guardrails),
    signedIn: Boolean(input.customerId),
  };

  const history = await historyFor(conversation.id);
  const routed = await routeBuyerTurn(
    { message, history: history.slice(0, -1), grounding, actorId: input.customerId },
    deps,
  );

  if (!routed.ok) return failed(conversation.id, routed.reason);

  const context: ToolContext = {
    admin: input.admin,
    buyer: await buyerFacts(input.customerId),
    customerId: input.customerId,
    company: buyer?.company ?? null,
    email: buyer?.email ?? null,
    currencyCode,
    locale: input.locale,
    now,
    abilities: {
      canBuildCart: guardrails.canBuildCart,
      canRequestQuote: guardrails.canRequestQuote,
      canReadOrders: guardrails.canReadOrders,
      canReadTerms: guardrails.canReadTerms,
    },
  };

  const result = await runTool(routed.value.call, context);

  const written = await writeBuyerReply(
    { message, result, grounding, actorId: input.customerId },
    deps,
  );

  if (!written.ok) {
    // A reply that could not be written is not a reply the buyer gets a
    // half-version of. The turn is recorded with the reason, so the merchant's
    // conversation log shows the gap rather than hiding it.
    await appendTurn(
      conversation.id,
      {
        role: "AGENT",
        text: "",
        refusal: written.reason,
        toolCalls: toolRecord(routed.value.call.tool, result),
      },
      { now },
    );
    return failed(conversation.id, written.reason, result.tool);
  }

  // Belt and braces. `writeBuyerReply` already refuses an unbacked figure in
  // its validator, so this can only fire if that check is ever weakened — and
  // it is the one check that must not be weakened by accident.
  const unbacked = unbackedFigures(written.value.reply, result.figures);
  if (unbacked.length > 0) {
    await appendTurn(
      conversation.id,
      {
        role: "AGENT",
        text: "",
        refusal: `unbacked_figure: ${unbacked.join(", ")}`,
        toolCalls: toolRecord(routed.value.call.tool, result),
      },
      { now },
    );
    return failed(conversation.id, "unbacked_figure", result.tool);
  }

  await appendTurn(
    conversation.id,
    {
      role: "AGENT",
      text: written.value.reply,
      refusal: result.refusal,
      toolCalls: toolRecord(routed.value.call.tool, result),
      ai: {
        model: written.model,
        promptVersion: written.promptVersion,
        requestId: written.requestId,
      },
    },
    { now },
  );

  await recordOutcome(conversation.id, outcomeFor(result));

  return {
    conversationId: conversation.id,
    reply: written.value.reply,
    cart:
      result.tool === "build_cart" && result.lines.length > 0 && result.subtotal
        ? { lines: result.lines, subtotal: result.subtotal }
        : null,
    quote: result.created?.kind === "quote" ? result.created.label : null,
    tool: result.tool,
    failure: null,
    refusal: result.refusal,
  };
}

/** The tools this shop's guardrails leave switched on. */
export function allowedTools(guardrails: {
  canBuildCart: boolean;
  canRequestQuote: boolean;
  canReadOrders: boolean;
  canReadTerms: boolean;
}): string[] {
  return [
    "price_for",
    "next_tier",
    ...(guardrails.canBuildCart ? ["build_cart"] : []),
    ...(guardrails.canRequestQuote ? ["request_quote"] : []),
    ...(guardrails.canReadOrders ? ["order_status"] : []),
    ...(guardrails.canReadTerms ? ["my_terms"] : []),
    "escalate",
    "decline",
  ];
}

/** What goes in the transcript's `toolCalls`, for "why did it say that?". */
function toolRecord(tool: ToolName, result: ToolResult) {
  return {
    tool,
    figures: result.figures,
    facts: result.facts,
    unknownSkus: result.unknownSkus,
    refusal: result.refusal,
    created: result.created?.label ?? null,
  };
}
