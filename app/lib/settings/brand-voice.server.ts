import { db } from "~/db.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/**
 * The merchant's own writing, kept so generated copy sounds like them.
 *
 * Checklist §8: *"paste 2-3 of your emails → Claude matches your tone in every
 * generated message and translation."*
 *
 * Shown back in full, always. A sample a merchant cannot re-read is one they
 * cannot decide to withdraw, and this is their own correspondence.
 */

/** The checklist's "2-3". More is not better: it is a longer prompt. */
export const SAMPLES_WANTED = 3;
export const MAX_SAMPLES = 5;
export const MAX_SAMPLE_CHARS = 4_000;

export type BrandVoiceIssue = "label" | "body" | "tooLong" | "tooMany";

export class BrandVoiceInvalid extends Error {
  constructor(readonly issue: BrandVoiceIssue) {
    super(`brand voice sample rejected: ${issue}`);
    this.name = "BrandVoiceInvalid";
  }
}

export async function listSamples() {
  shopScope.require("listSamples");
  return db.brandVoiceSample.findMany({ orderBy: { createdAt: "asc" } });
}

export async function addSample(
  input: { label: string; body: string },
  { actor }: { actor: AuditActor },
) {
  const shop = shopScope.require("addSample");

  const label = input.label.trim();
  const body = input.body.trim();
  if (label === "") throw new BrandVoiceInvalid("label");
  if (body === "") throw new BrandVoiceInvalid("body");
  if (body.length > MAX_SAMPLE_CHARS) throw new BrandVoiceInvalid("tooLong");

  const existing = await db.brandVoiceSample.count();
  if (existing >= MAX_SAMPLES) throw new BrandVoiceInvalid("tooMany");

  const sample = await db.brandVoiceSample.create({
    data: {
      ...tenant(),
      label: label.slice(0, 120),
      body,
      createdBy: actor.id ?? null,
    },
  });

  await recordAudit({
    actor,
    action: "settings.brand_voice_added",
    // The label, never the body: an audit summary is read in a list, and this
    // is the merchant's own correspondence.
    summary: `Added a writing sample: “${sample.label}”.`,
    subject: { type: "Shop", id: shop },
    metadata: { sampleId: sample.id, characters: body.length },
  });

  return sample;
}

/** Removed for good, on request. Their words, their call. */
export async function removeSample(id: string, { actor }: { actor: AuditActor }) {
  const shop = shopScope.require("removeSample");

  // Scoped by the extension, so another shop's id reads as not found rather
  // than as a leak — and deleting nothing is not an audit entry.
  const sample = await db.brandVoiceSample.findUnique({ where: { id } });
  if (!sample) return;

  await db.brandVoiceSample.delete({ where: { id } });

  await recordAudit({
    actor,
    action: "settings.brand_voice_removed",
    summary: `Removed the writing sample “${sample.label}”.`,
    subject: { type: "Shop", id: shop },
    metadata: { sampleId: id },
  });
}
