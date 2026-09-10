import type { CustomerGroup, Prisma } from "@prisma/client";

import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import { normalizeTag } from "~/lib/customers/tagging";
import { tenant } from "~/lib/tenant/shop-context.server";

/**
 * Customer groups — the wholesale tiers.
 *
 * A group is a bundle: pricing, limits, terms, shipping and visibility all
 * hang off it. Most of those features land in later phases, so most of what a
 * group stores is not enforced yet; the group page says so rather than showing
 * a control that quietly does nothing.
 */

/** The two starter tiers the empty state offers in one click. */
export interface GroupTemplate {
  key: string;
  handle: string;
  /** Catalog key for the name, so the starter groups arrive translated. */
  i18nKey: string;
  tag: string;
  netTermsDays: number | null;
  sortOrder: number;
}

export const GROUP_TEMPLATES: readonly GroupTemplate[] = [
  {
    key: "silver",
    handle: "silver",
    i18nKey: "customers.groups.template.silver",
    tag: "silver",
    netTermsDays: null,
    sortOrder: 100,
  },
  {
    key: "gold",
    handle: "gold",
    i18nKey: "customers.groups.template.gold",
    tag: "gold",
    netTermsDays: 30,
    sortOrder: 200,
  },
] as const;

export class GroupHasMembersError extends Error {
  constructor(
    readonly groupId: string,
    readonly memberCount: number,
  ) {
    super(
      `Group ${groupId} still has ${memberCount} members. Choose where they go ` +
        `before deleting it — a buyer silently losing their tier is a wrong ` +
        `price at their next checkout.`,
    );
    this.name = "GroupHasMembersError";
  }
}

export class DuplicateGroupHandleError extends Error {
  constructor(readonly handle: string) {
    super(`A group with the handle "${handle}" already exists.`);
    this.name = "DuplicateGroupHandleError";
  }
}

/** URL- and rule-safe key derived from the name the merchant typed. */
export function toHandle(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "group"
  );
}

export interface GroupInput {
  name: string;
  handle?: string;
  tag?: string;
  color?: string | null;
  description?: string | null;
  netTermsDays?: number | null;
  /** Minor units. Null means no ceiling on what members may owe at once. */
  creditLimit?: number | null;
  freeShippingOver?: number | null;
  visibleCollectionIds?: string[];
  template?: string | null;
}

export interface GroupWithCount extends CustomerGroup {
  memberCount: number;
}

/** Every group with its live member count. */
export async function listGroups(): Promise<GroupWithCount[]> {
  const groups = await db.customerGroup.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  // Counted rather than cached: a stale member count is what makes a merchant
  // delete a group believing it is empty.
  const counts = await db.customer.groupBy({
    by: ["groupId"],
    where: { groupId: { in: groups.map((group) => group.id) } },
    _count: { _all: true },
  });

  const byId = new Map(counts.map((row) => [row.groupId, row._count._all]));
  return groups.map((group) => ({ ...group, memberCount: byId.get(group.id) ?? 0 }));
}

export async function getGroup(id: string): Promise<GroupWithCount | null> {
  const group = await db.customerGroup.findUnique({ where: { id } });
  if (!group) return null;

  const memberCount = await db.customer.count({ where: { groupId: group.id } });
  return { ...group, memberCount };
}

function groupData(
  input: GroupInput,
): Omit<Prisma.CustomerGroupUncheckedCreateInput, "shop"> {
  return {
    name: input.name.trim(),
    handle: input.handle ? toHandle(input.handle) : toHandle(input.name),
    tag: normalizeTag(input.tag ?? input.name),
    color: input.color ?? null,
    description: input.description ?? null,
    netTermsDays: input.netTermsDays ?? null,
    creditLimit: input.creditLimit ?? null,
    freeShippingOver: input.freeShippingOver ?? null,
    visibleCollectionIds: input.visibleCollectionIds ?? [],
    template: input.template ?? null,
  };
}

