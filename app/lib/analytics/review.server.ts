import { money, type Money } from "@mannon/pricing-engine";

import { db } from "~/db.server";
import { amountOwed, orderRevenue, orderRevenueOfSum } from "~/lib/orders/totals";
import { localDay } from "~/lib/analytics/series.server";
import { formatCurrency } from "~/lib/money";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * The figures a month's review is written from.
 *
 * A **calendar month in the shop's own timezone**, not a rolling thirty days:
 * the month a merchant means is their month, and "March" that begins on the
 * 28th of February for a Sydney shop is not March. Everything here is computed
 * before the model sees anything, and the model only ever writes prose around
 * the slot names — so a review cannot contain a figure this module did not
 * produce.
 */

export interface MonthFacts {
  /** `YYYY-MM`, in the shop's timezone. */
  month: string;
  currencyCode: string;
  wholesaleRevenue: Money;
  retailRevenue: Money;
  wholesaleOrders: number;
  buyers: number;
  newBuyers: number;
  applications: number;
  approvals: number;
  owedNow: Money;
  overdueNow: Money;
  topBuyer: { label: string; amount: Money } | null;
  topProduct: { label: string; amount: Money } | null;
  /** Rules that priced nothing all month, by the name the buyer saw. */
  deadRules: string[];
  /** Buyers who bought last month and not this one. */
  quietBuyers: number;
}

export interface MonthDiff {
  wholesaleRevenue: number;
  wholesaleOrders: number;
  buyers: number;
}

/** Every real UTC offset is a whole number of these. */
const QUARTER_HOUR = 15 * 60 * 1000;
/** Wider than the widest offset either way (UTC−12 … UTC+14). */
const BRACKET = 2 * 24 * 60 * 60 * 1000;

/**
 * The first instant of a `YYYY-MM` in a given zone, as a UTC `Date`.
 *
 * Binary search between two instants that are certainly on either side of it,
 * on a fifteen-minute grid because Kathmandu and Chatham are not on the hour.
 *
 * The previous version started at midday UTC on the 1st and walked *backwards*
 * an hour at a time while the local day was still the 1st. It could never walk
 * forwards, so for every zone at UTC+12 or further east — Auckland, Chatham,
 * Apia, Tongatapu, Kiritimati — midday UTC on the 1st is already the **2nd**
 * locally, the loop never ran, and the month began at 01:00 on the 2nd. Every
 * order placed on the 1st landed in the month before, and the review the
 * checklist requires on the 1st was written on the 2nd. The hour step also
 * could not land on a :45 boundary, so Kathmandu and Eucla lost 45 minutes of
 * every month.
 */
export function monthStart(month: string, timeZone: string | null): Date {
  const [year, index] = month.split("-").map(Number);
  const base = Date.UTC(year!, index! - 1, 1);
  const first = `${month}-01`;

  // Monotonic: local time only moves forward, and `YYYY-MM-DD` sorts as dates.
  const reached = (at: number) => localDay(new Date(at), timeZone) >= first;

  let before = Math.floor((base - BRACKET) / QUARTER_HOUR);
  let after = Math.ceil((base + BRACKET) / QUARTER_HOUR);

  while (after - before > 1) {
    const mid = Math.floor((before + after) / 2);
    if (reached(mid * QUARTER_HOUR)) after = mid;
    else before = mid;
  }
  return new Date(after * QUARTER_HOUR);
}

/** The `YYYY-MM` an instant falls in, in the shop's own zone. */
export const monthOf = (at: Date, timeZone: string | null): string =>
  localDay(at, timeZone).slice(0, 7);

