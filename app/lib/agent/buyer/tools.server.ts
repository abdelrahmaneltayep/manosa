import {
  formatMoney,
  money,
  multiplyMoney,
  type Money,
  type PricingRule,
} from "@mannon/pricing-engine";

import { db } from "~/db.server";
import { recordAudit } from "~/lib/audit/record.server";
import { formatCurrency } from "~/lib/money";
import type { AdminGraphql } from "~/lib/pricing/admin-graphql.server";
import { productCollectionIds } from "~/lib/pricing/product-collections.server";
import { activeEngineRules } from "~/lib/pricing/rules.server";
import { priceLine, type BuyerForPricing } from "~/lib/quotes/pricing.server";
import { createQuote, draftQuote } from "~/lib/quotes/quotes.server";
import {
  findVariantsBySku,
  toMoney,
  variantTitle,
} from "~/lib/storefront/quick-order.server";

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
  productId: string;
  quantity: number;
  /** Formatted in the buyer's language, from the engine. */
  unitPrice: string;
  lineTotal: string;
  /** Minor units, for anything that compares rather than displays. */
  unitPriceAmount: number;
  /**
   * What the variant costs before any rule.
   *
   * Carried because anything that re-prices this line — a quote draft, most of
   * all — has to start from the list price. Handing the *discounted* price to
   * something that prices it again applies the discount twice.
   */
  listPrice: Money;
  /** Carried for the same reason as `listPrice`: anything that prices this
   * line again needs the whole context, not part of it. */
  collectionIds: string[];
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
   * Everything the reply is allowed to state, keyed by slot name.
   *
   * The model does not write numbers at all: it writes `{{f1}}` and this app
   * substitutes the value. So a price the agent invented is not a price that
   * slipped past a scanner — it is a digit outside a slot, which is refused.
   *
   * `f*` figures, `q*` quantities, `s*` codes and names, `d*` dates, `b*`
   * something the buyer themselves said.
   */
  slots: Record<string, string>;
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
  slots: {},
  facts: [],
  created: null,
  refusal: null,
});

/**
 * Build the slot table for a set of priced lines.
 *
 * One figure per unit price and per line total, one quantity and one code per
 * line, plus the subtotal. Named rather than numbered where it helps the model
 * pick the right one: `{{f1}}` is the first line's unit price, `{{t1}}` its
 * total, `{{q1}}` its quantity, `{{s1}}` its SKU.
 */
