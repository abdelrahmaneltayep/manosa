import { db } from "~/db.server";
import { LANGUAGE_NAMES, type Locale } from "~/i18n/config";
import { translateStrings } from "~/lib/ai/prompts/translate.server";
import type { AiDeps, AiFailure } from "~/lib/ai/run.server";
import { requireAi } from "~/lib/ai/permissions.server";
import { recordAudit, type AuditActor } from "~/lib/audit/record.server";
import {
  editableKeys,
  placeholdersIn,
  sameSet,
  shippedString,
} from "~/lib/i18n/strings.server";
import { voiceForPrompt } from "~/lib/settings/brand-voice.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/**
 * ✦ Suggest wording, in the merchant's own voice.
 *
 * The obvious reading of §8's *"fill missing with AI per language"* is a
 * button that translates the strings a language has no translation for. Both
 * catalogues this app ships are complete, so that button would have nothing
 * to do on any store, ever — an inert control, which is the defect this repo
 * has now caught three times (`taxExemptNeedsApproval`, the auto-approve
 * toggle, the API keys page).
 *
 * What a merchant actually lacks is not a translation but *their own voice*:
 * the app's wording is Mannon's, and a trade supplier with a house style has
 * five hundred strings that sound like somebody else. So this suggests wording
 * for the strings they have **not** already written, using the samples they
 * pasted into Agent controls — which is also what makes those samples earn
 * their place beyond the approval emails.
 *
 * Everything it writes is marked twice — `aiFilled` and `needsReview` — and
 * the table shows both. Invariant 3 in its plainest form: this drafts, and a
 * person accepts. It never touches a string a merchant has already written.
 */

/** One request's worth. Small enough to come back inside the timeout. */
export const FILL_BATCH = 25;

export interface FillResult {
  /** How many strings the merchant has not written themselves. */
  pending: number;
  filled: number;
  failure: AiFailure | null;
}

/**
 * Keys this shop has not written itself, in this language.
 *
 * Includes keys the catalogue has no translation for at all — those are worse,
 * because a buyer reads the English — and they are returned first.
 */
export async function unwrittenIn(locale: Locale): Promise<string[]> {
  shopScope.require("unwrittenIn");

  const rows = await db.storefrontString.findMany({
    where: { locale },
    select: { key: true },
  });
  const have = new Set(rows.map((row) => row.key));
  const left = editableKeys().filter((key) => !have.has(key));

  // Untranslated first: a buyer reading English on an Arabic storefront is a
  // bigger problem than one reading Mannon's Arabic rather than the shop's.
  return [
    ...left.filter((key) => !shippedString(key, locale)),
    ...left.filter((key) => shippedString(key, locale)),
  ];
}

export async function fillMissing(
  input: { locale: Locale; actor: AuditActor },
  deps: AiDeps = {},
): Promise<FillResult> {
  const shop = shopScope.require("fillMissing");
  // Enforcement, not a disabled button — and `draft` is exactly what this is.
  await requireAi("draft", { feature: "merchant_agent" });

  const pending = await unwrittenIn(input.locale);
  if (pending.length === 0) return { pending: 0, filled: 0, failure: null };

  const batch = pending.slice(0, FILL_BATCH).map((key) => ({
    key,
    // English is the source: it is the locale this app is written in, and a
    // translation of a translation is how meaning goes missing.
    english: shippedString(key, "en") ?? "",
  }));

  const written = await translateStrings(
    {
      language: LANGUAGE_NAMES[input.locale],
      strings: batch,
      // The merchant's own messages, from Agent controls. Without them this
      // writes plain, correct wording; with them it writes theirs.
      voiceSamples: await voiceForPrompt(),
    },
    deps,
  );
  if (!written.ok) {
    return { pending: pending.length, filled: 0, failure: written.reason };
  }

  const entries = Object.entries(written.value);
  await db.$transaction(
    entries.map(([key, value]) =>
      db.storefrontString.upsert({
        where: { shop_key_locale: { shop, key, locale: input.locale } },
        create: {
          ...tenant(),
          key,
          locale: input.locale,
          value,
          aiFilled: true,
          needsReview: true,
          updatedBy: null,
        },
        // Only ever fills a gap. A merchant's own wording is never overwritten
        // by a fill, and neither is an earlier fill they have already accepted.
        update: {},
      }),
    ),
  );

  await recordAudit({
    actor: input.actor,
    action: "storefront_string.filled",
    summary: `Suggested wording for ${entries.length} string${entries.length === 1 ? "" : "s"} in ${input.locale}. Each one is marked for review.`,
    subject: { type: "Shop", id: shop },
    metadata: { locale: input.locale, count: entries.length },
    // Which model wrote them, so 6.5's audit filter can find the one ✦ path
    // that changes what buyers read. Deliberately **not** `aiAssisted`: these
    // are drafts and reach nobody until a person accepts one, and that is the
    // entry that carries the approver (`acceptString`).
    ai: {
      model: written.model,
      promptVersion: written.promptVersion,
      requestId: written.requestId,
    },
  });

  return { pending: pending.length, filled: entries.length, failure: null };
}

