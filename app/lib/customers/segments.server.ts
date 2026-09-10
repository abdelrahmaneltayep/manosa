import type { BuyerStatus, CustomerSegment, Prisma } from "@prisma/client";

import { db } from "~/db.server";
import {
  recordAudit,
  type AiProvenance,
  type AuditActor,
} from "~/lib/audit/record.server";
import type { NumericOperator } from "~/lib/customers/segments";
import {
  readConditions,
  tightestCondition,
  validateSegment,
  type SegmentCondition,
  type SegmentIssue,
} from "~/lib/customers/segments";
import { tenant } from "~/lib/tenant/shop-context.server";

/**
 * Running a segment, and saving one.
 *
 * The translation from condition to query lives here and nowhere else: the
 * count a merchant sees before saving and the members a pricing rule gets
 * afterwards come from the same function, so a segment cannot mean one thing on
 * screen and another in a price.
 */

export class SegmentValidationError extends Error {
  constructor(readonly issues: SegmentIssue[]) {
    super(`Segment is not valid: ${issues.map((issue) => issue.code).join(", ")}`);
    this.name = "SegmentValidationError";
  }
}

const DAY_MS = 86_400_000;

/** `{ gt: 5000 }` — the operator is one of four, checked on the way in. */
const numeric = (op: NumericOperator, value: number): Prisma.IntFilter => ({
  [op]: value,
});

/** One condition as a Prisma clause. */
export function whereFor(
  condition: SegmentCondition,
  now: Date,
): Prisma.CustomerWhereInput {
  switch (condition.field) {
    case "lifetime_spend":
      // Compared in minor units of the customer's own currency, and only
      // against customers in that currency: the engine will not convert, and
      // neither will this — $5,000 and ¥5,000 are not the same threshold.
      return {
        currencyCode: condition.amount.currencyCode,
        lifetimeSpend: numeric(condition.op, condition.amount.amount),
      };

    case "order_count":
      return { orderCount: numeric(condition.op, condition.value) };

    case "last_order_days": {
      // "No order in 45 days" is a date before that cutoff. A customer who has
      // never ordered has no last-order date and is not "45 days quiet" — they
      // are a different question, which `never_ordered` asks.
      const cutoff = new Date(now.getTime() - condition.value * DAY_MS);
      const before = condition.op === "gt" || condition.op === "gte";
      return {
        lastOrderAt: before ? { not: null, lte: cutoff } : { not: null, gte: cutoff },
      };
    }

    case "never_ordered":
      return { lastOrderAt: null };

    case "tag":
      return condition.op === "has"
        ? { tags: { has: condition.value } }
        : { NOT: { tags: { has: condition.value } } };

    case "group":
      return condition.op === "is"
        ? { groupId: condition.groupId }
        : { NOT: { groupId: condition.groupId } };

    case "country":
      return condition.op === "is"
        ? { countryCode: condition.value }
        : { NOT: { countryCode: condition.value } };

    case "tax_exempt":
      return { taxExempt: condition.value };

    case "status":
      return { status: condition.value as BuyerStatus };
  }
}

/** Every condition, ANDed — plus the two rows a segment never means. */
export function whereForSegment(
  conditions: readonly SegmentCondition[],
  now: Date,
): Prisma.CustomerWhereInput {
  return {
    // A customer Shopify has deleted is not a member of anything. Leaving them
    // in would price for somebody who no longer exists.
    deletedInShopifyAt: null,
    AND: conditions.map((condition) => whereFor(condition, now)),
  };
}

export async function countSegment(
  conditions: readonly SegmentCondition[],
  now: Date,
): Promise<number> {
  return db.customer.count({ where: whereForSegment(conditions, now) });
}

export interface SegmentPreview {
  count: number;
  /** A few real members, so a number is inspectable rather than a claim. */
  samples: { id: string; name: string; email: string | null }[];
  /** When nobody matches: the chip to loosen first, by index. Null if none helps. */
  loosen: number | null;
}

/** How many members are listed as proof of the count. */
export const SEGMENT_SAMPLE = 5;

export async function previewSegment(
  conditions: readonly SegmentCondition[],
  now: Date,
): Promise<SegmentPreview> {
  const where = whereForSegment(conditions, now);
  const [count, samples] = await Promise.all([
    db.customer.count({ where }),
    db.customer.findMany({
      where,
      take: SEGMENT_SAMPLE,
      orderBy: { lifetimeSpend: "desc" },
      select: { id: true, company: true, firstName: true, lastName: true, email: true },
    }),
  ]);

  return {
    count,
    samples: samples.map((row) => ({
      id: row.id,
      name:
        row.company ||
        [row.firstName, row.lastName].filter(Boolean).join(" ") ||
        row.email ||
        row.id,
      email: row.email,
    })),
    loosen: count > 0 ? null : await loosenWhich(conditions, now),
  };
}

