import type { AuditActorType } from "@prisma/client";

import { db } from "~/db.server";
import { activityKindLabel } from "~/lib/agent/home-view.server";
import type { Translate } from "~/i18n/translate";
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

/**
 * Who did it, as checklist §8 asks the audit log to be filterable.
 *
 * The category filter above answers "what kind of thing happened". This
 * answers the question a merchant actually opens the log with — *did a person
 * do this, or did Claude?* — and the schema has carried
 * `@@index([shop, actorType, createdAt])` for it since 0.2.
 */
export const ACTOR_FILTERS = ["anyone", "agent", "staff", "system"] as const;
export type ActorFilter = (typeof ACTOR_FILTERS)[number];

export const isActorFilter = (value: string): value is ActorFilter =>
  (ACTOR_FILTERS as readonly string[]).includes(value);

const ACTOR_TYPES: Record<ActorFilter, AuditActorType[] | null> = {
  anyone: null,
  agent: AGENT_ACTORS,
  staff: ["STAFF"],
  system: ["SYSTEM"],
};

/** An order row has no actor, so an actor filter excludes them all but "anyone". */
const actorWantsOrders = (actor: ActorFilter) => actor === "anyone";

/** `YYYY-MM-DD` from a date input, or null. Never a partial date. */
export function readDay(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Row ids carry their table (`audit:`/`order:`); the cursor wants the id. */
const rawId = (id: string) => id.slice(id.indexOf(":") + 1);

/** The page an audit row points at, by the family of thing it happened to. */
function hrefForAudit(row: { action: string; metadata?: unknown }): string | null {
  // The one entry whose link is the answer to a legal request: it carries the
  // buyer's identifiers so the merchant can download what this app holds.
  // Without it the entry said "open their buyer page", which loads none of the
  // seven areas and does not exist at all for a form-only applicant.
  if (row.action === "privacy.data_requested") {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const query = new URLSearchParams();
    if (typeof meta.customerId === "string") query.set("customer", meta.customerId);
    if (typeof meta.submissionId === "string") {
      query.set("submission", meta.submissionId);
    }
    return query.size > 0 ? `/app/privacy/export?${query.toString()}` : null;
  }

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
    /** Who: a person, an agent, the system, or anyone. */
    actor?: ActorFilter;
    /** One exact action, e.g. "pricing_rule.created". */
    action?: string | null;
    /** Inclusive, in UTC days. `to` covers the whole of that day. */
    from?: Date | null;
    to?: Date | null;
  } = {},
): Promise<ActivityPage> {
  const limit = options.limit ?? HOME_ROWS;
  const filter = options.filter ?? "all";
  const actor = options.actor ?? "anyone";
  shopScope.require("activity feed");

  const actorTypes = ACTOR_TYPES[actor];
  // `to` is a day, and a merchant asking for "up to the 3rd" means the whole
  // of the 3rd — an exclusive bound at midnight would silently drop it.
  const dayAfter = options.to
    ? new Date(options.to.getTime() + 24 * 60 * 60 * 1000)
    : null;
  const window = {
    ...(options.from ? { gte: options.from } : {}),
    ...(dayAfter ? { lt: dayAfter } : {}),
  };
  const windowed = options.from || dayAfter;

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
    ...(actorTypes ? { actorType: { in: actorTypes } } : {}),
    ...(options.action ? { action: options.action } : {}),
    ...(windowed ? { createdAt: window } : {}),
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
    WANTS_ORDERS[filter] && actorWantsOrders(actor) && !options.action
      ? db.order.findMany({
          // Wholesale only. Retail orders are mirrored too, and a retail row
          // here links to `/app/orders`, which filters them out — a row the
          // merchant cannot then find.
          where: {
            isWholesale: true,
            ...(windowed ? { processedAt: window } : {}),
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

/**
 * Every action this shop has actually recorded, newest use first.
 *
 * Built from the data rather than from a list of every action the codebase can
 * write: a picker offering forty actions a shop has never performed is a
 * picker nobody uses, and a hand-kept list is the registration step this repo
 * has now forgotten three times.
 */
export async function recordedActions(): Promise<string[]> {
  shopScope.require("recordedActions");

  const rows = await db.auditLog.findMany({
    distinct: ["action"],
    orderBy: { action: "asc" },
    select: { action: true },
    take: 200,
  });
  return rows.map((row) => row.action);
}

/**
 * An action, as a sentence rather than a family chip.
 *
 * `activityKindLabel` answers "what kind of thing is this" — `pricing_rule.*`
 * → "Pricing". That is right for a chip beside a row and wrong for a picker
 * of actions: it collapsed the 65 actions this app writes into 15 labels,
 * eleven of them reading "Pricing" and ten reading "Activity", so a merchant
 * could not tell `pricing_rule.created` from `pricing_rule.archived`.
 *
 * Built from the action string itself: the family, then the verb with its
 * underscores opened out. `pricing_rule.archived` → "Pricing · rule archived".
 * Derived rather than a catalogue of 65 entries, because a hand-kept list is
 * the registration step this repo has now forgotten three times — and an
 * action nobody translated would render as a raw key rather than as itself.
 */
export function actionLabel(action: string, t: Translate): string {
  const [family = action, verb = ""] = action.split(".");
  const words = `${family}_${verb}`
    .replace(/_/g, " ")
    .trim()
    .replace(/^./, (first) => first.toUpperCase());

  const chip = activityKindLabel(action, t);
  // The chip when it says something the words do not, and the words always:
  // together they read as "Pricing · Pricing rule created" at worst.
  return chip && !words.toLowerCase().startsWith(chip.toLowerCase())
    ? `${chip} · ${words}`
    : words;
}