/** The month before a `YYYY-MM`. */
export function previousMonth(month: string): string {
  const [year, index] = month.split("-").map(Number);
  const previous = index! === 1 ? 12 : index! - 1;
  const inYear = index! === 1 ? year! - 1 : year!;
  return `${inYear}-${String(previous).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */

export async function monthFacts(month: string, now = new Date()): Promise<MonthFacts> {
  const name = shopScope.require("monthly review facts");
  const shop = await db.shop.findUnique({ where: { shop: name } });

  const currencyCode = shop?.currencyCode ?? "USD";
  const timeZone = shop?.ianaTimezone ?? null;
  const start = monthStart(month, timeZone);
  const end = monthStart(nextMonth(month), timeZone);
  const previousStart = monthStart(previousMonth(month), timeZone);

  const window = { gte: start, lt: end };
  const inCurrency = { currencyCode, cancelledAt: null };

  const [orders, lastMonthBuyers, applications, approvals, outstanding, rules] =
    await Promise.all([
      db.order.findMany({
        where: { ...inCurrency, isWholesale: true, processedAt: window },
        select: {
          id: true,
          customerId: true,
          company: true,
          totalPrice: true,
          refundedAmount: true,
        },
      }),
      db.order.findMany({
        where: {
          ...inCurrency,
          isWholesale: true,
          processedAt: { gte: previousStart, lt: start },
        },
        select: { customerId: true },
        distinct: ["customerId"],
      }),
      db.formSubmission.count({ where: { createdAt: window } }),
      db.formSubmission.count({ where: { status: "APPROVED", decidedAt: window } }),
      db.order.findMany({
        where: {
          ...inCurrency,
          isWholesale: true,
          paidAt: null,
          netTermsDueAt: { not: null },
        },
        select: {
          totalPrice: true,
          refundedAmount: true,
          amountPaid: true,
          netTermsDueAt: true,
        },
      }),
      db.pricingRule.findMany({
        where: { status: "ACTIVE", archivedAt: null },
        select: {
          name: true,
          createdAt: true,
          updatedAt: true,
          startsAt: true,
          endsAt: true,
        },
      }),
    ]);

  const net = orderRevenue;

  const retail = await db.order.aggregate({
    where: { ...inCurrency, isWholesale: false, processedAt: window },
    // `refundedAmount` is deliberately not summed: `totalPrice` is already net
    // of refunds, and subtracting it here is what made this permanent figure
    // disagree with the charts the review links to.
    _sum: { totalPrice: true },
  });

  const orderIds = orders.map((order) => order.id);
  const [lines, retailTotal] = await Promise.all([
    orderIds.length === 0
      ? Promise.resolve([])
      : db.orderLine.findMany({
          where: { orderId: { in: orderIds } },
          select: { title: true, productId: true, currentTotal: true, discounts: true },
        }),
    Promise.resolve(orderRevenueOfSum(retail._sum)),
  ]);

  const buyerIds = new Set(
    orders.map((order) => order.customerId).filter((id): id is string => Boolean(id)),
  );
  const lastMonthIds = new Set(
    lastMonthBuyers
      .map((order) => order.customerId)
      .filter((id): id is string => Boolean(id)),
  );

  const owed = outstanding.reduce((sum, order) => sum + amountOwed(order), 0);
  const overdue = outstanding
    .filter((order) => order.netTermsDueAt !== null && order.netTermsDueAt < now)
    .reduce((sum, order) => sum + amountOwed(order), 0);

  const pricedRuleNames = new Set(
    lines.flatMap((line) =>
      Array.isArray(line.discounts)
        ? line.discounts.flatMap((entry) =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as { title?: unknown }).title === "string"
              ? [(entry as { title: string }).title]
              : [],
          )
        : [],
    ),
  );

  return {
    month,
    currencyCode,
    wholesaleRevenue: money(
      orders.reduce((sum, order) => sum + net(order), 0),
      currencyCode,
    ),
    retailRevenue: money(retailTotal, currencyCode),
    wholesaleOrders: orders.length,
    buyers: buyerIds.size,
    // Bought this month and not the month before. A shop's very first month
    // has no "before", so everybody in it is new, which is true.
    newBuyers: [...buyerIds].filter((id) => !lastMonthIds.has(id)).length,
    applications,
    approvals,
    owedNow: money(owed, currencyCode),
    overdueNow: money(overdue, currencyCode),
    topBuyer: topOf(
      orders.map((order) => ({
        label: order.company ?? order.customerId ?? "",
        value: net(order),
      })),
      currencyCode,
    ),
    topProduct: topOf(
      lines.map((line) => ({ label: line.title, value: line.currentTotal })),
      currencyCode,
    ),
    // An **active** rule that priced nothing all month is the checklist's
    // "dead rules to archive". A draft one priced nothing because it is a
    // draft, which is not news.
    //
    // Three ways a live rule looked dead and was not, all of which produced a
    // permanent, stored recommendation to archive something that is earning:
    // a rule created *after* the month ended had obviously priced nothing in
    // it; a rule scheduled to start later likewise; and a **renamed** rule
    // keeps its history under the old name, because rule performance is read
    // from the discount title the buyer saw, so its current name appears
    // nowhere in the month. `updatedAt` cannot tell a rename from any other
    // edit, so any rule touched during or after the month is left alone. This
    // can only under-report, which is the right direction for advice that is
    // kept forever.
    deadRules: rules
      .filter(
        (rule) =>
          rule.createdAt <= start &&
          rule.updatedAt < start &&
          (rule.startsAt === null || rule.startsAt <= start) &&
          (rule.endsAt === null || rule.endsAt >= end),
      )
      .map((rule) => rule.name)
      .filter((name) => !pricedRuleNames.has(name))
      .slice(0, 5),
    quietBuyers: [...lastMonthIds].filter((id) => !buyerIds.has(id)).length,
  };
}

export const nextMonth = (month: string): string => {
  const [year, index] = month.split("-").map(Number);
  const next = index! === 12 ? 1 : index! + 1;
  const inYear = index! === 12 ? year! + 1 : year!;
  return `${inYear}-${String(next).padStart(2, "0")}`;
};

function topOf(
  rows: { label: string; value: number }[],
  currencyCode: string,
): { label: string; amount: Money } | null {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.label === "") continue;
    totals.set(row.label, (totals.get(row.label) ?? 0) + row.value);
  }

  const best = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0
    ? { label: best[0], amount: money(best[1], currencyCode) }
    : null;
}

/* -------------------------------------------------------------------------- */

/**
 * What the model is told, and the only figures it may write.
 *
 * Facts carry slot names rather than numbers, so a sentence built from them is
 * a sentence this app can fill in — and one that writes a figure any other way
 * is refused by `readReview`.
 */
export function factLines(
  facts: MonthFacts,
  locale: string,
  /**
   * Namespace for the slot names.
   *
   * Last month's facts must not reuse this month's slot names. They did: both
   * months were rendered as the same template strings and only this month's
   * values were supplied, so the model was asked to compare two months and
   * handed one twice — and a sentence saying "last month you took {{f1}}"
   * passed the check and was filled with *this* month's revenue, permanently.
   */
  prefix = "",
): { facts: string[]; slots: Record<string, string> } {
  const cash = (value: Money) => formatCurrency(value, locale);
  const at = (name: string) => `${prefix}${name}`;
  const slot = (name: string) => `{{${at(name)}}}`;

  const slots: Record<string, string> = {
    [at("f1")]: cash(facts.wholesaleRevenue),
    [at("f2")]: cash(facts.retailRevenue),
    [at("f3")]: cash(facts.owedNow),
    [at("f4")]: cash(facts.overdueNow),
    [at("q1")]: String(facts.wholesaleOrders),
    [at("q2")]: String(facts.buyers),
    [at("q3")]: String(facts.newBuyers),
    [at("q4")]: String(facts.applications),
    [at("q5")]: String(facts.approvals),
    [at("q6")]: String(facts.quietBuyers),
  };

  const lines = [
    `wholesale revenue: ${slot("f1")}`,
    `retail revenue: ${slot("f2")}`,
    `wholesale orders: ${slot("q1")}`,
    `buyers who ordered: ${slot("q2")}, of them new: ${slot("q3")}`,
    `registration applications: ${slot("q4")}, approved: ${slot("q5")}`,
    `owed on terms now: ${slot("f3")}, of that overdue: ${slot("f4")}`,
    `buyers who ordered last month but not this one: ${slot("q6")}`,
  ];

  if (facts.topBuyer) {
    slots[at("n1")] = facts.topBuyer.label;
    slots[at("f5")] = cash(facts.topBuyer.amount);
    lines.push(`biggest buyer: ${slot("n1")} at ${slot("f5")}`);
  }
  if (facts.topProduct) {
    slots[at("n2")] = facts.topProduct.label;
    slots[at("f6")] = cash(facts.topProduct.amount);
    lines.push(`biggest product: ${slot("n2")} at ${slot("f6")}`);
  }
  for (const [index, name] of facts.deadRules.entries()) {
    slots[at(`r${index + 1}`)] = name;
    lines.push(`active rule that priced nothing this month: ${slot(`r${index + 1}`)}`);
  }

  return { facts: lines, slots };
}

/** The namespace last month's figures live in. */
export const PREVIOUS_PREFIX = "p_";

/** What moved, month on month. Null when there is no month before. */
export function diffOf(
  current: MonthFacts,
  previous: MonthFacts | null,
): MonthDiff | null {
  if (!previous) return null;

  return {
    wholesaleRevenue: current.wholesaleRevenue.amount - previous.wholesaleRevenue.amount,
    wholesaleOrders: current.wholesaleOrders - previous.wholesaleOrders,
    buyers: current.buyers - previous.buyers,
  };
}