/**
 * Which single condition, dropped, would match the most people.
 *
 * One count per condition. Bounded by `MAX_CONDITIONS`, and only run when the
 * segment already matches nobody — which is when a merchant is stuck and the
 * answer is worth the queries.
 */
async function loosenWhich(
  conditions: readonly SegmentCondition[],
  now: Date,
): Promise<number | null> {
  if (conditions.length < 2) return conditions.length === 1 ? 0 : null;

  const counts = await Promise.all(
    conditions.map(async (_condition, index) => ({
      index,
      countWithout: await db.customer.count({
        where: whereForSegment(
          conditions.filter((_one, other) => other !== index),
          now,
        ),
      }),
    })),
  );

  return tightestCondition(counts);
}

/* -------------------------------------------------------------------------- */

export async function listSegments(): Promise<CustomerSegment[]> {
  return db.customerSegment.findMany({ orderBy: { updatedAt: "desc" } });
}

export async function getSegment(id: string): Promise<CustomerSegment | null> {
  return db.customerSegment.findUnique({ where: { id } });
}

export interface SaveSegmentInput {
  name: string;
  conditions: readonly SegmentCondition[];
  sentence?: string | null;
  ai?: AiProvenance | null;
}

/**
 * Save a segment.
 *
 * The audit entry is `aiAssisted` only when Claude read the sentence that made
 * it — and then it carries the merchant who pressed save, which `recordAudit`
 * requires. Saving a segment changes no price by itself; applying one to a rule
 * does, and that goes through `createRule` like everything else.
 */
export async function saveSegment(
  input: SaveSegmentInput,
  actor: AuditActor,
  now = new Date(),
): Promise<CustomerSegment> {
  const conditions = [...input.conditions];
  const issues = validateSegment(input.name, conditions);
  if (issues.length > 0) throw new SegmentValidationError(issues);

  const count = await countSegment(conditions, now);

  const segment = await db.$transaction(async (tx) => {
    const row = await tx.customerSegment.create({
      data: {
        ...tenant(),
        name: input.name.trim(),
        conditions: conditions as unknown as Prisma.InputJsonValue,
        sentence: input.sentence ?? null,
        aiModel: input.ai?.model ?? null,
        aiPromptVersion: input.ai?.promptVersion ?? null,
        lastCount: count,
        lastCountAt: now,
        createdBy: actor.id ?? null,
      },
    });

    await recordAudit(
      {
        actor,
        action: "customer_segment.created",
        summary: input.ai
          ? `Approved Claude's reading of “${input.sentence ?? ""}” and saved the segment “${row.name}”.`
          : `Saved the customer segment “${row.name}”.`,
        subject: { type: "CustomerSegment", id: row.id },
        metadata: { conditions: conditions.length, members: count },
        ai: input.ai ?? null,
        aiAssisted: Boolean(input.ai),
        approval: input.ai && actor.id ? { byId: actor.id } : null,
      },
      tx,
    );

    return row;
  });

  return segment;
}

export async function deleteSegment(id: string, actor: AuditActor): Promise<void> {
  const segment = await db.customerSegment.findUnique({ where: { id } });
  if (!segment) throw new Response("Segment not found", { status: 404 });

  await db.$transaction(async (tx) => {
    await tx.customerSegment.delete({ where: { id } });
    await recordAudit(
      {
        actor,
        action: "customer_segment.deleted",
        summary: `Deleted the customer segment “${segment.name}”.`,
        subject: { type: "CustomerSegment", id },
      },
      tx,
    );
  });
}

/** The stored conditions, read back through the same reader as everything else. */
export function conditionsOf(segment: CustomerSegment): SegmentCondition[] {
  return readConditions(segment.conditions);
}

/**
 * The Shopify customer ids in a segment, for a pricing rule's audience.
 *
 * A snapshot, and the rule says so. Making it live would mean publishing each
 * buyer's segment membership to checkout the way tags and groups are published,
 * which is a phase of its own — see DECISIONS.md, 2026-09-10.
 */
export async function segmentMemberIds(
  conditions: readonly SegmentCondition[],
  now: Date,
  limit = 1_000,
): Promise<string[]> {
  const rows = await db.customer.findMany({
    where: whereForSegment(conditions, now),
    select: { customerId: true },
    orderBy: { lifetimeSpend: "desc" },
    take: limit,
  });
  return rows.map((row) => row.customerId);
}