export async function createGroup(
  input: GroupInput,
  actor: AuditActor,
  sortOrder?: number,
): Promise<CustomerGroup> {
  const data = groupData(input);

  const clash = await db.customerGroup.findFirst({ where: { handle: data.handle } });
  if (clash) throw new DuplicateGroupHandleError(data.handle);

  const created = await db.customerGroup.create({
    data: {
      ...tenant(),
      ...data,
      ...(sortOrder === undefined ? {} : { sortOrder }),
      createdBy: actor.id ?? null,
    },
  });

  await recordAudit({
    actor,
    action: "customer_group.created",
    summary: `Created the customer group “${created.name}”.`,
    subject: { type: "CustomerGroup", id: created.id },
    metadata: { handle: created.handle, tag: created.tag },
  });

  return created;
}

export async function updateGroup(
  id: string,
  input: GroupInput,
  actor: AuditActor,
): Promise<CustomerGroup> {
  const current = await db.customerGroup.findUnique({ where: { id } });
  if (!current) throw new Response("Group not found", { status: 404 });

  const data = groupData(input);
  const clash = await db.customerGroup.findFirst({
    where: { handle: data.handle, id: { not: id } },
  });
  if (clash) throw new DuplicateGroupHandleError(data.handle);

  const updated = await db.customerGroup.update({ where: { id }, data });

  await recordAudit({
    actor,
    action: "customer_group.updated",
    summary: `Updated the customer group “${updated.name}”.`,
    subject: { type: "CustomerGroup", id },
    metadata: { handle: updated.handle, tag: updated.tag },
  });

  return updated;
}

/** Where a deleted group's members go. There is no implicit answer. */
export type GroupDestination =
  | { kind: "group"; id: string }
  /** Explicitly no group: they fall back to tag-only pricing. */
  | { kind: "none" };

/**
 * Delete a group, having decided where its members go.
 *
 * The destination is required rather than defaulted because a buyer who
 * silently loses their tier gets a different price at their next checkout, and
 * nobody would connect that to a group someone tidied away last week.
 */
export async function deleteGroup(
  id: string,
  destination: GroupDestination | null,
  actor: AuditActor,
) {
  const group = await db.customerGroup.findUnique({ where: { id } });
  if (!group) throw new Response("Group not found", { status: 404 });

  const memberCount = await db.customer.count({ where: { groupId: id } });

  if (memberCount > 0 && !destination) {
    throw new GroupHasMembersError(id, memberCount);
  }

  if (destination?.kind === "group") {
    const target = await db.customerGroup.findUnique({ where: { id: destination.id } });
    if (!target || target.id === id) {
      throw new Response("Destination group not found", { status: 404 });
    }
  }

  await db.customer.updateMany({
    where: { groupId: id },
    data: { groupId: destination?.kind === "group" ? destination.id : null },
  });

  await db.customerGroup.delete({ where: { id } });

  await recordAudit({
    actor,
    action: "customer_group.deleted",
    summary:
      memberCount === 0
        ? `Deleted the empty customer group “${group.name}”.`
        : destination?.kind === "group"
          ? `Deleted “${group.name}” and moved its ${memberCount} members to another group.`
          : `Deleted “${group.name}”. Its ${memberCount} members now have no group and are priced by their tags alone.`,
    subject: { type: "CustomerGroup", id },
    metadata: {
      memberCount,
      destination: destination?.kind === "group" ? destination.id : null,
    },
  });

  return { memberCount };
}

/**
 * Create the starter tiers.
 *
 * Only the ones that are missing: a merchant who took Silver, renamed it, and
 * comes back should not end up with two.
 */
export async function createStarterGroups(
  actor: AuditActor,
  name: (template: GroupTemplate) => string,
): Promise<CustomerGroup[]> {
  const existing = await db.customerGroup.findMany({ select: { handle: true } });
  const taken = new Set(existing.map((group) => group.handle));
  const created: CustomerGroup[] = [];

  for (const template of GROUP_TEMPLATES) {
    if (taken.has(template.handle)) continue;
    created.push(
      await createGroup(
        {
          name: name(template),
          handle: template.handle,
          tag: template.tag,
          netTermsDays: template.netTermsDays,
          template: template.key,
        },
        actor,
        template.sortOrder,
      ),
    );
  }

  return created;
}
