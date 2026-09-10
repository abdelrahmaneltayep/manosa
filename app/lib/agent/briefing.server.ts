import type { MerchantBriefing } from "@prisma/client";

import { db } from "~/db.server";
import type { AiDeps } from "~/lib/ai/run.server";
import { draftBriefing, type BriefingItem } from "~/lib/ai/prompts/briefing.server";
import { briefingFacts, isFactKind, type AgentFact } from "~/lib/agent/facts.server";
import { recordAudit } from "~/lib/audit/record.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/**
 * Generating a briefing, and reading yesterday's when today's cannot be had.
 *
 * The one rule: **items carry kinds, the screen carries numbers.** A stored
 * briefing is a short list of what mattered this morning; the figures beside
 * each line are recomputed from the database every time the page renders. So a
 * stale briefing shows a stale timestamp and current numbers, which is the only
 * honest combination — the alternative is a card quoting a figure that stopped
 * being true overnight.
 */

/** Older than this and the card says so. The checklist's stale badge. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function readItems(value: unknown): BriefingItem[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as { kind?: unknown; reason?: unknown };
    if (typeof raw.kind !== "string" || !isFactKind(raw.kind)) return [];
    return [{ kind: raw.kind, reason: typeof raw.reason === "string" ? raw.reason : "" }];
  });
}

export async function latestBriefing(): Promise<MerchantBriefing | null> {
  return db.merchantBriefing.findFirst({ orderBy: { generatedAt: "desc" } });
}

/**
 * The kinds this shop has silenced.
 *
 * Deduplicated on the way out. The column is appended to with `push`, which is
 * atomic and so never loses a concurrent mute — but two tabs muting the same
 * kind at once both pass the `includes` check below and both append. Reading
 * unique is cheaper than locking the row for a list of at most twelve strings.
 */
export async function mutedKinds(): Promise<string[]> {
  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("briefing mutes") },
  });
  return [...new Set(shop?.briefingMuted ?? [])];
}

/** Stop showing this kind. One click from the item itself. */
export async function muteKind(kind: string, actorId: string | null): Promise<void> {
  if (!isFactKind(kind)) throw new Response("Unknown briefing item", { status: 400 });

  const shop = shopScope.require("mute briefing item");
  const current = await db.shop.findUnique({ where: { shop } });
  if (!current) return;
  if (current.briefingMuted.includes(kind)) return;

  await db.$transaction(async (tx) => {
    await tx.shop.update({
      where: { shop },
      data: { briefingMuted: { push: kind } },
    });
    await recordAudit(
      {
        actor: { type: "STAFF", id: actorId },
        action: "briefing.muted",
        summary: `Stopped the Merchant Agent raising “${kind}”.`,
        metadata: { kind },
      },
      tx,
    );
  });
}

/** Start showing this kind again. Audited, like the mute it undoes. */
export async function unmuteKind(kind: string, actorId: string | null): Promise<void> {
  if (!isFactKind(kind)) throw new Response("Unknown briefing item", { status: 400 });

  const shop = shopScope.require("unmute briefing item");
  const current = await db.shop.findUnique({ where: { shop } });
  if (!current) return;
  if (!current.briefingMuted.includes(kind)) return;

  await db.$transaction(async (tx) => {
    await tx.shop.update({
      where: { shop },
      data: { briefingMuted: current.briefingMuted.filter((one) => one !== kind) },
    });
    await recordAudit(
      {
        actor: { type: "STAFF", id: actorId },
        action: "briefing.unmuted",
        summary: `Let the Merchant Agent raise “${kind}” again.`,
        metadata: { kind },
      },
      tx,
    );
  });
}

/* -------------------------------------------------------------------------- */

export interface GeneratedBriefing {
  briefing: MerchantBriefing | null;
  /** Why there is no new one. Null when one was written. */
  failure: string | null;
}

/**
 * Generate this morning's briefing.
 *
 * Muted kinds are filtered out **before** the model sees them, so a merchant
 * who has said "not this again" is not paying for it to be considered. Nothing
 * to say writes a `quiet` briefing rather than nothing at all: "All quiet" is a
 * designed state, and it needs a timestamp to be believable.
 */
export async function generateBriefing(
  options: { locale: string; now?: Date },
  deps: AiDeps = {},
): Promise<GeneratedBriefing> {
  const now = options.now ?? new Date();
  const muted = await mutedKinds();
  const facts = (await briefingFacts(now)).filter((fact) => !muted.includes(fact.kind));

  if (facts.length === 0) {
    return { briefing: await writeBriefing([], true, now, null), failure: null };
  }

  const result = await draftBriefing(facts, { locale: options.locale, muted }, deps);

  if (!result.ok) {
    // Nothing is written, and the failure is *recorded*. Without this the home
    // page cannot tell "nothing to say" from "could not be reached", and shows
    // yesterday's briefing as though it were today's — checklist §1.
    await db.shop.update({
      where: { shop: shopScope.require("briefing failure") },
      data: { briefingFailedAt: now, briefingFailedReason: result.reason },
    });
    return { briefing: null, failure: result.reason };
  }

  return {
    briefing: await writeBriefing(
      result.value.items,
      result.value.items.length === 0,
      now,
      {
        model: result.model,
        promptVersion: result.promptVersion,
        requestId: result.requestId,
      },
    ),
    failure: null,
  };
}

/** The last failure, when it is more recent than the last briefing. */
export async function briefingFailure(
  latest: MerchantBriefing | null,
): Promise<string | null> {
  const shop = await db.shop.findUnique({
    where: { shop: shopScope.require("briefing failure") },
  });
  if (!shop?.briefingFailedAt) return null;
  if (latest && latest.generatedAt >= shop.briefingFailedAt) return null;
  return shop.briefingFailedReason;
}

async function writeBriefing(
  items: BriefingItem[],
  quiet: boolean,
  now: Date,
  ai: { model: string; promptVersion: string; requestId: string | null } | null,
): Promise<MerchantBriefing> {
  // A success clears the failure, so a card that recovered stops apologising.
  await db.shop.updateMany({
    where: { shop: shopScope.require("briefing") },
    data: { briefingFailedAt: null, briefingFailedReason: null },
  });

  return db.merchantBriefing.create({
    data: {
      ...tenant(),
      items,
      quiet,
      generatedAt: now,
      aiModel: ai?.model ?? null,
      aiPromptVersion: ai?.promptVersion ?? null,
      aiRequestId: ai?.requestId ?? null,
    },
  });
}

/* -------------------------------------------------------------------------- */

export interface BriefingLine {
  item: BriefingItem;
  /** The fact as it is **now**, not as it was when the briefing was written. */
  fact: AgentFact;
}

/**
 * A stored briefing against today's facts.
 *
 * An item whose fact is no longer true is dropped: the merchant dealt with it,
 * and a card still asking them to is worse than one item shorter. This is also
 * why nothing is stored with a number in it.
 */
export function linesFor(
  briefing: MerchantBriefing | null,
  facts: readonly AgentFact[],
): BriefingLine[] {
  if (!briefing) return [];

  const byKind = new Map(facts.map((fact) => [fact.kind, fact]));

  return readItems(briefing.items).flatMap((item) => {
    const fact = byKind.get(item.kind);
    return fact ? [{ item, fact }] : [];
  });
}
