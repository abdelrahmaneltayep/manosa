import { formatCurrency } from "~/lib/money";
import { money, type Money } from "@mannon/pricing-engine";

import { db } from "~/db.server";
import type { Translate } from "~/i18n/translate";
import type { AskAnswer, BuilderTarget } from "~/lib/ai/prompts/ask.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * Answering a routed question, in our own code.
 *
 * Claude decided *which* question was asked. Everything from here is a query
 * this app already knows how to run, against this shop's own rows, inside its
 * own tenant scope.
 *
 * There is no intent that writes. Anything that would change something routes
 * to `open_builder`, which produces a link and nothing else — so the bar cannot
 * be talked into deleting a merchant's pricing, because there is no code path
 * from it to a delete.
 */

const DAY = 86_400_000;

/** Rows shown inline. More than this and the answer is a link to the list. */
export const ANSWER_ROWS = 5;

/**
 * The most rows any one answer reads.
 *
 * The bar shows five and links to the page for the rest, so loading the whole
 * table to slice five off it is a scan with no reader. Counts come from
 * `count()`, which the database answers without materialising anything.
 */
const SCAN_LIMIT = 200;

export interface AskResultRow {
  label: string;
  detail: string | null;
}

export interface AskResult {
  /** A translation key for the headline, with `count` / `amount` filled in. */
  headline: { key: string; params: Record<string, string | number> };
  rows: AskResultRow[];
  /** Where to go to see all of it. Always present. */
  href: string;
  /** True when this was a change the merchant must make themselves. */
  isBuilder: boolean;
}

const BUILDER_HREF: Record<BuilderTarget, string> = {
  pricing_rule: "/app/pricing/describe",
  segment: "/app/customers/segments",
  form: "/app/forms",
  quote: "/app/orders/quotes",
  csv_import: "/app/pricing/csv",
  customer_group: "/app/customers/groups",
};

const named = (row: { company: string | null; email: string | null; id: string }) =>
  row.company || row.email || row.id;

async function shopCurrency(): Promise<string> {
  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("ask") },
  });
  return shop?.currencyCode ?? "USD";
}

const fmt = (value: Money, locale: string) => formatCurrency(value, locale);

/**
 * Run one routed question.
 *
 * Every branch is a read. That is the whole security model of this feature and
 * it is worth more than any amount of prompt hardening.
 */
