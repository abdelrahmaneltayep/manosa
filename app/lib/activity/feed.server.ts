import type { AuditActorType } from "@prisma/client";

import { db } from "~/db.server";
import { shopScope } from "~/lib/tenant/shop-context.server";

/**
 * What has been happening, from the two places it is recorded.
 *
 * The audit log holds everything a person or an agent did. Orders are mirrored
 * from Shopify and are not audited — nobody in this app "did" them — so the
 * feed is a union of the two, merged on time. Doing it any other way means
 * either an activity feed with no orders in it, or writing audit rows for
 * things this app did not do.
 */

export type ActivityKind = "audit" | "order";

export interface ActivityRow {
  id: string;
  at: Date;
  kind: ActivityKind;
  /** Dotted action name — `pricing_rule.created`, `order.placed`. */
  action: string;
  /** The sentence itself. Written when the entry was recorded. */
  summary: string;
  actorType: AuditActorType;
  actorLabel: string | null;
  /** Where this row goes when clicked. Null when there is nowhere useful. */
  href: string | null;
  /** An agent did it. The ✦ chip. */
  agent: boolean;
}

export interface ActivityPage {
  rows: ActivityRow[];
  /** ISO timestamp to pass back as `before` for the next page. */
  nextCursor: string | null;
}

/** How many rows Home shows before "View all". */
export const HOME_ROWS = 8;

/** Relative times become absolute past this. The checklist's seven days. */
export const RELATIVE_WINDOW_MS = 7 * 86_400_000;

export const ACTIVITY_FILTERS = ["all", "orders", "registrations", "pricing"] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export function isActivityFilter(value: string): value is ActivityFilter {
  return (ACTIVITY_FILTERS as readonly string[]).includes(value);
}

/** Which audit actions each filter keeps. `null` means "no audit rows at all". */
const AUDIT_PREFIX: Record<ActivityFilter, string[] | null> = {
  all: [],
  orders: ["quote.", "draft_order.", "terms."],
  registrations: ["form.", "customer."],
  pricing: ["pricing_rule.", "pricing.", "customer_group.", "customer_tag_rule."],
};

/** Whether a filter wants mirrored orders in the union. */
const WANTS_ORDERS: Record<ActivityFilter, boolean> = {
  all: true,
  orders: true,
  registrations: false,
  pricing: false,
};

const AGENT_ACTORS: AuditActorType[] = ["MERCHANT_AGENT", "BUYER_AGENT"];

/** The page an audit row points at, by the family of thing it happened to. */
function hrefForAudit(row: { action: string }): string | null {
  if (row.action.startsWith("pricing_rule.") || row.action.startsWith("pricing."))
    return "/app/pricing";
  if (row.action.startsWith("form.")) return "/app/customers/applications";
  if (row.action.startsWith("customer_group.")) return "/app/customers/groups";
  if (row.action.startsWith("customer_tag_rule.")) return "/app/customers/tagging";
  if (row.action.startsWith("customer_segment.")) return "/app/customers/segments";
  if (row.action.startsWith("customer.")) return "/app/customers";
  if (row.action.startsWith("quote.")) return "/app/orders/quotes";
  if (row.action.startsWith("terms.")) return "/app/orders/terms";
  if (row.action.startsWith("draft_order.")) return "/app/orders";
  if (row.action.startsWith("briefing.")) return "/app";
  if (row.action.startsWith("billing.")) return "/app/plans";
  return null;
}

/**
 * One page of activity, newest first.
 *
 * Paginated on time rather than on offset, because the feed is a union of two
 * tables and an offset into a merge is not a position in either. Each side is
 * asked for `limit` rows older than the cursor; merging and slicing then gives
 * exactly the rows that would have come from one table with the same ordering.
 */
export async function loadActivity(
  options: {
    limit?: number;
    before?: string | null;
    filter?: ActivityFilter;
  } = {},
): Promise<ActivityPage> {
  const limit = options.limit ?? HOME_ROWS;
  const filter = options.filter ?? "all";
  shopScope.require("activity feed");

  const before = options.before ? new Date(options.before) : null;
  const cursor = before && !Number.isNaN(before.getTime()) ? { lt: before } : undefined;

  const prefixes = AUDIT_PREFIX[filter];
  const auditWhere = {
    ...(cursor ? { createdAt: cursor } : {}),
    ...(prefixes && prefixes.length > 0
      ? { OR: prefixes.map((prefix) => ({ action: { startsWith: prefix } })) }
      : {}),
  };

  const [audit, orders] = await Promise.all([
    prefixes === null
      ? []
      : db.auditLog.findMany({
          where: auditWhere,
          orderBy: { createdAt: "desc" },
          // One extra, so we can tell "the page is full" from "that is
          // everything" without a second count.
          take: limit + 1,
          select: {
            id: true,
            createdAt: true,
            action: true,
            summary: true,
            actorType: true,
            actorLabel: true,
          },
        }),
    WANTS_ORDERS[filter]
      ? db.order.findMany({
          where: cursor ? { processedAt: cursor } : {},
          orderBy: { processedAt: "desc" },
          take: limit + 1,
          select: {
            id: true,
            name: true,
            processedAt: true,
            company: true,
            email: true,
            source: true,
          },
        })
      : [],
  ]);

  const rows: ActivityRow[] = [
    ...audit.map((row) => ({
      id: `audit:${row.id}`,
      at: row.createdAt,
      kind: "audit" as const,
      action: row.action,
      summary: row.summary,
      actorType: row.actorType,
      actorLabel: row.actorLabel,
      href: hrefForAudit(row),
      agent: AGENT_ACTORS.includes(row.actorType),
    })),
    ...orders.map((order) => ({
      id: `order:${order.id}`,
      at: order.processedAt,
      kind: "order" as const,
      action: "order.placed",
      // The one row the feed writes itself, because nothing wrote it at the
      // time: the order was placed in Shopify, not here.
      summary: `${order.name} — ${order.company ?? order.email ?? ""}`.trim(),
      actorType: "BUYER" as AuditActorType,
      actorLabel: order.company ?? order.email,
      href: "/app/orders",
      // The storefront concierge placing an order for a buyer is the ✦ case.
      agent: order.source === "BUYER_AGENT",
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, limit + 1);

  const full = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    rows: page,
    // The cursor is the last row shown, so the next page starts strictly older
    // than it. Two rows with the same timestamp across the two tables is the
    // one case this loses — accepted, and the reason ids are prefixed so the
    // page can at least not render a duplicate key.
    nextCursor: full && page.length > 0 ? page[page.length - 1]!.at.toISOString() : null,
  };
}