function slotsFor(
  lines: readonly PricedToolLine[],
  subtotal: string | null,
): Record<string, string> {
  const slots: Record<string, string> = {};

  lines.forEach((line, index) => {
    const at = index + 1;
    slots[`f${at}`] = line.unitPrice;
    slots[`t${at}`] = line.lineTotal;
    slots[`q${at}`] = String(line.quantity);
    slots[`s${at}`] = line.sku;
  });

  if (subtotal) slots.total = subtotal;
  return slots;
}

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
  /**
   * A merchant rehearsing, not a buyer shopping.
   *
   * Every read works exactly as it does for a buyer — that is the point of a
   * rehearsal — and every **write** is skipped and said out loud. A test that
   * quietly files a real quote request would teach the merchant that the panel
   * is safe to press right up until the day it is not.
   */
  testMode: boolean;
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

  // Two lines naming the same SKU are one line. A buyer who says "50 of the
  // blue mug, and another 50" means a hundred, not two lines the cart will
  // merge behind their back.
  const merged = new Map<string, ToolLineRequest>();
  for (const line of wanted) {
    const key = line.sku.trim().toLowerCase();
    const already = merged.get(key);
    merged.set(
      key,
      already
        ? { sku: already.sku, quantity: already.quantity + line.quantity }
        : { ...line },
    );
  }

  for (const line of merged.values()) {
    const node = variants.get(line.sku.trim().toLowerCase());
    if (!node) {
      unknownSkus.push(line.sku);
      continue;
    }
    if (node.product?.status && node.product.status.toUpperCase() !== "ACTIVE") {
      // A draft or archived product is not something a buyer can order. The
      // quick-order block refuses it for the same reason; the agent must not
      // be the softer door into the same catalogue.
      unknownSkus.push(line.sku);
      continue;
    }

    const quantity = Math.min(Math.max(1, Math.floor(line.quantity)), MAX_QUANTITY);
    const listPrice = toMoney(node.price, context.currencyCode);

    const priced = priceLine(
      {
        variantId: node.id,
        productId: node.product?.id ?? node.id,
        title: variantTitle(node),
        sku: node.sku ?? line.sku,
        quantity,
        listPrice,
        // The same metafield checkout reads, so what the agent quotes and what
        // the buyer is charged come from one answer.
        collectionIds: productCollectionIds(node.product),
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
      productId: node.product?.id ?? node.id,
      quantity,
      unitPrice: formatCurrency(priced.unitPrice, context.locale),
      lineTotal: formatCurrency(lineTotal, context.locale),
      unitPriceAmount: priced.unitPrice.amount,
      listPrice,
      collectionIds: productCollectionIds(node.product),
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
      return escalate(call, context);
    case "decline":
    default:
      return { ...empty("decline"), refusal: "off_limits" };
  }
}

async function priceFor(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  const { lines, unknownSkus, subtotal } = await priceLines(call.lines, context);
  const formattedSubtotal = formatCurrency(subtotal, context.locale);

  const showTotal = lines.length > 1 ? formattedSubtotal : null;
  return {
    ...empty("price_for"),
    lines,
    unknownSkus,
    subtotal: showTotal,
    slots: slotsFor(lines, showTotal),
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
    slots: slotsFor(lines, formattedSubtotal),
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

  const slots: Record<string, string> = {};
  orders.forEach((order, index) => {
    const at = index + 1;
    slots[`s${at}`] = order.name;
    slots[`f${at}`] = formatCurrency(
      money(order.totalPrice, order.currencyCode),
      context.locale,
    );
    slots[`d${at}`] = new Intl.DateTimeFormat(context.locale, {
      dateStyle: "medium",
    }).format(order.processedAt);
  });

  return {
    ...empty("order_status"),
    slots,
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
    slots: {
      owed: owedLabel,
      ...(limitLabel ? { limit: limitLabel } : {}),
      ...(buyer?.netTermsDays ? { days: String(buyer.netTermsDays) } : {}),
      invoices: String(outstanding.length),
    },
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

  const { lines, unknownSkus } = await priceLines([first], context);
  const line = lines[0];
  if (!line) return { ...empty("next_tier"), unknownSkus, refusal: "nothing_matched" };

  /**
   * The next break, found by asking the engine rather than by reading rules.
   *
   * Flattening every volume tier in the shop was wrong twice over: a tier
   * belonging to a rule aimed at somebody else's tag is not a break this buyer
   * can reach, and a tier that happens to be *worse* at a higher quantity would
   * be offered as an upgrade. So each candidate quantity is priced through the
   * same engine, for this buyer, on this product — and a break only counts if
   * the unit price actually falls.
   */
  const candidates = [...new Set(breakQuantities(line.quantity))].sort((a, b) => a - b);

  for (const quantity of candidates) {
    const at = await priceLines([{ sku: line.sku, quantity }], context);
    const upgraded = at.lines[0];
    if (!upgraded) break;
    if (upgraded.unitPriceAmount >= line.unitPriceAmount) continue;

    return {
      ...empty("next_tier"),
      lines,
      slots: {
        ...slotsFor(lines, null),
        better: upgraded.unitPrice,
        atQuantity: String(quantity),
        addUnits: String(quantity - line.quantity),
      },
      facts: [
        `current_quantity: ${line.quantity}`,
        `next_break_at: ${quantity}`,
        `units_to_add: ${quantity - line.quantity}`,
        `unit_price_at_break: ${upgraded.unitPrice}`,
        ...(upgraded.ruleSummary ? [`rule_at_break: ${upgraded.ruleSummary}`] : []),
      ],
    };
  }

  return {
    ...empty("next_tier"),
    lines,
    slots: slotsFor(lines, null),
    facts: [`no_better_price_above: ${line.quantity}`],
  };
}

/**
 * Quantities worth pricing when looking for the next break.
 *
 * Every tier boundary a merchant is likely to have set, above what the buyer
 * asked for. Cheap — each is one call to a pure function over rules already in
 * memory — and it needs no knowledge of which rule might apply, which is the
 * knowledge that made the first version of this wrong.
 */
function breakQuantities(from: number): number[] {
  const rounds = [5, 10, 12, 20, 24, 25, 48, 50, 96, 100, 144, 200, 250, 500, 1_000];
  const above = rounds.filter((value) => value > from);
  // Plus the next round hundred, for a buyer already past the usual breaks.
  const hundred = (Math.floor(from / 100) + 1) * 100;
  return [...above, hundred].filter((value) => value > from && value <= MAX_QUANTITY);
}

/**
 * Hand the buyer to a person, and leave the merchant something to answer.
 *
 * The checklist asks for an escalation "which files a message in the admin".
 * An audit entry is that message: it carries the buyer, their words and the
 * time, and it is already what Home's activity feed reads.
 */
async function escalate(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  const who = context.company ?? context.email ?? context.customerId ?? "A visitor";

  if (context.testMode) {
    return { ...empty("escalate"), refusal: "test_mode", facts: ["escalated"] };
  }

  await recordAudit({
    actor: { type: "BUYER_AGENT", label: "Claude" },
    action: "agent.escalated",
    summary: `${who} asked the Buyer Agent something only you can answer.`,
    metadata: { asked: (call.note ?? "").slice(0, 500) },
  });

  return { ...empty("escalate"), facts: ["escalated"] };
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
  // The one tool that writes, so the one tool a rehearsal must not run. The
  // reply says a quote was not filed rather than naming a number that is not
  // there: invariant 4 applies to the merchant reading their own test too.
  if (context.testMode) {
    return { ...empty("request_quote"), refusal: "test_mode", facts: ["would_quote"] };
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
  //
  // Priced *after* the quote exists, and failing softly: a catalogue lookup
  // that throws must not leave the buyer's request lost. A `NEW` quote with
  // the buyer's own words on it is exactly what the merchant needs to answer;
  // an exception here would have deleted that and told the buyer nothing.
  const { lines } = await priceLines(call.lines, context).catch((error: unknown) => {
    console.error(
      `[mannon] could not price a Buyer Agent quote request: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { lines: [] as PricedToolLine[] };
  });

  if (lines.length > 0) {
    await draftQuote(
      quote.id,
      {
        // The **list** price, and the real product id. `draftQuote` prices
        // these through the engine itself; handing it the price the engine
        // already produced would apply the rule twice, and dropping the
        // product id would lose every product-scoped rule that just matched.
        lines: lines.map((line) => ({
          variantId: line.variantId,
          productId: line.productId,
          title: line.title,
          sku: line.sku,
          quantity: line.quantity,
          listPrice: line.listPrice,
          // Carried through for the same reason as the product id: dropping it
          // would lose every collection-scoped rule that just matched, and the
          // drafted quote would lock a price the agent did not quote.
          collectionIds: line.collectionIds,
        })),
      },
      { actor: { type: "BUYER_AGENT", label: "Claude" }, now: context.now },
    ).catch((error: unknown) => {
      // Same reasoning: the request stands even when the pricing of it does
      // not. The merchant prices a `NEW` quote by hand every day.
      console.error(
        `[mannon] could not draft a Buyer Agent quote request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  return {
    ...empty("request_quote"),
    created: { kind: "quote", id: quote.id, label: quote.number },
    slots: { reference: quote.number },
    facts: [`quote_number: ${quote.number}`],
  };
}

/** The engine's own decimal, for anything that has to round-trip a price. */
export const asDecimal = (value: Money) => formatMoney(value);