export async function answerAsk(
  answer: AskAnswer,
  options: { locale: string; t: Translate; now?: Date },
): Promise<AskResult> {
  const now = options.now ?? new Date();
  const { locale, t } = options;

  // "in the next 1 days" is the tell that a number was dropped into a sentence
  // without being counted. The window is its own pluralised phrase, so both
  // halves of the headline agree with their own number — English has two
  // categories here and Arabic six.
  const dayWindow = (days: number) => t("ask.answer.window", { count: days });

  switch (answer.intent) {
    case "open_builder": {
      const target = answer.target ?? "pricing_rule";
      return {
        headline: { key: `ask.answer.open_builder.${target}`, params: {} },
        rows: [],
        href: BUILDER_HREF[target],
        isBuilder: true,
      };
    }

    case "count_buyers": {
      const count = await db.customer.count({
        where: { status: "APPROVED", deletedInShopifyAt: null },
      });
      return {
        headline: { key: "ask.answer.count_buyers", params: { count } },
        rows: [],
        href: "/app/customers",
        isBuilder: false,
      };
    }

    case "count_applications": {
      const count = await db.formSubmission.count({ where: { status: "PENDING" } });
      return {
        headline: { key: "ask.answer.count_applications", params: { count } },
        rows: [],
        href: "/app/customers/applications",
        isBuilder: false,
      };
    }

    case "list_overdue": {
      const currencyCode = await shopCurrency();
      const count = await db.order.count({
        where: { paidAt: null, cancelledAt: null, netTermsDueAt: { lt: now } },
      });
      const orders = await db.order.findMany({
        where: { paidAt: null, cancelledAt: null, netTermsDueAt: { lt: now } },
        orderBy: { netTermsDueAt: "asc" },
        take: SCAN_LIMIT,
        select: {
          name: true,
          company: true,
          email: true,
          totalPrice: true,
          amountPaid: true,
          currencyCode: true,
          netTermsDueAt: true,
        },
      });

      const owed = orders
        .filter((order) => order.currencyCode === currencyCode)
        .reduce(
          (sum, order) => sum + Math.max(0, order.totalPrice - order.amountPaid),
          0,
        );

      return {
        headline: {
          key: "ask.answer.list_overdue",
          params: {
            // The true count, from the database. The sum is of what was read,
            // so it only ever understates — never a figure bigger than its rows.
            count,
            amount: fmt(money(owed, currencyCode), locale),
          },
        },
        rows: orders.slice(0, ANSWER_ROWS).map((order) => ({
          label: `${order.name} · ${order.company ?? order.email ?? ""}`.trim(),
          detail: fmt(
            money(Math.max(0, order.totalPrice - order.amountPaid), order.currencyCode),
            locale,
          ),
        })),
        href: "/app/orders/terms",
        isBuilder: false,
      };
    }

    case "list_expiring_quotes": {
      const days = answer.days ?? 7;
      const expiring = {
        status: "SENT" as const,
        expiresAt: { gte: now, lte: new Date(now.getTime() + days * DAY) },
      };
      const [count, quotes] = await Promise.all([
        db.quote.count({ where: expiring }),
        db.quote.findMany({
          where: expiring,
          orderBy: { expiresAt: "asc" },
          take: ANSWER_ROWS,
          select: { number: true, company: true, email: true, expiresAt: true },
        }),
      ]);

      return {
        headline: {
          key: "ask.answer.list_expiring_quotes",
          params: { count, window: dayWindow(days) },
        },
        rows: quotes.slice(0, ANSWER_ROWS).map((quote) => ({
          label: `${quote.number} · ${quote.company ?? quote.email ?? ""}`.trim(),
          detail: quote.expiresAt ? quote.expiresAt.toISOString().slice(0, 10) : null,
        })),
        href: "/app/orders/quotes",
        isBuilder: false,
      };
    }

    case "wholesale_sales": {
      const days = answer.days ?? 7;
      const currencyCode = await shopCurrency();
      const totals = await db.order.aggregate({
        where: {
          isWholesale: true,
          cancelledAt: null,
          currencyCode,
          createdAt: { gte: new Date(now.getTime() - days * DAY) },
        },
        _count: true,
        _sum: { totalPrice: true },
      });

      return {
        headline: {
          key: "ask.answer.wholesale_sales",
          params: {
            count: totals._count,
            window: dayWindow(days),
            amount: fmt(money(totals._sum.totalPrice ?? 0, currencyCode), locale),
          },
        },
        rows: [],
        href: "/app/orders",
        isBuilder: false,
      };
    }

    case "list_quiet_buyers": {
      const days = answer.days ?? 60;
      const quiet = {
        status: "APPROVED" as const,
        deletedInShopifyAt: null,
        orderCount: { gte: 1 },
        lastOrderAt: { lt: new Date(now.getTime() - days * DAY) },
      };
      const [count, buyers] = await Promise.all([
        db.customer.count({ where: quiet }),
        db.customer.findMany({
          where: quiet,
          orderBy: { lifetimeSpend: "desc" },
          take: ANSWER_ROWS,
          select: { id: true, company: true, email: true, lastOrderAt: true },
        }),
      ]);

      return {
        headline: {
          key: "ask.answer.list_quiet_buyers",
          params: { count, window: dayWindow(days) },
        },
        rows: buyers.slice(0, ANSWER_ROWS).map((buyer) => ({
          label: named(buyer),
          detail: buyer.lastOrderAt ? buyer.lastOrderAt.toISOString().slice(0, 10) : null,
        })),
        href: "/app/customers",
        isBuilder: false,
      };
    }

    case "find_rule": {
      const search = answer.search ?? "";
      const where = {
        archivedAt: null,
        ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}),
      };
      const [count, rules] = await Promise.all([
        db.pricingRule.count({ where }),
        db.pricingRule.findMany({
          where,
          orderBy: { priority: "asc" },
          take: ANSWER_ROWS,
          select: { id: true, name: true, status: true, kind: true },
        }),
      ]);

      return {
        headline: {
          key: "ask.answer.find_rule",
          params: { count, search },
        },
        rows: rules.slice(0, ANSWER_ROWS).map((rule) => ({
          label: rule.name,
          detail: rule.status,
        })),
        href: search
          ? `/app/pricing?search=${encodeURIComponent(search)}`
          : "/app/pricing",
        isBuilder: false,
      };
    }

    case "explain_price":
    default: {
      // The one answer that is a price, so it is the one answer that must come
      // from the engine — and the engine needs a buyer and a variant. The bar
      // hands the merchant to the page that has both rather than guessing at
      // which of their buyers they meant.
      return {
        headline: {
          key: "ask.answer.explain_price",
          params: { sku: answer.sku ?? "", quantity: answer.quantity ?? 1 },
        },
        rows: [],
        href: "/app/pricing/settings",
        isBuilder: false,
      };
    }
  }
}
