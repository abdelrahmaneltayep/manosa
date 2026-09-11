import { money, type Money } from "@mannon/pricing-engine";

import { db } from "~/db.server";
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
  topGroup: { label: string; amount: Money } | null;
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

/** The first instant of a `YYYY-MM` in a given zone, as a UTC `Date`. */
export function monthStart(month: string, timeZone: string | null): Date {
  const [year, index] = month.split("-").map(Number);
  // Midday UTC on the first, then walked back to the first instant whose local
  // day is still the first — the only way to get a zone's midnight without a
  // date library, and correct across a DST transition at midnight.
  const noon = Date.UTC(year!, index! - 1, 1, 12);
  let cursor = noon;

  while (localDay(new Date(cursor - 60 * 60 * 1000), timeZone).endsWith("-01")) {
    cursor -= 60 * 60 * 1000;
    if (noon - cursor > 36 * 60 * 60 * 1000) break;
  }
  return new Date(cursor);
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
        select: { name: true },
      }),
    ]);

  const net = (order: { totalPrice: number; refundedAmount: number }) =>
    Math.max(0, order.totalPrice - order.refundedAmount);

  const retail = await db.order.aggregate({
    where: { ...inCurrency, isWholesale: false, processedAt: window },
    _sum: { totalPrice: true, refundedAmount: true },
  });

  const orderIds = orders.map((order) => order.id);
  const [lines, retailTotal] = await Promise.all([
    orderIds.length === 0
      ? Promise.resolve([])
      : db.orderLine.findMany({
          where: { orderId: { in: orderIds } },
          select: { title: true, productId: true, currentTotal: true, discounts: true },
        }),
    Promise.resolve(
      Math.max(0, (retail._sum.totalPrice ?? 0) - (retail._sum.refundedAmount ?? 0)),
    ),
  ]);

  const buyerIds = new Set(
    orders.map((order) => order.customerId).filter((id): id is string => Boolean(id)),
  );
  const lastMonthIds = new Set(
    lastMonthBuyers
      .map((order) => order.customerId)
      .filter((id): id is string => Boolean(id)),
  );

  const owed = outstanding.reduce(
    (sum, order) =>
      sum + Math.max(0, order.totalPrice - order.refundedAmount - order.amountPaid),
    0,
  );
  const overdue = outstanding
    .filter((order) => order.netTermsDueAt !== null && order.netTermsDueAt < now)
    .reduce(
      (sum, order) =>
        sum + Math.max(0, order.totalPrice - order.refundedAmount - order.amountPaid),
      0,
    );

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
    topGroup: null,
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
    deadRules: rules
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
): { facts: string[]; slots: Record<string, string> } {
  const cash = (value: Money) => formatCurrency(value, locale);
  const slots: Record<string, string> = {
    f1: cash(facts.wholesaleRevenue),
    f2: cash(facts.retailRevenue),
    f3: cash(facts.owedNow),
    f4: cash(facts.overdueNow),
    q1: String(facts.wholesaleOrders),
    q2: String(facts.buyers),
    q3: String(facts.newBuyers),
    q4: String(facts.applications),
    q5: String(facts.approvals),
    q6: String(facts.quietBuyers),
  };

  const lines = [
    "wholesale revenue: {{f1}}",
    "retail revenue: {{f2}}",
    "wholesale orders: {{q1}}",
    "buyers who ordered: {{q2}}, of them new: {{q3}}",
    "registration applications: {{q4}}, approved: {{q5}}",
    "owed on terms now: {{f3}}, of that overdue: {{f4}}",
    "buyers who ordered last month but not this one: {{q6}}",
  ];

  if (facts.topBuyer) {
    slots.n1 = facts.topBuyer.label;
    slots.f5 = cash(facts.topBuyer.amount);
    lines.push("biggest buyer: {{n1}} at {{f5}}");
  }
  if (facts.topProduct) {
    slots.n2 = facts.topProduct.label;
    slots.f6 = cash(facts.topProduct.amount);
    lines.push("biggest product: {{n2}} at {{f6}}");
  }
  for (const [index, name] of facts.deadRules.entries()) {
    slots[`r${index + 1}`] = name;
    lines.push(`active rule that priced nothing this month: {{r${index + 1}}}`);
  }

  return { facts: lines, slots };
}

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
