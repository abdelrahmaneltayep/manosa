import {
  formatMoney,
  money,
  multiplyMoney,
  nextVolumeTier,
  type Money,
  type PricingRule,
} from "@mannon/pricing-engine";

import { db } from "~/db.server";
import { formatCurrency } from "~/lib/money";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { activeEngineRules } from "~/lib/pricing/rules.server";
import { priceLine, type BuyerForPricing } from "~/lib/quotes/pricing.server";
import { createQuote, draftQuote } from "~/lib/quotes/quotes.server";
import { findVariantsBySku, toMoney } from "~/lib/storefront/quick-order.server";

/**
 * Everything the Buyer Agent can do, and nothing else.
 *
 * The model chooses a tool and its arguments. It never executes one: each
 * branch below is this app's own code, running in this shop's tenant scope,
 * against this buyer's own rows. Which means the security model of the whole
 * feature is the length of this list.
 *
 * Two consequences worth stating plainly:
 *
 * - **There is no tool that checks out.** The agent assembles lines; the buyer
 *   presses a button that hands them to Shopify's own cart. A conversation
 *   cannot end in a charge.
 * - **There is no tool that sets a price.** `price_for` and `build_cart` both
 *   go through `priceLine`, the same engine the checkout Function runs. The
 *   agent can report a price; it has nowhere to write one.
 */

