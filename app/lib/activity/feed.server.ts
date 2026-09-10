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
  /**
   * Where the next page starts: `<ISO timestamp>|<row id>`.
   *
   * The id is not decoration. `AuditLog.createdAt` defaults to
   * `CURRENT_TIMESTAMP`, which in Postgres is *transaction* time — so every row
   * written inside one `db.$transaction` carries an identical value, and a
   * cursor of "older than this timestamp" skips its siblings. A bulk approval
   * or the setup wizard's own apply produces exactly such a cluster.
   */
  nextCursor: string | null;
}

interface Cursor {
  at: Date;
  id: string;
}

function readCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  const [when, ...rest] = raw.split("|");
  const at = new Date(when ?? "");
  if (Number.isNaN(at.getTime())) return null;
  return { at, id: rest.join("|") };
}

const writeCursor = (at: Date, id: string) => `${at.toISOString()}|${id}`;

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

/** Row ids carry their table (`audit:`/`order:`); the cursor wants the id. */
const rawId = (id: string) => id.slice(id.indexOf(":") + 1);

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

  const cursor = readCursor(options.before);

  const prefixes = AUDIT_PREFIX[filter];
  const auditWhere = {
    // Strictly older, or the same instant with a smaller id. Both halves are
    // needed: without the second, a page boundary inside a cluster of rows
    // sharing a timestamp loses every one of them.
    ...(cursor
      ? {
          AND: [
            {
              OR: [
                { createdAt: { lt: cursor.at } },
                { createdAt: cursor.at, id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : {}),
    ...(prefixes && prefixes.length > 0
      ? { OR: prefixes.map((prefix) => ({ action: { startsWith: prefix } })) }
      : {}),
  };

  const [audit, orders] = await Promise.all([
    prefixes === null
      ? []
      : db.auditLog.findMany({
          where: auditWhere,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
          // Wholesale only. Retail orders are mirrored too, and a retail row
          // here links to `/app/orders`, which filters them out — a row the
          // merchant cannot then find.
          where: {
            isWholesale: true,
            ...(cursor
              ? {
                  OR: [
                    { processedAt: { lt: cursor.at } },
                    { processedAt: cursor.at, id: { lt: cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ processedAt: "desc" }, { id: "desc" }],
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
      // No dangling separator for an order with neither a company nor an email
      // on it — "#1001 —" is a row that looks broken because it is.
      summary: [order.name, order.company ?? order.email].filter(Boolean).join(" — "),
      actorType: "BUYER" as AuditActorType,
      actorLabel: order.company ?? order.email,
      href: "/app/orders",
      // The storefront concierge placing an order for a buyer is the ✦ case.
      agent: order.source === "BUYER_AGENT",
    })),
  ]
    // Same order as each side was read in, so the cursor's tie-break means the
    // same thing in the merge as it does in the query.
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
    .slice(0, limit + 1);

  const full = rows.length > limit;
  const page = rows.slice(0, limit);

  const last = page[page.length - 1];
  return {
    rows: page,
    // The last row shown, timestamp and id. Both sides are then asked for what
    // sorts strictly after it, which is exactly the rows one ordered table
    // would have given.
    nextCursor: full && last ? writeCursor(last.at, rawId(last.id)) : null,
  };
}