/* -------------------------------------------------------------------------- */

/**
 * Every string this shop has changed, as a file.
 *
 * Only the overrides: exporting five hundred shipped strings and importing
 * them back would make a merchant the owner of every one of them, including
 * the ones this app will improve in the next release.
 */
export async function exportStrings(locale: Locale): Promise<string> {
  shopScope.require("exportStrings");

  const rows = await db.storefrontString.findMany({
    where: { locale },
    orderBy: { key: "asc" },
  });

  return `${JSON.stringify(
    {
      locale,
      strings: Object.fromEntries(rows.map((row) => [row.key, row.value])),
    },
    null,
    2,
  )}\n`;
}

/* -------------------------------------------------------------------------- */

/**
 * The same file, back again.
 *
 * A merchant with five hundred strings edits them in a spreadsheet or sends
 * them to a translator, not one textarea at a time — which is why §8 asks for
 * import beside export. What comes back is treated as untrusted: it has been
 * round a translator, a spreadsheet and an email client, and any of those can
 * have eaten a `{{days}}`.
 *
 * Nothing is applied silently. Every string the file asked for and this app
 * refused comes back named, with the reason, because a merchant who was told
 * "imported" and reads their own wording unchanged has been lied to.
 */
export class ImportInvalid extends Error {
  constructor(readonly code: "notJson" | "wrongShape" | "wrongLocale" | "tooMany") {
    super(`import rejected: ${code}`);
    this.name = "ImportInvalid";
  }
}

export interface ImportOutcome {
  applied: number;
  /** Unchanged because the file already said what the shop says. */
  unchanged: number;
  rejected: { key: string; reason: "unknownKey" | "placeholders" | "empty" }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function importStrings(input: {
  locale: Locale;
  content: string;
  actor: AuditActor;
}): Promise<ImportOutcome> {
  const shop = shopScope.require("importStrings");

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.content);
  } catch {
    throw new ImportInvalid("notJson");
  }

  if (!isRecord(parsed) || !isRecord(parsed.strings))
    throw new ImportInvalid("wrongShape");

  // A file exported in Arabic and imported as English would put Arabic on the
  // English storefront, one string at a time, with nothing to say it had
  // happened. The file names its own language for exactly this reason.
  if (typeof parsed.locale === "string" && parsed.locale !== input.locale) {
    throw new ImportInvalid("wrongLocale");
  }

  const asked = Object.entries(parsed.strings);
  if (asked.length > editableKeys().length) throw new ImportInvalid("tooMany");

  const editable = new Set(editableKeys());
  const existing = await db.storefrontString.findMany({
    where: { locale: input.locale },
  });
  const already = new Map(existing.map((row) => [row.key, row.value]));

  const rejected: ImportOutcome["rejected"] = [];
  const accepted: { key: string; value: string }[] = [];
  let unchanged = 0;

  for (const [key, value] of asked) {
    if (!editable.has(key)) {
      rejected.push({ key, reason: "unknownKey" });
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      // Clearing a string is a deliberate act on the page, not something a
      // blank cell in a spreadsheet should do to a buyer-facing sentence.
      rejected.push({ key, reason: "empty" });
      continue;
    }
    const wanted = value.trim();
    const shipped = shippedString(key, input.locale) ?? shippedString(key, "en") ?? "";
    if (!sameSet(placeholdersIn(wanted), placeholdersIn(shipped))) {
      rejected.push({ key, reason: "placeholders" });
      continue;
    }
    if (already.get(key) === wanted) {
      unchanged += 1;
      continue;
    }
    accepted.push({ key, value: wanted });
  }

  if (accepted.length > 0) {
    await db.$transaction(
      accepted.map((one) =>
        db.storefrontString.upsert({
          where: { shop_key_locale: { shop, key: one.key, locale: input.locale } },
          create: {
            ...tenant(),
            key: one.key,
            locale: input.locale,
            value: one.value,
            aiFilled: false,
            needsReview: false,
            updatedBy: input.actor.id ?? null,
          },
          // A person put this file together, so nothing in it needs reviewing —
          // and a string that was an ✦ suggestion stops being one.
          update: {
            value: one.value,
            aiFilled: false,
            needsReview: false,
            updatedBy: input.actor.id ?? null,
          },
        }),
      ),
    );
  }

  await recordAudit({
    actor: input.actor,
    action: "storefront_string.imported",
    summary: `Imported wording for ${accepted.length} string${accepted.length === 1 ? "" : "s"} in ${input.locale}${rejected.length > 0 ? `, refusing ${rejected.length}` : ""}.`,
    subject: { type: "Shop", id: shop },
    // Counts and keys, never the words — the same rule as a single save.
    metadata: {
      locale: input.locale,
      applied: accepted.length,
      unchanged,
      rejected: rejected.length,
    },
  });

  return { applied: accepted.length, unchanged, rejected };
}