export const TOOL_NAMES = [
  "price_for",
  "build_cart",
  "order_status",
  "my_terms",
  "next_tier",
  "request_quote",
  "escalate",
  "decline",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const isToolName = (value: string): value is ToolName =>
  (TOOL_NAMES as readonly string[]).includes(value);

/** Lines a buyer can be quoted or sold in one turn. */
export const MAX_LINES = 20;
/** The most units one line may carry. Beyond this it is a quote, not a cart. */
export const MAX_QUANTITY = 100_000;
/** Orders read for "where is my last order?". */
export const ORDER_LOOKBACK = 5;

export interface ToolLineRequest {
  sku: string;
  quantity: number;
}

export interface ToolCall {
  tool: ToolName;
  lines: ToolLineRequest[];
  /** For `request_quote` and `escalate`: what the buyer actually asked for. */
  note: string | null;
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

export interface PricedToolLine {
  sku: string;
  title: string;
  variantId: string;
  quantity: number;
  /** Formatted in the buyer's language, from the engine. */
  unitPrice: string;
  lineTotal: string;
  /** Minor units, for anything that compares rather than displays. */
  unitPriceAmount: number;
  /** Which rule set it — deciding shows its working, for buyers too. */
  ruleSummary: string | null;
}

export interface ToolResult {
  tool: ToolName;
  /** Lines, when the tool produced any. */
  lines: PricedToolLine[];
  subtotal: string | null;
  /** SKUs the catalogue does not have. Listed, never quietly dropped. */
  unknownSkus: string[];
  /**
   * Every figure this turn is allowed to state, already formatted.
   *
   * The model may only repeat these. `statedFigures` in the prompt module
   * checks the reply against this set, so a price the agent invented is a
   * refused turn rather than a promise the merchant has to honour.
   */
  figures: string[];
  /** Facts the model may use in its sentence, as short strings. */
  facts: string[];
  /** Set when the tool created something: a quote number, a cart token. */
  created: { kind: "quote"; id: string; label: string } | null;
  /** Set when a guardrail refused. The turn is answered from a script. */
  refusal: string | null;
}

const empty = (tool: ToolName): ToolResult => ({
  tool,
  lines: [],
  subtotal: null,
  unknownSkus: [],
  figures: [],
  facts: [],
  created: null,
  refusal: null,
});

export interface ToolContext {
  admin: AdminGraphql;
  buyer: BuyerForPricing;
  /** The mirrored customer row, when there is one. */
  customerId: string | null;
  company: string | null;
  email: string | null;
  currencyCode: string;
  locale: string;
  now: Date;
  abilities: {
    canBuildCart: boolean;
    canRequestQuote: boolean;
    canReadOrders: boolean;
    canReadTerms: boolean;
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Price the requested lines through the engine.
 *
 * Shared by `price_for`, `build_cart` and `next_tier`, because a price the
 * agent states and a price it puts in a cart must be the same number computed
 * the same way. A SKU the catalogue does not have comes back in `unknownSkus`;
 * it is never silently omitted from a subtotal the buyer is reading.
 */
async function priceLines(
  requested: readonly ToolLineRequest[],
  context: ToolContext,
): Promise<{
  lines: PricedToolLine[];
  unknownSkus: string[];
  subtotal: Money;
  rules: PricingRule[];
}> {
  const wanted = requested.slice(0, MAX_LINES);
  const [variants, { rules }] = await Promise.all([
    findVariantsBySku(
      context.admin,
      wanted.map((line) => line.sku),
    ),
    activeEngineRules(),
  ]);

  const lines: PricedToolLine[] = [];
  const unknownSkus: string[] = [];
  let subtotal = 0;

  for (const line of wanted) {
    const node = variants.get(line.sku.trim().toLowerCase());
    if (!node) {
      unknownSkus.push(line.sku);
      continue;
    }

    const quantity = Math.min(Math.max(1, Math.floor(line.quantity)), MAX_QUANTITY);
    const listPrice = toMoney(node.price, context.currencyCode);

    const priced = priceLine(
      {
        variantId: node.id,
        productId: node.product?.id ?? node.id,
        title: node.product?.title ?? node.sku ?? node.id,
        sku: node.sku ?? line.sku,
        quantity,
        listPrice,
      },
      context.buyer,
      rules,
      { now: context.now, currencyCode: context.currencyCode },
    );

    const lineTotal = multiplyMoney(priced.unitPrice, quantity);
    subtotal += lineTotal.amount;

    lines.push({
      sku: node.sku ?? line.sku,
      title: priced.title,
      variantId: node.id,
      quantity,
      unitPrice: formatCurrency(priced.unitPrice, context.locale),
      lineTotal: formatCurrency(lineTotal, context.locale),
      unitPriceAmount: priced.unitPrice.amount,
      ruleSummary: priced.ruleSummary,
    });
  }

  return {
    lines,
    unknownSkus,
    subtotal: money(subtotal, context.currencyCode),
    rules,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Run one tool.
 *
 * Never throws for a guardrail: a refusal is a result with `refusal` set, so
 * the caller can answer the buyer with a sentence rather than an error page.
 */
export async function runTool(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  switch (call.tool) {
    case "price_for":
      return priceFor(call, context);
    case "build_cart":
      return buildCart(call, context);
    case "order_status":
      return orderStatus(context);
    case "my_terms":
      return myTerms(context);
    case "next_tier":
      return nextTier(call, context);
    case "request_quote":
      return requestQuote(call, context);
    case "escalate":
      return { ...empty("escalate"), facts: ["escalated"] };
    case "decline":
    default:
      return { ...empty("decline"), refusal: "off_limits" };
  }
}

async function priceFor(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  const { lines, unknownSkus, subtotal } = await priceLines(call.lines, context);
  const formattedSubtotal = formatCurrency(subtotal, context.locale);

  return {
    ...empty("price_for"),
    lines,
    unknownSkus,
    subtotal: lines.length > 1 ? formattedSubtotal : null,
    figures: figuresOf(lines, lines.length > 1 ? formattedSubtotal : null),
    facts: lines.map((line) =>
      line.ruleSummary ? `${line.sku}: ${line.ruleSummary}` : `${line.sku}: list price`,
    ),
  };
}

async function buildCart(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  if (!context.abilities.canBuildCart) {
    return { ...empty("build_cart"), refusal: "cart_off" };
  }

  const { lines, unknownSkus, subtotal } = await priceLines(call.lines, context);
  if (lines.length === 0) {
    return { ...empty("build_cart"), unknownSkus, refusal: "nothing_matched" };
  }

  const formattedSubtotal = formatCurrency(subtotal, context.locale);
  return {
    ...empty("build_cart"),
    lines,
    unknownSkus,
    subtotal: formattedSubtotal,
    figures: figuresOf(lines, formattedSubtotal),
    facts: ["cart_built"],
  };
}

async function orderStatus(context: ToolContext): Promise<ToolResult> {
  if (!context.abilities.canReadOrders) {
    return { ...empty("order_status"), refusal: "orders_off" };
  }
  if (!context.customerId) {
    return { ...empty("order_status"), refusal: "sign_in" };
  }

  const orders = await db.order.findMany({
    where: { customerId: context.customerId },
    orderBy: { processedAt: "desc" },
    take: ORDER_LOOKBACK,
    select: {
      name: true,
      processedAt: true,
      financialStatus: true,
      fulfillmentStatus: true,
      totalPrice: true,
      currencyCode: true,
    },
  });

  const figures = orders.map((order) =>
    formatCurrency(money(order.totalPrice, order.currencyCode), context.locale),
  );

  return {
    ...empty("order_status"),
    figures,
    facts: orders.map(
      (order) =>
        `${order.name} · ${order.processedAt.toISOString().slice(0, 10)} · ${
          order.fulfillmentStatus ?? "unfulfilled"
        } · ${order.financialStatus ?? "unpaid"} · ${formatCurrency(
          money(order.totalPrice, order.currencyCode),
          context.locale,
        )}`,
    ),
  };
}

async function myTerms(context: ToolContext): Promise<ToolResult> {
  if (!context.abilities.canReadTerms) {
    return { ...empty("my_terms"), refusal: "terms_off" };
  }
  if (!context.customerId) {
    return { ...empty("my_terms"), refusal: "sign_in" };
  }

  const buyer = await db.customer.findFirst({
    where: { customerId: context.customerId },
    select: { netTermsDays: true, creditLimit: true, currencyCode: true },
  });

  const outstanding = await db.order.findMany({
    where: {
      customerId: context.customerId,
      paidAt: null,
      cancelledAt: null,
      netTermsDueAt: { not: null },
    },
    select: {
      totalPrice: true,
      amountPaid: true,
      currencyCode: true,
      netTermsDueAt: true,
    },
  });

  const owed = outstanding
    .filter((order) => order.currencyCode === context.currencyCode)
    .reduce((sum, order) => sum + Math.max(0, order.totalPrice - order.amountPaid), 0);

  const owedLabel = formatCurrency(money(owed, context.currencyCode), context.locale);
  const limitLabel =
    buyer?.creditLimit === null || buyer?.creditLimit === undefined
      ? null
      : formatCurrency(
          money(buyer.creditLimit, buyer.currencyCode ?? context.currencyCode),
          context.locale,
        );

  return {
    ...empty("my_terms"),
    figures: [owedLabel, ...(limitLabel ? [limitLabel] : [])],
    facts: [
      buyer?.netTermsDays
        ? `net_terms_days: ${buyer.netTermsDays}`
        : "net_terms_days: none",
      `outstanding: ${owedLabel}`,
      ...(limitLabel ? [`credit_limit: ${limitLabel}`] : []),
      `unpaid_invoices: ${outstanding.length}`,
    ],
  };
}

/**
 * "Add 8 more and you unlock the 12% tier."
 *
 * Computed, not guessed: the break comes from `nextVolumeTier` over the same
 * rules that priced the line, and the price at that break is the engine's
 * answer to the same question with a bigger quantity.
 */
async function nextTier(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  const first = call.lines[0];
  if (!first) return { ...empty("next_tier"), refusal: "nothing_matched" };

  const { lines, unknownSkus, rules } = await priceLines([first], context);
  const line = lines[0];
  if (!line) return { ...empty("next_tier"), unknownSkus, refusal: "nothing_matched" };

  const breaks = rules.flatMap((rule) =>
    rule.kind === "volume_tier" ? rule.value.tiers : [],
  );
  const next = nextVolumeTier(breaks, line.quantity);

  if (!next) {
    return {
      ...empty("next_tier"),
      lines,
      figures: figuresOf(lines, null),
      facts: [`no_further_tier_above: ${line.quantity}`],
    };
  }

  const atNext = await priceLines(
    [{ sku: line.sku, quantity: next.minQuantity }],
    context,
  );
  const upgraded = atNext.lines[0];

  return {
    ...empty("next_tier"),
    lines,
    figures: [
      ...figuresOf(lines, null),
      ...(upgraded ? figuresOf(atNext.lines, null) : []),
    ],
    facts: [
      `current_quantity: ${line.quantity}`,
      `next_break_at: ${next.minQuantity}`,
      `units_to_add: ${next.minQuantity - line.quantity}`,
      ...(upgraded ? [`unit_price_at_break: ${upgraded.unitPrice}`] : []),
    ],
  };
}

/**
 * File a quote request for the merchant to price.
 *
 * The one tool that writes, and it writes a *request*: a `NEW` quote with the
 * buyer's own words on it. Nothing is priced, nothing is promised, and the
 * merchant prices it in the admin exactly as they would one that arrived from
 * the storefront form.
 */
async function requestQuote(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  if (!context.abilities.canRequestQuote) {
    return { ...empty("request_quote"), refusal: "quote_off" };
  }
  if (!context.customerId) {
    return { ...empty("request_quote"), refusal: "sign_in" };
  }

  const quote = await createQuote(
    {
      customerId: context.customerId,
      email: context.email,
      company: context.company,
      requestNote: (call.note ?? "").slice(0, 1_000) || null,
      source: "BUYER_AGENT",
    },
    { actor: { type: "BUYER_AGENT", label: "Claude" } },
  );

  // Lines the buyer named are attached unpriced-by-the-agent: `draftQuote`
  // prices them through the engine, and the merchant sees what we would charge
  // before deciding what they will.
  const { lines } = await priceLines(call.lines, context);
  if (lines.length > 0) {
    await draftQuote(
      quote.id,
      {
        lines: lines.map((line) => ({
          variantId: line.variantId,
          productId: null,
          title: line.title,
          sku: line.sku,
          quantity: line.quantity,
          listPrice: money(line.unitPriceAmount, context.currencyCode),
        })),
      },
      { actor: { type: "BUYER_AGENT", label: "Claude" }, now: context.now },
    );
  }

  return {
    ...empty("request_quote"),
    created: { kind: "quote", id: quote.id, label: quote.number },
    facts: [`quote_number: ${quote.number}`],
  };
}

/** Every figure a turn may repeat, deduplicated. */
function figuresOf(lines: readonly PricedToolLine[], subtotal: string | null): string[] {
  const figures = new Set<string>();
  for (const line of lines) {
    figures.add(line.unitPrice);
    figures.add(line.lineTotal);
  }
  if (subtotal) figures.add(subtotal);
  return [...figures];
}

/** The engine's own decimal, for anything that has to round-trip a price. */
export const asDecimal = (value: Money) => formatMoney(value);
